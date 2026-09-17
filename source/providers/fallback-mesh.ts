import type { LLMProvider, StreamEvent, StreamParams } from "./types.js";

export type ModelTier = "fast" | "deep";

export const FAST_MODELS: Record<string, string> = {
  anthropic: "claude-3-5-haiku-20241022",
  openai: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini",
  nvidia: "meta/llama-3.1-8b-instruct",
  deepseek: "deepseek-chat",
  gemini: "gemini-2.5-flash",
  "vertex-ai": "vertex/gemini-2.5-flash",
  groq: "llama-3.3-70b-versatile",
  ollama: "llama3.2:3b",
};

export const DEEP_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  openrouter: "anthropic/claude-3.7-sonnet",
  nvidia: "nvidia/llama-3.1-nemotron-70b-instruct",
  deepseek: "deepseek-reasoner",
  gemini: "gemini-2.5-pro",
  "vertex-ai": "vertex/gemini-2.5-pro",
  groq: "deepseek-r1-distill-llama-70b",
  ollama: "llama3.3:70b",
};

export const DEFAULT_FALLBACK_ORDER: readonly string[] = [
  "anthropic",
  "openai",
  "openrouter",
  "gemini",
  "deepseek",
  "nvidia",
  "vertex-ai",
  "groq",
  "ollama",
];

/**
 * Detects whether a model is in the 'fast' or 'deep' tier based on naming patterns.
 */
export function detectModelTier(model: string): ModelTier {
  const m = model.toLowerCase();
  // Check fast indicators using word boundaries to avoid false positives (e.g. 'gemini' containing 'mini')
  if (
    /\b(haiku|mini|flash|lite|small|fast|turbo|8b|7b|3b|1b)\b/i.test(m) ||
    m.includes("-mini") ||
    m.includes("-flash") ||
    m.includes("-haiku") ||
    m.includes("-lite")
  ) {
    return "fast";
  }
  return "deep";
}

/**
 * Maps a model identifier from a source provider to an equivalent model on the target provider.
 */
export function getFallbackModel(targetProvider: string, originalModel: string): string {
  const tier = detectModelTier(originalModel);
  if (tier === "fast" && FAST_MODELS[targetProvider]) {
    return FAST_MODELS[targetProvider];
  }
  if (DEEP_MODELS[targetProvider]) {
    return DEEP_MODELS[targetProvider];
  }
  return originalModel;
}

/**
 * Classifies whether an error from a provider is recoverable by switching providers or retrying.
 */
