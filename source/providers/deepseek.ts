import { OpenAIProvider } from "./openai.js";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;

interface DeepSeekModel {
  id: string;
  context_length?: number;
}

/** DeepSeek exposes an OpenAI-compatible Chat Completions API. */
export class DeepSeekProvider extends OpenAIProvider {
  private readonly apiKey: string;
  private readonly contextWindows = new Map<string, { value: number | undefined; expiresAt: number }>();

  constructor(apiKey: string) {
    super(apiKey, "chat", {
      name: "deepseek",
      baseURL: DEEPSEEK_BASE_URL,
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
      const response = await fetch(`${DEEPSEEK_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return undefined;

      const body = await response.json() as { data?: DeepSeekModel[] };
      const expiresAt = Date.now() + CONTEXT_CACHE_TTL_MS;
      for (const item of body.data ?? []) {
        this.contextWindows.set(item.id, { value: item.context_length, expiresAt });
      }
      if (!this.contextWindows.has(model)) {
        // Retry absent models after the TTL in case DeepSeek's catalog changes.
        this.contextWindows.set(model, { value: undefined, expiresAt });
      }
      return this.contextWindows.get(model)?.value;
    } catch {
      return undefined;
    }
  }
}
