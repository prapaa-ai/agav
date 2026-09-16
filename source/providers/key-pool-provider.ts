import type { LLMProvider, StreamEvent, StreamParams } from "./types.js";
import { KeyPoolManager } from "./key-pool.js";

export class AllKeysCoolingError extends Error {
  constructor(
    public readonly provider: string,
    public readonly originalError: unknown,
    public readonly waitMs: number,
  ) {
    const errorMsg = originalError instanceof Error ? originalError.message : String(originalError ?? "Rate limit reached");
    super(`All API keys for ${provider} are cooling down (${errorMsg}). Wait ${Math.ceil(waitMs / 1000)}s`);
    this.name = "AllKeysCoolingError";
  }
}

export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === "object") {
    const status = (err as any).status ?? (err as any).statusCode;
    if (status === 429) return true;
    const code = (err as any).code;
    if (
      typeof code === "string" &&
      (code.toLowerCase() === "rate_limit_exceeded" ||
        code === "429" ||
        code.toLowerCase().includes("resource_exhausted"))
    ) {
      return true;
    }
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    const name = err.name.toLowerCase();
    if (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("rate_limit") ||
      msg.includes("quota") ||
      msg.includes("too many requests") ||
      msg.includes("resource_exhausted") ||
      msg.includes("resource has been exhausted") ||
      msg.includes("insufficient_quota") ||
      msg.includes("tokens per minute") ||
      msg.includes("requests per minute") ||
      msg.includes("exceeded your current quota") ||
      name.includes("ratelimit")
    ) {
      return true;
    }
  }
  return false;
}

export function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;

  const headers = (err as any).headers ?? (err as any).response?.headers;
  if (headers) {
    let headerVal: string | undefined;
    if (typeof headers.get === "function") {
      headerVal = headers.get("retry-after") ?? headers.get("retry-after-ms");
    } else {
      headerVal = headers["retry-after"] ?? headers["retry-after-ms"];
    }
    if (headerVal) {
      const parsedSec = parseFloat(headerVal);
      if (!isNaN(parsedSec)) {
        return Math.round(parsedSec * 1000);
      }
      const parsedDate = Date.parse(headerVal);
      if (!isNaN(parsedDate)) {
        return Math.max(0, parsedDate - Date.now());
      }
    }
  }

  if (typeof (err as any).retryAfter === "number") {
    const val = (err as any).retryAfter;
    return val < 1000 ? val * 1000 : val;
  }

  return undefined;
}

export class KeyPoolProvider implements LLMProvider {
  readonly name: string;
  readonly getContextWindow?: LLMProvider["getContextWindow"];
  private providerCache = new Map<string, LLMProvider>();

  constructor(
    readonly providerName: string,
    private factory: (apiKey: string) => LLMProvider,
    private keyPool: KeyPoolManager = KeyPoolManager.getInstance(),
    readonly pinnedKeyIndex?: number,
    readonly throwOnAllKeysCooling = false,
  ) {
    this.name = providerName;

    // Probe sample provider to inspect capabilities like getContextWindow
    const registered = this.keyPool.getKeys(providerName);
    const probeKey = registered[0]?.key ?? "probe-key";
    const sample = this.getProvider(probeKey);
    if (typeof sample.getContextWindow === "function") {
      this.getContextWindow = async (model: string) => {
        const slots = this.keyPool.getKeys(this.providerName);
        const activeKey = slots[0]?.key ?? probeKey;
        const provider = this.getProvider(activeKey);
        return provider.getContextWindow ? provider.getContextWindow(model) : undefined;
      };
    }
  }

  withPinnedKeyIndex(index: number): KeyPoolProvider {
    return new KeyPoolProvider(
      this.providerName,
      this.factory,
      this.keyPool,
      index,
      this.throwOnAllKeysCooling,
    );
  }