export function isRecoverableProviderError(err: unknown, hasAlternativeProvider = true): boolean {
  if (!err || typeof err !== "object") return false;

  const errorObj = err as any;

  // Cancellation or abort signal is intentional, never recoverable
  if (errorObj.name === "AbortError" || errorObj.code === "ABORT_ERR") {
    return false;
  }

  // AllKeysCoolingError is recoverable if another provider exists in the mesh
  if (errorObj.name === "AllKeysCoolingError") {
    return hasAlternativeProvider;
  }

  const status = errorObj.status ?? errorObj.statusCode;
  const msg = (errorObj.message ?? "").toLowerCase();

  // 429: Rate limit / quota exceeded
  if (
    status === 429 ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("ratelimit") ||
    msg.includes("quota exceeded") ||
    msg.includes("resource_exhausted")
  ) {
    return true;
  }

  // 5xx: Outage / server error
  if (
    typeof status === "number" &&
    (status === 500 || status === 502 || status === 503 || status === 504 || status === 529)
  ) {
    return true;
  }
  if (
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("bad gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("overloaded")
  ) {
    return true;
  }

  // Network timeouts / connectivity
  if (
    msg.includes("timeout") ||
    msg.includes("timedout") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("network")
  ) {
    return true;
  }

  // 404: Model or endpoint not found on this provider - recoverable if another provider exists
  if (status === 404 || msg.includes("404") || msg.includes("not found")) {
    return hasAlternativeProvider;
  }

  // 400: Bad request - recoverable across different providers (e.g. parameter or prompt incompatibilities)
  if (status === 400 || msg.includes("400") || msg.includes("bad request")) {
    return hasAlternativeProvider;
  }

  // Auth failures: 401, 403, invalid api key - recoverable ONLY if an alternative provider exists
  if (
    status === 401 ||
    status === 403 ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid_api_key") ||
    msg.includes("authentication")
  ) {
    return hasAlternativeProvider;
  }

  return false;
}

export interface FallbackMeshConfig {
  primaryProvider: string;
  providers: Map<string, LLMProvider> | Record<string, LLMProvider>;
  fallbackOrder?: readonly string[];
  maxFallbacks?: number;
  onFallback?: (fromProvider: string, toProvider: string, error: Error) => void;
}

export class FallbackMeshProvider implements LLMProvider {
  readonly name: string;
  private primaryProviderName: string;
  private providers: Map<string, LLMProvider>;
  private fallbackOrder: readonly string[];
  private maxFallbacks: number;
  private onFallback?: (fromProvider: string, toProvider: string, error: Error) => void;

  constructor(config: FallbackMeshConfig) {
    this.primaryProviderName = config.primaryProvider;
    this.name = config.primaryProvider;
    this.providers =
      config.providers instanceof Map
        ? config.providers
        : new Map(Object.entries(config.providers));
    this.fallbackOrder = config.fallbackOrder ?? DEFAULT_FALLBACK_ORDER;
    this.maxFallbacks = config.maxFallbacks ?? 3;
    this.onFallback = config.onFallback;
  }

  getPrimaryProvider(): LLMProvider | undefined {
    return this.providers.get(this.primaryProviderName);
  }

  async getContextWindow(model: string): Promise<number | undefined> {
    const primary = this.getPrimaryProvider();
    if (primary?.getContextWindow) {
      return primary.getContextWindow(model);
    }
    return undefined;
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const sequence: string[] = [this.primaryProviderName];

    for (const p of this.fallbackOrder) {
      if (p !== this.primaryProviderName && this.providers.has(p)) {
        sequence.push(p);
      }
    }

    for (const p of this.providers.keys()) {
      if (!sequence.includes(p)) {
        sequence.push(p);
      }
    }

    const triedProviders = new Set<string>();
    let fallbacksCount = 0;
    let lastError: Error | null = null;

    for (const providerName of sequence) {
      if (triedProviders.has(providerName)) continue;

      triedProviders.add(providerName);
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      const model =
        providerName === this.primaryProviderName
          ? params.model
          : getFallbackModel(providerName, params.model);

      const adjustedParams: StreamParams = {
        ...params,
        model,
      };

      let hasYielded = false;

      try {
        for await (const event of provider.stream(adjustedParams)) {
          hasYielded = true;
          yield event;
        }
        // Success! Preserve successful responses without unnecessary fallback.
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (params.signal?.aborted) {
          throw lastError;
        }

        // If content was already yielded to caller, do not duplicate mid-stream
        if (hasYielded) {
          throw lastError;
        }

        const remainingProviders = sequence.filter(
          (p) => !triedProviders.has(p) && this.providers.has(p),
        );
        const canFallback =
          remainingProviders.length > 0 && fallbacksCount < this.maxFallbacks;
        const recoverable = isRecoverableProviderError(err, canFallback);

        if (!recoverable || !canFallback) {
          throw lastError;
        }

        fallbacksCount++;
        const nextProviderName = remainingProviders[0];

        if (this.onFallback) {
          this.onFallback(providerName, nextProviderName, lastError);
        }

        yield {
          type: "error" as const,
          error: new Error(
            `Provider "${providerName}" failed (${lastError.message}). Falling back to "${nextProviderName}"...`,
          ),
        };

        continue;
      }
    }

    throw lastError ?? new Error(`All providers in fallback mesh failed`);
  }
}
