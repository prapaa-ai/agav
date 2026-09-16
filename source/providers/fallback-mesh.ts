import type { LLMProvider, StreamEvent, StreamParams } from "./types.js";
import { KeyPoolManager } from "./key-pool.js";
import {
  KeyPoolProvider,
  AllKeysCoolingError,
  isRateLimitError,
  extractRetryAfterMs,
} from "./key-pool-provider.js";
import type { AgavConfig } from "../config/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { NvidiaProvider } from "./nvidia.js";
import { DeepSeekProvider } from "./deepseek.js";
import { GeminiProvider } from "./gemini.js";
import { OllamaProvider } from "./ollama.js";
import { VertexAIProvider } from "./vertex-ai.js";

/** Default fast-model choices across all supported AI providers (verified online). */
export const FAST_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  openrouter: "~google/gemini-flash-latest",
  nvidia: "nvidia/nemotron-3.5-lightning-30b-a3b",
  deepseek: "deepseek-v4-flash",
  gemini: "gemini-flash-lite-latest",
  "vertex-ai": "vertex/gemini-3.5-flash-lite",
  groq: "qwen/qwen3.8-27b",
};

/** Default deep/reasoning model choices across all supported AI providers (verified online). */
export const DEEP_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  openrouter: "~anthropic/claude-sonnet-latest",
  nvidia: "nvidia/nemotron-3.5-lightning-30b-a3b",
  deepseek: "deepseek-v4-pro",
  gemini: "gemini-flash-latest",
  "vertex-ai": "vertex/gemini-3.5-pro",
  groq: "openai/gpt-oss-120b",
};

/** Standard fallback priority sequence. Prioritizes NVIDIA NIM, Groq LPU, Gemini, and OpenRouter. */
export const DEFAULT_FALLBACK_ORDER: readonly string[] = [
  "nvidia",
  "groq",
  "gemini",
  "openrouter",
  "deepseek",
  "openai",
  "anthropic",
  "ollama",
];

/**
 * Determines whether a provider error (rate limit, model 404 not found, auth 401,
 * unsupported tool calling, or gateway 502/503) can be recovered by cascading
 * to the next configured provider in the mesh.
 */
export function isRecoverableProviderError(err: unknown): boolean {
  if (!err) return false;
  if (isRateLimitError(err)) return true;

  if (typeof err === "object") {
    const status = (err as any).status ?? (err as any).statusCode;
    if (
      status === 404 ||
      status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 502 ||
      status === 503 ||
      status === 529
    ) {
      return true;
    }
    const code = (err as any).code;
    if (
      typeof code === "string" &&
      (code === "model_not_found" ||
        code === "invalid_api_key" ||
        code === "insufficient_quota" ||
        code === "404" ||
        code.includes("exhausted"))
    ) {
      return true;
    }
  }

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("does not exist") ||
      msg.includes("not exist or you do not have access") ||
      msg.includes("model_not_found") ||
      msg.includes("not found") ||
      msg.includes("no longer available") ||
      msg.includes("invalid api key") ||
      msg.includes("incorrect api key") ||
      msg.includes("tool calling is not supported") ||
      (msg.includes("tool") && msg.includes("not supported")) ||
      msg.includes("econnrefused") ||
      msg.includes("fetch failed") ||
      msg.includes("resource has been exhausted")
    ) {
      return true;
    }
  }

  return false;
}

export function isDeepModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.includes("pro") ||
    m.includes("opus") ||
    m.includes("sonnet") ||
    m.includes("405b") ||
    m.includes("70b") ||
    m.includes("r1") ||
    m.includes("deep") ||
    m.includes("reasoning")
  );
}

export function isFastModel(model: string): boolean {
  if (isDeepModel(model)) return false;
  const m = model.toLowerCase();
  return (
    m.includes("flash") ||
    m.includes("lite") ||
    /(?:^|[-_./])mini(?:[-_./]|$)/.test(m) ||
    m.includes("haiku") ||
    m.includes("8b") ||
    m.includes("instant") ||
    m.includes("lightning") ||
    m.includes("turbo")
  );
}

