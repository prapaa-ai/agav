import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileReadTool } from "../tools/file-read.js";
import { fetchUrlTool } from "../tools/fetch-url.js";
import type { ToolResult } from "../tools/types.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "agav-read-test-")); });
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function file(text: string | Buffer, name = "input.txt") {
  const path = join(directory, name);
  await writeFile(path, text);
  return path;
}
function bounded(result: ToolResult) {
  expect(result.isError).toBe(false);
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
  expect(result.output.split("\n").length).toBeLessThanOrEqual(2000);
  expect(result.contentBlocks).toEqual([{ type: "text", text: result.output }]);
  expect(result.output).not.toContain("�");
}
function continuation(result: ToolResult) {
  const match = result.output.match(/start_line=(\d+)/);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

describe("bounded file reads", () => {
  it("keeps a small nonranged read and synchronized text blocks unchanged", async () => {
    const path = await file("hello\r\nworld\n");
    const result = await fileReadTool.execute({ path });
    bounded(result);
    expect(result.output).toBe("hello\r\nworld\n");
  });

  it("preserves CRLF across stream chunk boundaries", async () => {
    const text = "x".repeat(8191) + "\r\nlast";
    const result = await fileReadTool.execute({ path: await file(text) });
    bounded(result);
    expect(result.output).toBe(text);
  });

  it("counts an unterminated last line when a requested start is outside EOF", async () => {
    const result = await fileReadTool.execute({ path: await file("one\ntwo\nthree"), start_line: 4 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("outside the file (3 lines)");
  });

  it("keeps inclusive range headers and handles an end past EOF", async () => {
    const path = await file("one\ntwo\nthree\n");
    const result = await fileReadTool.execute({ path, start_line: 2, end_line: 99 });
    bounded(result);
    expect(result.output).toBe(`[Lines 2-3 from ${path}]\ntwo\nthree`);
    const endOnly = await fileReadTool.execute({ path, end_line: 2 });
    expect(endOnly.output).toBe(`[Lines 1-2 from ${path}]\none\ntwo`);
  });

  it.each([false, true])("bounds large text by contiguous whole lines (ranged=%s)", async (ranged) => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `row-${i + 1}: ${"x".repeat(100)}`);
    const path = await file(rows.join("\n"));
    const originalPath = relative(process.cwd(), path);
    const result = await fileReadTool.execute({ path: originalPath, ...(ranged ? { start_line: 3, end_line: 19_999 } : {}) });
    bounded(result);
    const next = continuation(result);
    const start = ranged ? 3 : 1;
    const body = result.output.split("\n\n[Output limited")[0]!.replace(/^\[Lines[^\n]+\]\n/, "").replace(/\n$/, "");
    expect(body).toBe(rows.slice(start - 1, next - 1).join("\n"));
    expect(result.output).toContain(`path=${JSON.stringify(originalPath)}`);
    if (ranged) expect(result.output).toContain("end_line=19999");
    const resumed = await fileReadTool.execute({ path: originalPath, start_line: next, end_line: next });
    expect(resumed.output).toBe(`[Lines ${next}-${next} from ${path}]\n${rows[next - 1]}`);
  });

  it("bounds many short lines by line count", async () => {
    const path = await file("x\n".repeat(3000));
    const result = await fileReadTool.execute({ path });
    bounded(result);
    const next = continuation(result);
    expect(next).toBeGreaterThan(1900);
    expect(next).toBeLessThanOrEqual(2000);
    expect(result.output.split("\n\n[Output limited")[0]).toBe("x\n".repeat(next - 1));
  });

  it("counts UTF8 bytes and keeps emoji whole", async () => {
    const rows = Array.from({ length: 1000 }, () => "😀é".repeat(30));
    const path = await file(rows.join("\n"));
    const result = await fileReadTool.execute({ path });
    bounded(result);
    expect(result.output.split("\n\n[Output limited")[0]).toBe(rows.slice(0, continuation(result) - 1).join("\n") + "\n");
  });

  it.each([false, true])("returns a useful long-line excerpt rather than empty continuation (ranged=%s)", async (ranged) => {
    const path = await file("😀".repeat(600_000) + "\nlast\n");
    const result = await fileReadTool.execute({ path, ...(ranged ? { start_line: 1, end_line: 1 } : {}) });
    bounded(result);
    expect(result.output.startsWith("😀".repeat(100))).toBe(true);
    expect(result.output).toContain("Line 1 is too long");
    expect(result.output).toContain("run_command");
    expect(result.output).toContain(JSON.stringify(path));
    expect(result.output).not.toContain("start_line=1");
    const later = await fileReadTool.execute({ path, start_line: 2 });
    expect(later.output).toBe(`[Lines 2-2 from ${path}]\nlast`);
  });

  it("stops before a large later line without skipping forward to smaller lines", async () => {
    const path = await file("first\n" + "x".repeat(80_000) + "\nlast");
    const result = await fileReadTool.execute({ path });
    bounded(result);
    expect(result.output.startsWith("first\n")).toBe(true);
    expect(result.output).not.toContain("last");
    expect(continuation(result)).toBe(2);
  });

  it("reads ranges near EOF of files larger than 1MiB", async () => {
    const path = await file("skip\n".repeat(300_000) + "target");
    const result = await fileReadTool.execute({ path, start_line: 300_001, end_line: 300_001 });
    bounded(result);
    expect(result.output).toBe(`[Lines 300001-300001 from ${path}]\ntarget`);
  });

  it.each([
    [{ start_line: 0 }, "Line range start must be a positive integer"],
    [{ start_line: 1.5 }, "Line range start must be a positive integer"],
    [{ start_line: "bad" }, "Line range start must be a positive integer"],
    [{ end_line: -1 }, "Line range end must be a positive integer"],
    [{ start_line: 3, end_line: 2 }, "Line range end must be greater than or equal to start"],
    [{ start_line: 4 }, "Line 4 is outside the file (3 lines)"],
    [{ start_page: 1 }, "Page ranges can only be used with PDF or Office documents"],
  ])("preserves validation errors for %j", async (range, error) => {
    const path = await file("one\ntwo\nthree\n");
    const result = await fileReadTool.execute({ path, ...range });
    expect(result.isError).toBe(true);
    expect(result.output).toContain(error);
  });

  it("handles empty files and out-of-file ranges", async () => {
    const path = await file("");
    const result = await fileReadTool.execute({ path });
    bounded(result);
    expect(result.output).toBe("");
    const ranged = await fileReadTool.execute({ path, start_line: 1 });
    expect(ranged.isError).toBe(true);
    expect(ranged.output).toContain("outside the file (0 lines)");
  });

  it("preserves directory rejection and binary rejection", async () => {
    const result = await fileReadTool.execute({ path: directory });
    expect(result.isError).toBe(true);
    expect(result.output).toContain(`Not a file: ${directory}`);
    const path = await file(Buffer.from([0, 1, 2]));
    const binary = await fileReadTool.execute({ path });
    expect(binary.isError).toBe(true);
    expect(binary.output).toContain("Cannot attach binary file");
  });

  it("returns a useful excerpt for a CRLF line at the byte boundary", async () => {
    const path = join(directory, "boundary.txt");
    const budget = 40_000 - Buffer.byteLength(path + path) * 2 - 1024;
    await writeFile(path, "x".repeat(budget - 1) + "\r\nlast");
    const result = await fileReadTool.execute({ path });
    bounded(result);
    expect(result.output.startsWith("xxxx")).toBe(true);
    expect(result.output).toContain("too long");
  });

  it("keeps image range validation in the existing context helper", async () => {
    const path = await file("not an image", "image.png");
    const result = await fileReadTool.execute({ path, start_line: 1 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Line and page ranges cannot be used with image files");
  });

  it("denies protected paths, including symlink aliases", async () => {
    const protectedPath = join(homedir(), ".ssh", "id_rsa");
    const direct = await fileReadTool.execute({ path: protectedPath });
    expect(direct.isError).toBe(true);
    expect(direct.output).toContain("protected credential path");
    const alias = join(directory, "home-alias");
    await symlink(homedir(), alias);
    const linked = await fileReadTool.execute({ path: join(alias, ".ssh", "id_rsa") });
    expect(linked.isError).toBe(true);
    expect(linked.output).toContain("protected credential path");
  });
});

describe("recoverable bounded fetch output", () => {
  it.each([200, 500])("preserves HTTP %s bodies in recoverable logs", async (status) => {
    const body = "START\n" + "😀x".repeat(80_000) + "\nEND";
    const fetch = vi.fn(async () => new Response(body, { status, statusText: status === 200 ? "OK" : "Failure" }));
    vi.stubGlobal("fetch", fetch);
    const result = await fetchUrlTool.execute({ url: "https://example.test/", method: "POST", headers: { Authorization: "secret" }, body: "payload" });
    expect(result.isError).toBe(status !== 200);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
    expect(result.output).toContain("START");
    expect(result.output).toContain("END");
    const path = result.output.match(/Full response saved to: (.+)\n/)![1];
    try { expect(await readFile(path, "utf8")).toBe(body); }
    finally { await rm(dirname(path), { recursive: true, force: true }); }
    expect(fetch).toHaveBeenCalledWith("https://example.test/", expect.objectContaining({ method: "POST", headers: { "User-Agent": "Agav-CLI/0.1", Authorization: "secret" }, body: "payload", signal: expect.any(AbortSignal) }));
  });

  it("preserves fetch errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchUrlTool.execute({ url: "https://example.test" })).toEqual({ output: "Fetch failed: offline", isError: true });
  });
});
