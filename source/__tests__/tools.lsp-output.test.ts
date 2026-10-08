import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { resolve } from "node:path";
import type { ToolDefinition } from "../tools/types.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

let tool: ToolDefinition;
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable };
let response: unknown;
let rpcError: string | undefined;
const requests: { id: number; method: string; params: unknown }[] = [];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.mocked(spawn).mockReset();
  requests.length = 0;
  response = null;
  rpcError = undefined;
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const frame = chunk.toString();
        const request = JSON.parse(frame.slice(frame.indexOf("\r\n\r\n") + 4));
        requests.push(request);
        const reply = request.method === "initialize"
          ? { result: { capabilities: {} } }
          : rpcError === undefined ? { result: response } : { error: { code: -32603, message: rpcError } };
        // ASCII-escaped Unicode is valid JSON and avoids exercising the existing
        // unrelated byte/character framing issue in the LSP response parser.
        const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })
          .replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
        Promise.resolve().then(() => child.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
        callback();
      },
    }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  tool = (await import("../tools/lsp.js")).lspTool;
});

afterEach(() => {
  child.emit("exit", 0);
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.removeAllListeners();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.mocked(spawn).mockReset();
});

const range = { start: { line: 12, character: 4 }, end: { line: 12, character: 17 } };
const metadata = { label: " café 中 😀  ", nested: { text: "first  line\n\t second line", nullable: null, items: [] } };
const location = { uri: "file:///workspace/café.ts", range, metadata };
const locationLink = {
  originSelectionRange: range,
  targetUri: "file:///workspace/定义.ts",
  targetRange: { start: { line: 10, character: 0 }, end: { line: 15, character: 1 } },
  targetSelectionRange: range,
  metadata,
};
const input = { path: "source/example.ts", line: 12, character: 7 };

describe("lsp result formatting", () => {
  it.each([
    { operation: "definition", name: "single Location", payload: location },
    { operation: "definition", name: "Location array", payload: [location, { uri: "file:///workspace/other.ts", range }] },
    { operation: "definition", name: "LocationLink array", payload: [locationLink] },
    { operation: "definition", name: "null", payload: null },
    { operation: "definition", name: "empty array", payload: [] },
    { operation: "references", name: "Location array", payload: [location, { uri: "file:///workspace/other.ts", range }] },
    { operation: "references", name: "null", payload: null },
    { operation: "references", name: "empty array", payload: [] },
  ])("returns compact, lossless $operation $name", async ({ operation, payload }) => {
    response = payload;
    const result = await tool.execute({ ...input, operation });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toEqual(payload);
    // Exact comparison also protects field/array order and whitespace in strings.
    expect(result.output).toBe(JSON.stringify(payload));
    expect(result.output).not.toContain("\n");
    if (payload !== null && JSON.stringify(payload) !== "[]") {
      expect(Buffer.byteLength(result.output)).toBeLessThan(Buffer.byteLength(JSON.stringify(payload, null, 2)));
    }
    expect(requests.map((request) => request.method)).toEqual(["initialize", `textDocument/${operation}`]);
    expect(requests[1].params).toEqual({
      textDocument: { uri: `file://${resolve(input.path)}` },
      position: { line: input.line, character: input.character },
      ...(operation === "references" ? { context: { includeDeclaration: true } } : {}),
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reuses the server for definition and references without extra RPCs", async () => {
    response = location;
    await tool.execute({ ...input, operation: "definition" });
    response = [location];
    expect(await tool.execute({ ...input, operation: "references" })).toEqual({ output: JSON.stringify([location]), isError: false });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(requests.map((request) => request.method)).toEqual(["initialize", "textDocument/definition", "textDocument/references"]);
    expect(requests.map((request) => request.id)).toEqual([1, 2, 3]);
  });

  it.each([
    { contents: " hover  text\n\t café 😀 ", expected: " hover  text\n\t café 😀 " },
    { contents: { kind: "markdown", value: "```ts\nconst  value = null;\n```" }, expected: "```ts\nconst  value = null;\n```" },
    { contents: [{ language: "typescript", value: "const  value: string" }], expected: '[{"language":"typescript","value":"const  value: string"}]' },
  ])("leaves hover contents unchanged: $expected", async ({ contents, expected }) => {
    response = { contents, range };
    expect(await tool.execute({ ...input, operation: "hover" })).toEqual({ output: expected, isError: false });
  });

  it("leaves missing hover information unchanged", async () => {
    expect(await tool.execute({ ...input, operation: "hover" })).toEqual({ output: "No hover information.", isError: false });
  });

  it.each(["definition", "references", "hover"])("leaves %s RPC errors unchanged", async (operation) => {
    rpcError = " server  error\n café 😀 ";
    expect(await tool.execute({ ...input, operation })).toEqual({ output: rpcError, isError: true });
  });

  it("leaves the diagnostics placeholder unchanged", async () => {
    expect(await tool.execute({ ...input, operation: "diagnostics" })).toEqual({
      output: "Diagnostics requested. Results come via notifications (not yet captured).", isError: false,
    });
    expect(requests.map((request) => request.method)).toEqual(["initialize", "textDocument/didOpen"]);
  });
});