/**
 * Maps a model from a source provider to the equivalent tier model of a target fallback provider.
 */
export function mapModelForProvider(
  sourceModel: string,
  sourceProvider: string,
  targetProvider: string,
): string {
  if (sourceProvider.trim().toLowerCase() === targetProvider.trim().toLowerCase()) {
    return sourceModel;
  }
  const tgt = targetProvider.trim().toLowerCase();
  const fast = isFastModel(sourceModel);
  if (fast && FAST_MODELS[tgt]) {
    return FAST_MODELS[tgt]!;
  }
  if (DEEP_MODELS[tgt]) {
    return DEEP_MODELS[tgt]!;
  }
  return FAST_MODELS[tgt] ?? sourceModel;
}

/**
 * Helper to inspect keys for a given provider from AgavConfig.
 */
export function getProviderKeysFor(provider: string, config: AgavConfig): string[] {
  const p = provider.trim().toLowerCase();
  switch (p) {
    case "anthropic":
      return config.anthropicApiKeys?.length ? config.anthropicApiKeys : config.anthropicApiKey ? [config.anthropicApiKey] : [];
    case "openai":
      return config.openaiApiKeys?.length ? config.openaiApiKeys : config.openaiApiKey ? [config.openaiApiKey] : [];
    case "openrouter":
      return config.openrouterApiKeys?.length ? config.openrouterApiKeys : config.openrouterApiKey ? [config.openrouterApiKey] : [];
    case "nvidia":
      return config.nvidiaApiKeys?.length ? config.nvidiaApiKeys : config.nvidiaApiKey ? [config.nvidiaApiKey] : [];
    case "deepseek":
      return config.deepseekApiKeys?.length ? config.deepseekApiKeys : config.deepseekApiKey ? [config.deepseekApiKey] : [];
    case "gemini":
      return config.geminiApiKeys?.length ? config.geminiApiKeys : config.geminiApiKey ? [config.geminiApiKey] : [];
    case "groq":
      return config.groqApiKeys?.length ? config.groqApiKeys : config.groqApiKey ? [config.groqApiKey] : [];
    default:
      return [];
  }
}

/**
 * Checks if a provider has configured credentials or is local Ollama.
 */
export function isProviderConfigured(provider: string, config: AgavConfig): boolean {
  const p = provider.trim().toLowerCase();
  if (p === "ollama") {
    return (
      config.provider === "ollama" ||
      Boolean(config.ollamaEndpoint) ||
      Boolean(config.ollamaHost)
    );
  }
  const keyPool = KeyPoolManager.getInstance();
  if (keyPool.hasKeys(p)) return true;
  return getProviderKeysFor(p, config).length > 0;
}

/**
 * Computes the full fallback chain starting from the primary provider.
 */
export function getFallbackChain(
  primaryProvider: string,
  config: AgavConfig,
  customOrder?: string[],
): string[] {
  const normPrimary = primaryProvider.trim().toLowerCase();
  const baseOrder = customOrder ?? DEFAULT_FALLBACK_ORDER;
  const chain: string[] = [normPrimary];

  for (const p of baseOrder) {
    const norm = p.trim().toLowerCase();
    if (norm !== normPrimary && isProviderConfigured(norm, config)) {
      chain.push(norm);
    }
  }

  return chain;
}

/**
 * Factory creating single-key inner provider instances for any supported provider.
 */