  private getProvider(apiKey: string): LLMProvider {
    let provider = this.providerCache.get(apiKey);
    if (!provider) {
      provider = this.factory(apiKey);
      this.providerCache.set(apiKey, provider);
    }
    return provider;
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    if (this.throwOnAllKeysCooling && !this.keyPool.hasHealthyKey(this.providerName)) {
      const waitMs = this.keyPool.getSoonestCooldownMs(this.providerName) || 30000;
      throw new AllKeysCoolingError(
        this.providerName,
        new Error("All registered keys are currently cooling down"),
        waitMs,
      );
    }

    const maxCoolingCycles = 3;
    let coolingCycle = 0;

    while (true) {
      if (params.signal?.aborted) {
        throw new Error("Aborted");
      }

      const { key: currentKey } = this.pinnedKeyIndex !== undefined
        ? this.keyPool.acquireKeyByIndex(this.providerName, this.pinnedKeyIndex)
        : this.keyPool.acquireKey(this.providerName);
      const inner = this.getProvider(currentKey);

      let rateLimited = false;
      let rateLimitError: unknown = null;
      let retryAfterMs: number | undefined;
      let bufferedEvents: StreamEvent[] = [];
      let hasEmittedContent = false;

      try {
        for await (const event of inner.stream(params)) {
          if (event.type === "error" && isRateLimitError(event.error)) {
            rateLimited = true;
            rateLimitError = event.error;
            retryAfterMs = extractRetryAfterMs(event.error);
            break;
          }

          // Buffer initial message_start so zero content is emitted before any immediate 429
          if (event.type === "message_start" && bufferedEvents.length === 0) {
            bufferedEvents.push(event);
          } else {
            if (bufferedEvents.length > 0) {
              for (const buf of bufferedEvents) {
                yield buf;
              }
              bufferedEvents = [];
            }
            if (event.type === "text_delta" || event.type === "tool_call_start" || event.type === "thinking_delta") {
              hasEmittedContent = true;
            }
            yield event;
          }
        }

        if (rateLimited) {
          // Handled below
        } else {
          if (bufferedEvents.length > 0) {
            for (const buf of bufferedEvents) {
              yield buf;
            }
            bufferedEvents = [];
          }
          this.keyPool.reportSuccess(this.providerName, currentKey);
          return;
        }
      } catch (err) {
        if (isRateLimitError(err)) {
          rateLimited = true;
          rateLimitError = err;
          retryAfterMs = extractRetryAfterMs(err);
        } else {
          this.keyPool.reportError(this.providerName, currentKey, err);
          throw err;
        }
      }

      if (rateLimited) {
        this.keyPool.reportRateLimit(this.providerName, currentKey, retryAfterMs);

        // If content has already been emitted to the caller, do NOT restart the stream to prevent duplicate text
        if (hasEmittedContent) {
          throw (rateLimitError ?? new Error("Rate limit encountered mid-stream after emitting content"));
        }

        // If alternative healthy keys exist in the pool, IMMEDIATELY switch to the next key and retry with zero sleep delay!
        if (this.keyPool.hasHealthyKey(this.providerName)) {
          continue;
        }

        // Only if all keys in the pool are cooling down does it yield the backoff retry event.
        const allSlots = this.keyPool.getKeys(this.providerName);
        const now = Date.now();
        const soonestCooling = allSlots.length > 0
          ? Math.min(...allSlots.map((s) => s.coolingUntil))
          : now + (retryAfterMs ?? 30000);
        const waitMs = Math.max(50, soonestCooling - now);

        if (this.throwOnAllKeysCooling) {
          throw new AllKeysCoolingError(this.providerName, rateLimitError, waitMs);
        }

        const errorMsg = rateLimitError instanceof Error ? rateLimitError.message : String(rateLimitError);
        yield {
          type: "error",
          error: new Error(
            `All API keys for ${this.providerName} are cooling down (${errorMsg}). Retrying in ${Math.ceil(waitMs / 1000)}s...`,
          ),
        };

        coolingCycle++;
        if (coolingCycle > maxCoolingCycles) {
          throw rateLimitError instanceof Error ? rateLimitError : new Error(errorMsg);
        }

        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
    }
  }
}
