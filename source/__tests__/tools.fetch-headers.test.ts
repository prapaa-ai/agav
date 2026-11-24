import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUrlTool, formatResponseHeaders, setFetchTransport, type Transport } from "../tools/fetch-url.js";

const encoder = new TextEncoder();

function respond(headers: Record<string, string | string[]> | undefined, chunks: string[] = ["body"], status = 200) {
  async function* body(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield encoder.encode(chunk);
  }
  setFetchTransport(vi.fn<Transport>().mockResolvedValue({
    status, statusText: status === 204 ? "No Content" : "OK", headers, body: body(), cancel: vi.fn(),
  }));
}

afterEach(() => setFetchTransport(undefined));

describe("fetch_url headers", () => {
  it("keeps the body-only output when include_headers is omitted or false", async () => {
    respond({ "content-type": "text/plain" });
    const plain = await fetchUrlTool.execute({ url: "https://example.com/" });
    expect(plain.output).toBe("HTTP 200 OK\nbody");
    respond({ "content-type": "text/plain" });
    const off = await fetchUrlTool.execute({ url: "https://example.com/", include_headers: false });
    expect(off.output).toBe(plain.output);
  });

  it("renders sorted headers, repeated values and redacted credentials", async () => {
    respond({
      "content-type": "text/plain",
      "set-cookie": ["session=abc", "theme=dark"],
      authorization: "Bearer secret",
      "x-request-id": "req-1",
    }, [], 204);
    const result = await fetchUrlTool.execute({ url: "https://example.com/", include_headers: true });

    expect(result.isError).toBe(false);
    expect(result.output).toContain("HTTP 204 No Content");
    expect(result.output).toContain("Headers:");
    expect(result.output.indexOf("authorization:")).toBeLessThan(result.output.indexOf("content-type:"));
    expect(result.output).toContain("set-cookie: [redacted]");
    expect(result.output.match(/set-cookie:/g)).toHaveLength(2);
    expect(result.output).toContain("authorization: [redacted]");
    expect(result.output).not.toContain("session=abc");
    expect(result.output).toContain("x-request-id: req-1");
  });

  it("says headers are absent instead of printing an empty block", async () => {
    respond(undefined);
    const result = await fetchUrlTool.execute({ url: "https://example.com/", include_headers: true });
    expect(result.output).toContain("Headers:\n  (none)");
  });

  it("rejects a non-boolean include_headers before fetching", async () => {
    const transport = vi.fn<Transport>();
    setFetchTransport(transport);
    const result = await fetchUrlTool.execute({ url: "https://example.com/", include_headers: "yes" });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/include_headers must be a boolean/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("formats headers without a status line helper relying on the capture", () => {
    expect(formatResponseHeaders({ b: "2", a: "1" })).toBe("Headers:\n  a: 1\n  b: 2");
  });
});
