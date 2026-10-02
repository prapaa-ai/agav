import { tempOutputManager, type TemporaryOutput } from "../utils/temp-output.js";
import type { ToolDefinition, ToolResult } from "./types.js";

const MAX_OUTPUT = 40_000;
const PREVIEW_HALF = 19_000;
const SPILL_THRESHOLD = 38_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function utf8Prefix(buffer: Buffer, bytes: number): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buffer.subarray(0, bytes), { stream: true });
}

function utf8Tail(buffer: Buffer, bytes: number): string {
  let start = Math.max(0, buffer.length - bytes);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

class ResponseCapture {
  private total = 0;
  private small: Buffer[] = [];
  private first = Buffer.alloc(0);
  private last = Buffer.alloc(0);
  private log?: TemporaryOutput;
  private unavailable = false;
  private failure = "could not save";
  partial = false;

  private discardLog(error?: unknown): void {
    this.unavailable = true;
    if (error instanceof Error && error.message.includes("quota")) this.failure = "retention quota reached";
    this.log?.discard();
    this.log = undefined;
  }

  private spill(): void {
    try {
      if (!this.log && !this.unavailable) {
        this.log = tempOutputManager.create(MAX_RESPONSE_BYTES);
        for (const previous of this.small) this.log.write(previous);
      }
    } catch (error) {
      this.discardLog(error);
    }
    this.small = [];
  }

  capture(text: string): void {
    if (!text) return;
    let chunk = Buffer.from(text, "utf8");
    // Invalid UTF8 can expand on decoding. Bound decoded storage as well as
    // the incoming byte stream, without leaving a partial codepoint in the log.
    const remaining = MAX_RESPONSE_BYTES - this.total;
    if (chunk.length > remaining) {
      this.partial = true;
      chunk = Buffer.from(utf8Prefix(chunk, remaining));
    }
    if (!chunk.length) return;
    this.total += chunk.length;
    if (this.first.length < PREVIEW_HALF) {
      this.first = Buffer.concat([this.first, chunk.subarray(0, PREVIEW_HALF - this.first.length)]);
    }
    this.last = Buffer.from(chunk.length >= PREVIEW_HALF
      ? chunk.subarray(chunk.length - PREVIEW_HALF)
      : Buffer.concat([this.last, chunk]).subarray(-PREVIEW_HALF));
    if (this.total <= SPILL_THRESHOLD) {
      this.small.push(Buffer.from(chunk));
      return;
    }
    this.spill();
    try {
      this.log?.write(chunk);
    } catch {
      // Disk failures must not turn an HTTP success into a failed request.
      this.discardLog();
    }
  }

  finish(status: string, readError?: string): string {
    const warning = (this.partial
      ? "\nWarning: partial response capture (16 MiB limit reached); remaining response was cancelled."
      : "") + (readError ? `\nWarning: response read failed: ${utf8Prefix(Buffer.from(readError), 1_000)}; capture is partial.` : "");
    const prefix = `${utf8Prefix(Buffer.from(status), 1_000)}\n`;
    if (this.total <= SPILL_THRESHOLD) {
      const output = prefix + Buffer.concat(this.small).toString("utf8") + warning;
      if (Buffer.byteLength(output) <= MAX_OUTPUT) return output;
      this.spill();
    }
    let path: string | undefined;
    if (this.log) {
      try { path = this.log.publish(); }
      catch (error) { this.discardLog(error); }
    }
    const retrieval = path
      ? `\n${this.partial || readError ? "Partial" : "Full"} response saved to: ${path}\nUse read_file with path and line ranges, or grep_search with path and a pattern, to retrieve more.`
      : `\nWarning: full response log unavailable (${this.failure}); omitted content is unavailable; only the bounded preview is retained.`;
    const marker = `\n...(${this.total} captured bytes; middle omitted)...\n`;
    const suffix = warning + retrieval;
    const budget = Math.max(0, MAX_OUTPUT - Buffer.byteLength(prefix + marker + suffix));
    const half = Math.min(PREVIEW_HALF, Math.floor(budget / 2));
    return prefix + utf8Prefix(this.first, half) + marker + utf8Tail(this.last, half) + suffix;
  }
}

export const fetchUrlTool: ToolDefinition = {
  schema: {
    name: "fetch_url",
    description:
      "Fetch content from a URL. Supports custom headers for authenticated API access. " +
      "Returns the response body as text. For HTML pages, returns the raw HTML.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], description: "HTTP method (default: GET)" },
        headers: {
          type: "object",
          description: "Custom headers (e.g. Authorization, Content-Type)",
          additionalProperties: { type: "string" },
        },
        body: { type: "string", description: "Request body for POST/PUT/PATCH" },
      },
      required: ["url"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const url = String(input.url);
    const method = String(input.method ?? "GET");
    const headers = (input.headers ?? {}) as Record<string, string>;
    const body = input.body ? String(input.body) : undefined;
    try {
      const res = await fetch(url, {
        method,
        headers: { "User-Agent": "Agav-CLI/0.1", ...headers },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const capture = new ResponseCapture();
      let readError: string | undefined;
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let received = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = MAX_RESPONSE_BYTES - received;
            const accepted = value.subarray(0, remaining);
            received += accepted.length;
            capture.capture(decoder.decode(accepted, { stream: true }));
            if (value.length > remaining || capture.partial) {
              capture.partial = true;
              // Cancellation can itself reject on a broken connection. Retain
              // the quota warning and original HTTP status in either case.
              await reader.cancel().catch(() => {});
              break;
            }
          }
        } catch (error) {
          readError = error instanceof Error ? error.message : String(error);
          await reader.cancel().catch(() => {});
        } finally {
          capture.capture(decoder.decode());
          reader.releaseLock();
        }
      }
      return {
        output: capture.finish(`HTTP ${res.status} ${res.statusText}`, readError),
        isError: !res.ok || readError !== undefined,
      };
    } catch (error) {
      return {
        output: `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};
