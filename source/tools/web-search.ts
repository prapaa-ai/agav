import type { ToolDefinition, ToolResult } from "./types.js";

export const webSearchTool: ToolDefinition = {
  schema: {
    name: "web_search",
    description:
      "Search the web for information. Returns a list of search results with titles, URLs, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },

  async execute(input): Promise<ToolResult> {
    const query = String(input.query);

    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Agav-CLI/0.1",
        },
      });

      if (!res.ok) {
        return { output: `Search failed: HTTP ${res.status}`, isError: true };
      }

      const html = await res.text();
      const results = parseResults(html);

      if (results.length === 0) {
        return { output: "No results found.", isError: false };
      }

      const formatted = results
        .slice(0, 8)
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");

      return { output: formatted, isError: false };
    } catch (err) {
      return {
        output: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Extract result rows from DuckDuckGo's lightweight HTML response. */
function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const linkRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gs;

  const links = [...html.matchAll(linkRegex)];
  const snippets = [...html.matchAll(snippetRegex)];

  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    let url = link[1] ?? "";
    const title = stripTags(link[2] ?? "");
    const snippet = stripTags(snippets[i]?.[1] ?? "");

    // DuckDuckGo wraps URLs in a redirect
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) {
      url = decodeURIComponent(uddg[1]!);
    }

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
