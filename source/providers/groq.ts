import { OpenAIProvider } from "./openai.js";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const DEFAULT_CONTEXT_WINDOW = 131072;

/**
 * Native Groq inference provider utilizing the high-speed LPU inference engine.
 * Communicates with Groq's OpenAI-compatible Chat Completions endpoint.
 */
export class GroqProvider extends OpenAIProvider {
  private readonly apiKey: string;
  private readonly contextWindows = new Map<string, number>([
    ["llama-3.3-70b-versatile", 131072],
    ["llama-3.1-8b-instant", 131072],
    ["llama3-70b-8192", 8192],
    ["llama3-8b-8192", 8192],
    ["mixtral-8x7b-32768", 32768],
    ["gemma2-9b-it", 8192],
    ["qwen-2.5-coder-32b", 131072],
    ["deepseek-r1-distill-llama-70b", 131072],
  ]);

  constructor(apiKey: string) {
    super(apiKey, "chat", {
      name: "groq",
      baseURL: GROQ_BASE_URL,
    });
    this.apiKey = apiKey;
  }

  protected override getMaxTokensParam(maxTokens?: number): Record<string, number> {
    return { max_tokens: maxTokens ?? 8192 };
  }

  async getContextWindow(model: string): Promise<number | undefined> {
    const known = this.contextWindows.get(model);
    if (known !== undefined) return known;

    try {
      const response = await fetch(`${GROQ_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return DEFAULT_CONTEXT_WINDOW;

      const body = (await response.json()) as {
        data?: Array<{ id: string; context_window?: number }>;
      };
      for (const item of body.data ?? []) {
        if (item.context_window) {
          this.contextWindows.set(item.id, item.context_window);
        }
      }
      return this.contextWindows.get(model) ?? DEFAULT_CONTEXT_WINDOW;
    } catch {
      return DEFAULT_CONTEXT_WINDOW;
    }
  }
}
