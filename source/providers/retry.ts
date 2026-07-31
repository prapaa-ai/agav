import type { LLMProvider, StreamParams, StreamEvent } from "./types.js";

const DEFAULT_MAX_RETRIES = 5;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

// Respect provider hints when possible, then fall back to a small exponential backoff.
function getRetryDelay(attempt: number, err: unknown): number {
  // Check for Retry-After header in API errors
  if (err && typeof err === "object" && "headers" in err) {
    const headers = (err as any).headers;
    const retryAfter = headers?.["retry-after"];
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) return seconds * 1000;
    }
  }
  // Use bounded exponential backoff so transient outages cool down without hanging forever.
  return Math.min(1000 * Math.pow(2, attempt), 8000);
}

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  // Check for status code on API errors
  if ("status" in err) {
    const status = (err as any).status;
    if (typeof status === "number" && RETRYABLE_STATUS.has(status)) return true;
  }

  // Network errors
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("etimedout") ||
      msg.includes("fetch failed") ||
      msg.includes("network")
    ) {
      return true;
    }
  }

  return false;
}

// Wrap a provider with retry-on-transient-failure behavior without changing its outward interface.
export class RetryProvider implements LLMProvider {
  readonly name: string;
  private inner: LLMProvider;
  private maxRetries: number;

  constructor(inner: LLMProvider, maxRetries = DEFAULT_MAX_RETRIES) {
    this.inner = inner;
    this.name = inner.name;
    this.maxRetries = maxRetries;
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        yield* this.inner.stream(params);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < this.maxRetries && isRetryable(err)) {
          const delay = getRetryDelay(attempt, err);
          yield {
            type: "error" as const,
            error: new Error(
              `Request failed (${lastError.message}). Retrying in ${Math.ceil(delay / 1000)}s... (attempt ${attempt + 1}/${this.maxRetries})`,
            ),
          };
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new Error("Maximum retries exceeded");
  }
}
