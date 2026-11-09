import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { assertSafeUrl, pinnedLookup, UnsafeUrlError } from "../utils/safe-url.js";
import { tempOutputManager, type TemporaryOutput } from "../utils/temp-output.js";
import type { ToolDefinition, ToolResult } from "./types.js";

const MAX_OUTPUT = 40_000;
const PREVIEW_HALF = 19_000;
const SPILL_THRESHOLD = 38_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/** Methods that only read; everything else mutates and must be confirmed. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Headers that must never follow a redirect to a different origin. */
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

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

/** The minimal response surface the capture loop consumes. */
export interface TransportResponse {
  status: number;
  statusText: string;
  /** Async byte stream of the response body, or undefined for an empty body. */
  body?: AsyncIterable<Uint8Array>;
  /** Cancel an in-progress body read (quota reached / streamed error). */
  cancel(): void | Promise<void>;
}

export interface TransportRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

/**
 * Pluggable transport. The default implementation resolves + validates DNS,
 * pins the socket to the checked IP, and re-validates every redirect. Tests
 * inject a fake transport to exercise the capture path without real network
 * access (the SSRF guard itself is tested directly against `assertSafeUrl`).
 */
export type Transport = (url: string, request: TransportRequest) => Promise<TransportResponse>;

let activeTransport: Transport | undefined;

/** Test-only hook to replace the network transport. Pass undefined to restore. */
export function setFetchTransport(transport: Transport | undefined): void {
  activeTransport = transport;
}

/** Convert a Node IncomingMessage into the small transport response contract. */
function fromIncoming(message: IncomingMessage): TransportResponse {
  return {
    status: message.statusCode ?? 0,
    statusText: message.statusMessage ?? "",
    body: message,
    cancel: () => { message.destroy(); },
  };
}

/** Headers minus credential headers, used when a redirect crosses origins. */
export function stripCredentials(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())),
  );
}

export function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

/**
 * Default transport: validated, IP-pinned request with manual redirect
 * re-validation and cross-origin credential stripping. Never follows a redirect
 * to a private/reserved/metadata target, because every hop runs back through
 * `assertSafeUrl` and the connection is pinned to the checked address.
 */
async function nodeTransport(initialUrl: string, request: TransportRequest): Promise<TransportResponse> {
  let currentUrl = initialUrl;
  let headers = request.headers;
  let method = request.method;
  let body = request.body;

  for (let hop = 0; ; hop++) {
    const target = await assertSafeUrl(currentUrl);
    const response = await sendOnce(target.url, target, { method, headers, body, signal: request.signal });

    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    const redirect = status >= 300 && status < 400 && typeof location === "string" && location.length > 0;
    if (!redirect) return fromIncoming(response);

    response.destroy(); // Drain the redirect body; we only need the Location.
    if (hop >= MAX_REDIRECTS) {
      throw new UnsafeUrlError(`Too many redirects (> ${MAX_REDIRECTS}) starting from ${initialUrl}.`);
    }

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, target.url);
    } catch {
      throw new UnsafeUrlError(`Redirect to invalid URL "${location}".`);
    }
    // Strip credentials when the redirect leaves the original origin so an
    // open redirect cannot forward Authorization/Cookie to a third party.
    if (!sameOrigin(nextUrl, target.url)) headers = stripCredentials(headers);
    // 303, and 301/302 by convention, downgrade the method to GET and drop the body.
    if (status === 303 || ((status === 301 || status === 302) && method !== "HEAD")) {
      method = "GET";
      body = undefined;
    }
    currentUrl = nextUrl.toString();
  }
}

interface IncomingRequest { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }

/** Issue a single pinned request (no redirect handling) and resolve the raw IncomingMessage. */
function sendOnce(url: URL, target: Awaited<ReturnType<typeof assertSafeUrl>>, request: IncomingRequest): Promise<IncomingMessage> {
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = requestFn(url, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      // Pin DNS to the already-validated address: the socket connects to the
      // exact IP we checked, closing the rebinding window.
      lookup: pinnedLookup(target),
    }, resolve);
    req.on("error", reject);
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
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
    const method = String(input.method ?? "GET").toUpperCase();
    const headers = (input.headers ?? {}) as Record<string, string>;
    const body = input.body ? String(input.body) : undefined;
    const transport = activeTransport ?? nodeTransport;
    try {
      const res = await transport(url, {
        method,
        headers: { "User-Agent": "Agav-CLI/0.1", ...headers },
        body,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      const capture = new ResponseCapture();
      let readError: string | undefined;
      if (res.body) {
        const decoder = new TextDecoder();
        let received = 0;
        let cancelled = false;
        try {
          for await (const value of res.body) {
            const remaining = MAX_RESPONSE_BYTES - received;
            const accepted = value.subarray(0, remaining);
            received += accepted.length;
            capture.capture(decoder.decode(accepted, { stream: true }));
            if (value.length > remaining || capture.partial) {
              capture.partial = true;
              cancelled = true;
              // Cancellation can itself reject on a broken connection. Retain
              // the quota warning and original HTTP status in either case.
              await Promise.resolve(res.cancel()).catch(() => {});
              break;
            }
          }
        } catch (error) {
          readError = error instanceof Error ? error.message : String(error);
          if (!cancelled) await Promise.resolve(res.cancel()).catch(() => {});
        } finally {
          capture.capture(decoder.decode());
        }
      }
      const ok = res.status >= 200 && res.status < 300;
      return {
        output: capture.finish(`HTTP ${res.status} ${res.statusText}`, readError),
        isError: !ok || readError !== undefined,
      };
    } catch (error) {
      return {
        output: `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

export { SAFE_METHODS };
