import { OpenAIProvider } from "./openai.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

interface OpenRouterModel {
  id: string;
  context_length?: number;
}

/** OpenRouter exposes an OpenAI-compatible Chat Completions API. */
export class OpenRouterProvider extends OpenAIProvider {
  private readonly apiKey: string;
  private readonly contextWindows = new Map<string, number | undefined>();

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

  async getContextWindow(model: string): Promise<number | undefined> {
    if (this.contextWindows.has(model)) return this.contextWindows.get(model);

    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return undefined;

      const body = await response.json() as { data?: OpenRouterModel[] };
      for (const item of body.data ?? []) {
        this.contextWindows.set(item.id, item.context_length);
      }
      if (!this.contextWindows.has(model)) this.contextWindows.set(model, undefined);
      return this.contextWindows.get(model);
    } catch {
      return undefined;
    }
  }
}