export function createSingleProvider(
  provider: string,
  apiKey: string,
  config: AgavConfig,
): LLMProvider {
  const p = provider.trim().toLowerCase();
  switch (p) {
    case "anthropic":
      return new AnthropicProvider(apiKey);
    case "openai":
      return new OpenAIProvider(apiKey, config.openaiApi ?? "responses", {
        baseURL: config.openaiBaseURL,
        defaultHeaders: config.openaiHeaders,
      });
    case "openrouter":
      return new OpenRouterProvider(apiKey);
    case "nvidia":
      return new NvidiaProvider(apiKey);
    case "deepseek":
      return new DeepSeekProvider(apiKey);
    case "gemini":
      return new GeminiProvider(apiKey);
    case "groq":
      return new OpenAIProvider(apiKey, "chat", {
        name: "groq",
        baseURL: "https://api.groq.com/openai/v1",
      });
    case "vertex-ai":
      return new VertexAIProvider(config.vertexAICredentialsPath!, config.vertexAILocation);
    case "ollama": {
      const baseURL =
        config.ollamaEndpoint ??
        `http://${config.ollamaHost ?? "localhost"}:${config.ollamaPort ?? 11434}`;
      return new OllamaProvider(baseURL, config.ollamaApiKey);
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

export interface FallbackMeshOptions {
  customFactory?: (provider: string, apiKey?: string) => LLMProvider | null;
  customFallbackOrder?: string[];
  onFallback?: (fromProvider: string, toProvider: string, model: string, reason: string) => void;
}

export class FallbackMeshProvider extends KeyPoolProvider {
  readonly primaryProvider: string;
  private config: AgavConfig;
  private customFactory?: (provider: string, apiKey?: string) => LLMProvider | null;
  private customFallbackOrder?: string[];
  private onFallbackCallback?: (fromProvider: string, toProvider: string, model: string, reason: string) => void;
  private activeServingProvider: string;
  private meshProviderCache = new Map<string, LLMProvider>();

  constructor(
    config: AgavConfig,
    keyPool: KeyPoolManager = KeyPoolManager.getInstance(),
    options?: FallbackMeshOptions,
  ) {
    const primary = config.provider.trim().toLowerCase();
    const primaryFactory = (apiKey: string) => {
      if (options?.customFactory) {
        const custom = options.customFactory(primary, apiKey);
        if (custom) return custom;
      }
      return createSingleProvider(primary, apiKey, config);
    };

    super(primary, primaryFactory, keyPool, undefined, true);

    this.primaryProvider = primary;
    this.config = config;
    this.customFactory = options?.customFactory;
    this.customFallbackOrder = options?.customFallbackOrder;
    this.onFallbackCallback = options?.onFallback;
    this.activeServingProvider = primary;
  }

  getActiveServingProvider(): string {
    return this.activeServingProvider;
  }

  getProviderForMesh(providerName: string): LLMProvider | null {
    const p = providerName.trim().toLowerCase();
    if (p === this.primaryProvider) {
      return this;
    }
    let cached = this.meshProviderCache.get(p);
    if (!cached) {
      if (this.customFactory) {
        const custom = this.customFactory(p);
        if (custom) {
          this.meshProviderCache.set(p, custom);
          return custom;
        }
      }

      if (p === "ollama") {
        cached = createSingleProvider("ollama", "", this.config);
      } else {
        const keys = getProviderKeysFor(p, this.config);
        if (keys.length === 0 && !KeyPoolManager.getInstance().hasKeys(p)) {
          return null;
        }
        cached = new KeyPoolProvider(
          p,
          (key) => createSingleProvider(p, key, this.config),
          KeyPoolManager.getInstance(),
          undefined,
          true,
        );
      }
      this.meshProviderCache.set(p, cached);
    }
    return cached;
  }

  override withPinnedKeyIndex(index: number): FallbackMeshProvider {
    return new FallbackMeshProvider(this.config, KeyPoolManager.getInstance(), {
      customFactory: this.customFactory,
      customFallbackOrder: this.customFallbackOrder,
      onFallback: this.onFallbackCallback,
    });
  }

  override async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const keyPool = KeyPoolManager.getInstance();
    const chain = getFallbackChain(this.primaryProvider, this.config, this.customFallbackOrder);

    // If only 1 provider is in the chain (no other configured providers)
    if (chain.length <= 1) {
      yield* super.stream(params);
      return;
    }

    // Sort candidates to prioritize healthy providers
    let candidates = [...chain];
    const primaryHealthy = keyPool.hasHealthyKey(this.primaryProvider) || this.primaryProvider === "ollama";
    if (!primaryHealthy) {
      const healthyAlt = chain.find(
        (p) => p !== this.primaryProvider && (keyPool.hasHealthyKey(p) || p === "ollama"),
      );
      if (healthyAlt) {
        candidates = [healthyAlt, ...chain.filter((p) => p !== healthyAlt)];
      }
    }

    let lastError: unknown = null;
    let failedProvider: string | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      if (params.signal?.aborted) {
        throw new Error("Aborted");
      }

      // If this candidate is cooling down and we have more candidates to try, skip it!
      const isCooling = candidate !== "ollama" && !keyPool.hasHealthyKey(candidate);
      if (isCooling && i < candidates.length - 1) {
        continue;
      }

      const targetModel = mapModelForProvider(params.model, this.primaryProvider, candidate);
      const targetParams: StreamParams = {
        ...params,
        model: targetModel,
      };

      // If we are failing over from a previously exhausted provider, notify user
      if (failedProvider && failedProvider !== candidate) {
        yield {
          type: "text_delta",
          text: `⚡ [Auto-Fallback] All API keys for ${failedProvider} are cooling down. Switched to ${candidate} (${targetModel})...\n\n`,
        };
        this.onFallbackCallback?.(
          failedProvider,
          candidate,
          targetModel,
          "Rate limit / quota exhaustion",
        );
      }

      const providerInstance = candidate === this.primaryProvider ? this : this.getProviderForMesh(candidate);
      if (!providerInstance) continue;

      let hasEmittedContent = false;
      let bufferedEvents: StreamEvent[] = [];
      let rateLimited = false;
      let rateLimitErr: unknown = null;

      try {
        const streamIterable = candidate === this.primaryProvider
          ? super.stream(targetParams)
          : providerInstance.stream(targetParams);

        for await (const event of streamIterable) {
          if (event.type === "error" && isRecoverableProviderError(event.error)) {
            rateLimited = true;
            rateLimitErr = event.error;
            break;
          }

          if (event.type === "message_start" && bufferedEvents.length === 0) {
            bufferedEvents.push(event);
          } else {
            if (bufferedEvents.length > 0) {
              for (const b of bufferedEvents) yield b;
              bufferedEvents = [];
            }
            if (event.type === "text_delta" || event.type === "tool_call_start" || event.type === "thinking_delta") {
              hasEmittedContent = true;
            }
            yield event;
          }
        }

        if (!rateLimited) {
          if (bufferedEvents.length > 0) {
            for (const b of bufferedEvents) yield b;
            bufferedEvents = [];
          }
          this.activeServingProvider = candidate;
          return;
        }
      } catch (err) {
        if (err instanceof AllKeysCoolingError || isRecoverableProviderError(err)) {
          rateLimited = true;
          rateLimitErr = err;
        } else {
          throw err;
        }
      }

      if (rateLimited) {
        lastError = rateLimitErr;
        failedProvider = candidate;

        // If substantive content has already been emitted, we cannot safely restart mid-stream
        if (hasEmittedContent) {
          throw (rateLimitErr instanceof Error ? rateLimitErr : new Error(String(rateLimitErr)));
        }

        // Put candidate on cooldown in key pool (longer cooldown for 404/401 config errors)
        const isTransientQuota = isRateLimitError(rateLimitErr);
        const retryMs = isTransientQuota
          ? (extractRetryAfterMs(rateLimitErr) ?? 30000)
          : 300000; // 5 min cooldown for 404/401 model/key errors

        if (keyPool.hasKeys(candidate)) {
          for (const slot of keyPool.getKeys(candidate)) {
            if (slot.coolingUntil <= Date.now()) {
              keyPool.reportRateLimit(candidate, slot.key, retryMs);
            }
          }
        }

        // Continue candidate loop to try next healthy provider!
        continue;
      }
    }

    // All candidates in the chain are cooling down
    const errText = lastError instanceof Error ? lastError.message : String(lastError ?? "Quota exhausted across all providers");
    const soonestMs = Math.min(...chain.map((p) => keyPool.getSoonestCooldownMs(p) || 30000));
    const soonestSec = Math.ceil(soonestMs / 1000);

    yield {
      type: "error",
      error: new Error(
        `All configured AI providers (${chain.join(", ")}) are currently cooling down (${errText}). Soonest recovery in ${soonestSec}s.`,
      ),
    };
  }
}
