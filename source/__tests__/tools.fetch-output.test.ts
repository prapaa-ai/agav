import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/temp-output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/temp-output.js")>();
  const { isolatedTempOutputManager } = await import("./helpers/temp-output.js");
  return { ...actual, tempOutputManager: await isolatedTempOutputManager(actual.TempOutputManager) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: vi.fn(actual.mkdtempSync),
    writeSync: vi.fn(actual.writeSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { fetchUrlTool } from "../tools/fetch-url.js";

const directories = new Set<string>();
const encoder = new TextEncoder();
const execute = () => fetchUrlTool.execute({ url: "https://example.com/private" });

function respond(chunks: Uint8Array[], status = 200, statusText = "OK") {
  const cancel = vi.fn();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
    cancel,
  });
  const response = new Response(stream, { status, statusText });
  const text = vi.spyOn(response, "text");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  return { response, text, cancel };
}

function savedPath(output: string): string {
  const path = output.match(/(?:Full|Partial) response saved to: (.+)\n/)?.[1];
  expect(path).toBeDefined();
  directories.add(dirname(path!));
  return path!;
}

afterEach(() => {
  for (const call of vi.mocked(mkdtempSync).mock.results) {
    if (call.type === "return" && typeof call.value === "string") directories.add(call.value);
  }
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("bounded streamed HTTP response", () => {
  it("keeps small output unchanged and never calls Response.text", async () => {
    const { text } = respond([encoder.encode("hello"), encoder.encode(" world")]);
    expect(await execute()).toEqual({ output: "HTTP 200 OK\nhello world", isError: false });
    expect(text).not.toHaveBeenCalled();
    expect(mkdtempSync).not.toHaveBeenCalled();
  });

  it("handles an empty response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204, statusText: "No Content" })));
    expect(await execute()).toEqual({ output: "HTTP 204 No Content\n", isError: false });
  });

  it("preserves non-success HTTP status and body", async () => {
    respond([encoder.encode("not found")], 404, "Not Found");
    expect(await execute()).toEqual({ output: "HTTP 404 Not Found\nnot found", isError: true });
  });

  it("passes method, headers, body, and timeout without retrying", async () => {
    respond([encoder.encode("created")], 201, "Created");
    const result = await fetchUrlTool.execute({
      url: "https://example.com/private", method: "POST",
      headers: { Authorization: "Bearer secret", "User-Agent": "custom" }, body: "payload",
    });
    expect(result.isError).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("https://example.com/private", {
      method: "POST", headers: { Authorization: "Bearer secret", "User-Agent": "custom" },
      body: "payload", signal: expect.any(AbortSignal),
    });
  });

  it("decodes multibyte Unicode and BOM across independently delivered chunks", async () => {
    const expected = "é😀漢字\nending";
    const bytes = encoder.encode("\ufeff" + expected);
    respond(Array.from(bytes, (byte) => Uint8Array.of(byte)));
    expect(await execute()).toEqual({ output: `HTTP 200 OK\n${expected}`, isError: false });
  });

  it("flushes an incomplete final UTF8 sequence", async () => {
    respond([encoder.encode("before "), Uint8Array.of(0xe2, 0x82)]);
    expect((await execute()).output).toBe("HTTP 200 OK\nbefore �");
  });

  it("spills only above 38,000 decoded UTF8 bytes", async () => {
    respond([encoder.encode("é".repeat(19_000))]);
    expect((await execute()).output).toBe("HTTP 200 OK\n" + "é".repeat(19_000));
    expect(mkdtempSync).not.toHaveBeenCalled();
    const expected = "é".repeat(19_001);
    respond([encoder.encode(expected)]);
    const result = await execute();
    expect(readFileSync(savedPath(result.output), "utf8")).toBe(expected);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
  });

  it("saves the entire large response privately and publishes atomically", async () => {
    const expected = "FIRST\n" + "x".repeat(500_000) + "\nLAST";
    respond([encoder.encode(expected)]);
    const result = await execute();
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/^HTTP 200 OK\nFIRST\n/);
    expect(result.output).toContain("\nLAST");
    expect(result.output).toContain("read_file");
    expect(result.output).toContain("grep_search");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
    const path = savedPath(result.output);
    expect(readFileSync(path, "utf8")).toBe(expected);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(path))).toEqual(["output.log"]);
    expect(renameSync).toHaveBeenCalledWith(path.replace(/output.log$/, "output.tmp"), path);
  });

  it("keeps preview boundaries valid for Unicode", async () => {
    const expected = "😀漢é".repeat(20_000);
    const bytes = encoder.encode(expected);
    respond([bytes.subarray(0, 91_001), bytes.subarray(91_001)]);
    const result = await execute();
    expect(result.output).not.toContain("�");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
    expect(readFileSync(savedPath(result.output), "utf8")).toBe(expected);
  });

  it("handles short synchronous writes without losing response bytes", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeSync).mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number) =>
      actual.writeSync(fd, buffer, offset, Math.min(length, 127))) as typeof writeSync);
    const expected = "abcdef".repeat(15_000);
    respond([encoder.encode(expected)]);
    expect(readFileSync(savedPath((await execute()).output), "utf8")).toBe(expected);
  });

  it("warns on log creation failure without changing HTTP success", async () => {
    vi.mocked(mkdtempSync).mockImplementation(() => { throw new Error("permission denied"); });
    respond([encoder.encode("x".repeat(60_000))]);
    const result = await execute();
    expect(result.isError).toBe(false);
    expect(result.output).toContain("HTTP 200 OK");
    expect(result.output).toContain("log unavailable");
    expect(result.output).not.toContain("saved to:");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
  });

  it("cleans up write failures and preserves HTTP failure semantics", async () => {
    vi.mocked(writeSync).mockImplementation(() => { throw new Error("disk full"); });
    respond([encoder.encode("x".repeat(60_000))], 503, "Unavailable");
    const result = await execute();
    expect(result.isError).toBe(true);
    expect(result.output).toContain("HTTP 503 Unavailable");
    expect(result.output).toContain("log unavailable");
    expect(result.output).not.toContain("saved to:");
    for (const call of vi.mocked(mkdtempSync).mock.results) {
      if (call.type === "return") expect(() => statSync(call.value)).toThrow();
    }
  });

  it("does not advertise a log when atomic publication fails", async () => {
    vi.mocked(renameSync).mockImplementation(() => { throw new Error("rename failed"); });
    respond([encoder.encode("x".repeat(60_000))]);
    const result = await execute();
    expect(result.isError).toBe(false);
    expect(result.output).toContain("log unavailable");
    expect(result.output).not.toContain("saved to:");
    for (const call of vi.mocked(mkdtempSync).mock.results) {
      if (call.type === "return") expect(() => statSync(call.value)).toThrow();
    }
  });

  it("cancels above the 16 MiB quota and clearly labels a bounded partial log", async () => {
    const quota = 16 * 1024 * 1024;
    const { cancel } = respond([
      encoder.encode("FIRST\n"), new Uint8Array(quota).fill(120), encoder.encode("NEVER_READ"),
    ]);
    const result = await execute();
    expect(result.isError).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(result.output).toContain("partial response capture");
    expect(result.output).toContain("16 MiB");
    expect(result.output).not.toContain("Full response saved");
    expect(result.output).not.toContain("NEVER_READ");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
    const path = savedPath(result.output);
    expect(statSync(path).size).toBe(quota);
    expect(readFileSync(path, "utf8")).toMatch(/^FIRST\nx+$/);
  });

  it("reports network and streamed read failures without losing captured HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await execute()).toEqual({ output: "Fetch failed: offline", isError: true });
    let count = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (count++ === 0) controller.enqueue(encoder.encode("partial body"));
        else controller.error(new Error("connection reset"));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200, statusText: "OK" })));
    const result = await execute();
    expect(result.isError).toBe(true);
    expect(result.output).toContain("HTTP 200 OK\npartial body");
    expect(result.output).toContain("response read failed: connection reset");
    expect(result.output).toContain("capture is partial");
  });
});
