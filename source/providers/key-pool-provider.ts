import type { LLMProvider, StreamEvent, StreamParams } from "./types.js";
import { KeyPoolManager } from "./key-pool.js";

export class AllKeysCoolingError extends Error {
  readonly provider: string;
  readonly minCoolingMs: number;

  constructor(provider: string, minCoolingMs = 0) {
    super(
      `All keys for provider "${provider}" are currently cooling down (retry in ~${Math.ceil(minCoolingMs / 1000)}s)`,
    );
    this.name = "AllKeysCoolingError";
    this.provider = provider;
    this.minCoolingMs = minCoolingMs;
  }
}

/**
 * Checks if an error represents a rate limit / quota exhaustion.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const errorObj = err as any;
  const status = errorObj.status ?? errorObj.statusCode;
  if (status === 429) return true;

  const code = errorObj.code;
  if (code === "rate_limit_exceeded" || code === 429) return true;

  if (err instanceof Error || typeof errorObj.message === "string") {
    const msg = (errorObj.message ?? "").toLowerCase();
    if (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("ratelimit") ||
      msg.includes("quota exceeded") ||
      msg.includes("insufficient_quota") ||
      msg.includes("resource_exhausted") ||
      msg.includes("resource has been exhausted") ||
      msg.includes("too many requests") ||
      msg.includes("tpm") ||
      msg.includes("rpm") ||
      msg.includes("tokens per minute") ||
      msg.includes("requests per minute")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts retry-after delay in milliseconds from headers or error message.
 */
export function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;

  const errorObj = err as any;

  // 1. Check HTTP headers
  const headers = errorObj.headers ?? errorObj.response?.headers;
  let headerVal: string | null | undefined;

  if (headers) {
    if (typeof headers.get === "function") {
      headerVal = headers.get("retry-after") ?? headers.get("Retry-After");
    } else if (typeof headers === "object") {
      headerVal = headers["retry-after"] ?? headers["Retry-After"];
    }
  }

  if (headerVal) {
    const seconds = parseFloat(headerVal);
    if (!isNaN(seconds)) {
      return Math.max(1000, Math.round(seconds * 1000));
    }
    const dateMs = Date.parse(headerVal);
    if (!isNaN(dateMs) && dateMs > Date.now()) {
      return dateMs - Date.now();
    }
  }

  // 2. Check error message regex
  const message = errorObj.message;
  if (typeof message === "string") {
    const match = message.match(
      /(?:retry after|try again in|reset in|wait)\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds|ms|m|min|minutes)?/i,
    );
    if (match) {
      const val = parseFloat(match[1]);
      const unit = (match[2] ?? "s").toLowerCase();
      if (unit.startsWith("ms")) {
        return Math.round(val);
      } else if (unit.startsWith("m")) {
        return Math.round(val * 60 * 1000);
      } else {
        return Math.round(val * 1000);
      }
    }
  }

  return undefined;
}

/**
 * Detects authentication or authorization errors that indicate a specific key is invalid.
 */
export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const errorObj = err as any;
  const status = errorObj.status ?? errorObj.statusCode;
  if (status === 401 || status === 403) return true;

  const msg = (errorObj.message ?? "").toLowerCase();
  return (
    msg.includes("invalid api key") ||
    msg.includes("invalid_api_key") ||
    msg.includes("incorrect api key") ||
    msg.includes("unauthorized") ||
    msg.includes("authentication") ||
    msg.includes("forbidden") ||
    msg.includes("permission denied")
  );
}

/**
 * Detects 5xx server or network errors.
 */
export function isServerErrorOrNetwork(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const errorObj = err as any;
  const status = errorObj.status ?? errorObj.statusCode;
  if (
    typeof status === "number" &&
    (status === 500 || status === 502 || status === 503 || status === 504 || status === 529)
  ) {
    return true;
  }

  const msg = (errorObj.message ?? "").toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("overloaded")
  );
}

export interface KeyPoolProviderOptions {
  keyPool?: KeyPoolManager;
  maxRetries?: number;
}

export class KeyPoolProvider implements LLMProvider {
  readonly name: string;
  private factory: (key: string) => LLMProvider;
  private keyPool: KeyPoolManager;
  private maxRetries: number;
  private instances = new Map<string, LLMProvider>();

  constructor(
    providerName: string,
    factory: (key: string) => LLMProvider,
    options?: KeyPoolProviderOptions,
  ) {
    this.name = providerName;
    this.factory = factory;
    this.keyPool = options?.keyPool ?? KeyPoolManager.getInstance();
    this.maxRetries = options?.maxRetries ?? 3;
  }

  private getOrCreateProvider(key: string): LLMProvider {
    let instance = this.instances.get(key);
    if (!instance) {
      instance = this.factory(key);
      this.instances.set(key, instance);
    }
    return instance;
  }

  async getContextWindow(model: string): Promise<number | undefined> {
    const keyInfo = this.keyPool.getNextKey(this.name);
    if (keyInfo) {
      try {
        const p = this.getOrCreateProvider(keyInfo.key);
        if (p.getContextWindow) {
          return await p.getContextWindow(model);
        }
      } finally {
        this.keyPool.releaseKey(this.name, keyInfo.key);
      }
    }
    return undefined;
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const statusMap = this.keyPool.getPoolStatus(this.name);
    const initialStatus = statusMap[this.name];
    const poolSize = initialStatus?.totalKeys ?? 1;
    const maxAttempts = Math.max(poolSize, this.maxRetries);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const keyInfo = this.keyPool.getNextKey(this.name);

      if (!keyInfo) {
        const currentStatus = this.keyPool.getPoolStatus(this.name)[this.name];
        if (
          currentStatus &&
          currentStatus.coolingKeys > 0 &&
          currentStatus.coolingKeys >= currentStatus.enabledKeys
        ) {
          const minCoolingMs = Math.max(
            0,
            Math.min(
              ...currentStatus.keys
                .filter((k) => k.isCooling)
                .map((k) => k.coolingUntil - Date.now()),
            ),
          );
          throw new AllKeysCoolingError(this.name, minCoolingMs);
        }
        if (!currentStatus || currentStatus.totalKeys === 0 || currentStatus.enabledKeys === 0) {
          throw new Error(`No available keys for provider "${this.name}"`);
        }
        throw new AllKeysCoolingError(this.name);
      }

      const { key } = keyInfo;
      let hasYielded = false;

      try {
        const provider = this.getOrCreateProvider(key);
        for await (const event of provider.stream(params)) {
          hasYielded = true;
          yield event;
        }
        this.keyPool.reportSuccess(this.name, key);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (params.signal?.aborted) {
          this.keyPool.releaseKey(this.name, key);
          throw lastError;
        }

        const isRateLimit = isRateLimitError(err);
        const isAuth = isAuthError(err);
        const isTransient = isServerErrorOrNetwork(err);

        const retryAfter = extractRetryAfterMs(err);
        this.keyPool.reportFailure(this.name, key, err, retryAfter);

        // If content was already yielded to caller, do not duplicate mid-stream
        if (hasYielded) {
          throw lastError;
        }

        // If non-retryable across keys (e.g. 400 Bad Request)
        if (!isRateLimit && !isAuth && !isTransient) {
          throw lastError;
        }

        // If retryable (rate limit, auth failure on this key, or server error), proceed to next key
        continue;
      }
    }

    throw lastError ?? new Error(`All key rotation attempts exhausted for provider "${this.name}"`);
  }
}
