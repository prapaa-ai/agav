import type { ToolDefinition, ToolResult } from "./types.js";

const MAX_RESPONSE = 100_000;

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
        headers: {
          "User-Agent": "Agav-CLI/0.1",
          ...headers,
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });

      const contentType = res.headers.get("content-type") ?? "";
      let text = await res.text();

      if (text.length > MAX_RESPONSE) {
        text = text.slice(0, MAX_RESPONSE) + "\n...(truncated)";
      }

      const status = `HTTP ${res.status} ${res.statusText}`;

      if (!res.ok) {
        return { output: `${status}\n${text}`, isError: true };
      }

      return { output: `${status}\n${text}`, isError: false };
    } catch (err) {
      return {
        output: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
