import { OpenAIProvider } from "./openai.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;

interface OpenRouterModel {
  id: string;
  context_length?: number;
}

/** OpenRouter exposes an OpenAI-compatible Chat Completions API. */
export class OpenRouterProvider extends OpenAIProvider {
  private readonly apiKey: string;
  private readonly contextWindows = new Map<string, { value: number | undefined; expiresAt: number }>();

  constructor(apiKey: string) {
    super(apiKey, "chat", {
      name: "openrouter",
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/prapaa-ai/agav",
        "X-OpenRouter-Title": "Agav",
      },
    });
    this.apiKey = apiKey;
  }

  protected override getMaxTokensParam(maxTokens?: number): Record<string, number> {
    return { max_tokens: maxTokens ?? 16384 };
  }

  async getContextWindow(model: string): Promise<number | undefined> {
    const cached = this.contextWindows.get(model);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    this.contextWindows.delete(model);

    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return undefined;

      const body = await response.json() as { data?: OpenRouterModel[] };
      const expiresAt = Date.now() + CONTEXT_CACHE_TTL_MS;
      for (const item of body.data ?? []) {
        this.contextWindows.set(item.id, { value: item.context_length, expiresAt });
      }
      if (!this.contextWindows.has(model)) {
        // Retry absent models after the TTL in case OpenRouter's catalog changes.
        // A cache entry here — as opposed to no entry at all — is what lets
        // isContextWindowConfirmedMissing tell "the catalog was fetched and
        // genuinely does not list this model" (e.g. a stealth model) apart from
        // a transient fetch failure below, which leaves no entry behind.
        this.contextWindows.set(model, { value: undefined, expiresAt });
      }
      return this.contextWindows.get(model)?.value;
    } catch {
      return undefined;
    }
  }

  /**
   * True once a successful catalog fetch has confirmed `model` is absent —
   * OpenRouter deliberately excludes stealth models from `/models`, so this is
   * the only way to tell "genuinely unlisted" apart from "fetch failed" and
   * decide whether asking the user for a manual context window is worthwhile.
   */
  isContextWindowConfirmedMissing(model: string): boolean {
    const cached = this.contextWindows.get(model);
    return cached !== undefined && cached.expiresAt > Date.now() && cached.value === undefined;
  }
}
