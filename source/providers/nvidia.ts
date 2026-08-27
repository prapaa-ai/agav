import { OpenAIProvider } from "./openai.js";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;

interface NvidiaModel {
  id: string;
  context_length?: number;
  max_model_len?: number;
}

/** NVIDIA NIM exposes an OpenAI-compatible Chat Completions API. */
export class NvidiaProvider extends OpenAIProvider {
  private readonly apiKey: string;
  private readonly contextWindows = new Map<string, { value: number | undefined; expiresAt: number }>();

  constructor(apiKey: string) {
    super(apiKey, "chat", {
      name: "nvidia",
      baseURL: NVIDIA_BASE_URL,
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
      const response = await fetch(`${NVIDIA_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return undefined;

      const body = await response.json() as { data?: NvidiaModel[] };
      const expiresAt = Date.now() + CONTEXT_CACHE_TTL_MS;
      for (const item of body.data ?? []) {
        const contextLen = item.context_length ?? item.max_model_len;
        this.contextWindows.set(item.id, { value: contextLen, expiresAt });
      }
      if (!this.contextWindows.has(model)) {
        // Retry absent models after the TTL in case NVIDIA's catalog changes.
        this.contextWindows.set(model, { value: undefined, expiresAt });
      }
      return this.contextWindows.get(model)?.value;
    } catch {
      return undefined;
    }
  }
}
