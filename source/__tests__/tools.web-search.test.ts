import { afterEach, describe, expect, it, vi } from "vitest";

import { SEARCH_TIMEOUT_MS, webSearchTool } from "../tools/web-search.js";

const search = () => webSearchTool.execute({ query: "agav" });

/** A fetch that never settles on its own and only rejects when its signal aborts. */
function hangingFetch() {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // would hang forever, which is the bug
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  );
}

describe("tools/web_search", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("aborts a hung request after SEARCH_TIMEOUT_MS and reports a timeout", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pending = search();
    expect(timeout).toHaveBeenCalledWith(SEARCH_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    // What AbortSignal.timeout does when the deadline passes.
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

    await expect(pending).resolves.toEqual({ output: "Search timed out after 30s.", isError: true });
  });

  it("keeps reporting other network errors as search failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(search()).resolves.toEqual({ output: "Search failed: fetch failed", isError: true });
  });

  it("defaults to eight parsed results and allows a smaller or larger limit", async () => {
    const html = Array.from({ length: 10 }, (_, i) =>
      `<a class="result__a" href="https://example.com/${i + 1}">Item ${i + 1}</a>`,
    ).join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html)));
    const titles = (output: string) => output.split("\n").filter((line) => /^\d+\./.test(line));
    expect(titles((await search()).output)).toEqual(Array.from({ length: 8 }, (_, i) => `${i + 1}. Item ${i + 1}`));
    expect(titles((await webSearchTool.execute({ query: "agav", max_results: 2 })).output)).toEqual(["1. Item 1", "2. Item 2"]);
    expect(titles((await webSearchTool.execute({ query: "agav", max_results: 30 })).output)).toHaveLength(10);
  });

  it.each([0, -1, 1.5, "2", null, 31, Number.MAX_SAFE_INTEGER + 1])(
    "reports an invalid max_results (%s) before fetching",
    async (max_results) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(""));
      vi.stubGlobal("fetch", fetchMock);
      const result = await webSearchTool.execute({ query: "agav", max_results });
      expect(result).toEqual({ output: "max_results must be an integer between 1 and 30", isError: true });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("returns parsed results for a normal response", async () => {
    const html =
      '<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=x">Example <b>Site</b></a>' +
      '<a class="result__snippet" href="#">An &amp; example</a>';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(html, { status: 200 })));

    await expect(search()).resolves.toEqual({
      output: "1. Example Site\n   https://example.com/\n   An & example",
      isError: false,
    });
  });
});
