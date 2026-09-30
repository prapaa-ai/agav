import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: vi.fn(actual.mkdtempSync),
    writeSync: vi.fn(actual.writeSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) };
});

import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { dirname } from "node:path";
import { shellTool } from "../tools/shell.js";
import { runInSandbox } from "../utils/sandbox.js";

const directories = new Set<string>();
const command = (code: string) => `"${process.execPath}" -e ${JSON.stringify(code).replace(/\$/g, "\\$")}`;
const execute = (code: string) => shellTool.execute({ command: command(code), sandbox: "none" });
function savedPath(output: string): string {
  const path = output.match(/Full output saved to: (.+)\n/)?.[1];
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
  vi.clearAllMocks();
});

describe("bounded streamed shell output", () => {
  it("keeps small stdout/stderr output unchanged without creating a file", async () => {
    const result = await execute("process.stdout.write('hello'); process.stderr.write('warning');");
    expect(result).toEqual({ output: "hello\nwarning", isError: false });
    expect(mkdtempSync).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports success with no output and failures even when stdout exists", async () => {
    expect(await execute("")).toEqual({ output: "Command completed with no output.", isError: false });
    const result = await execute("process.stdout.write('before failure'); process.exitCode = 7;");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("before failure");
    expect(result.output).toContain("Command failed: Command exited with code 7");
  });

  it("streams well beyond the old 200KB buffer and saves the complete log privately", async () => {
    const expected = "FIRST\n" + "x".repeat(500_000) + "\nLAST";
    const result = await execute("process.stdout.write('FIRST\\n' + 'x'.repeat(500000) + '\\nLAST');");
    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
    expect(result.output).toMatch(/^FIRST\n/);
    expect(result.output).toContain("\nLAST");
    expect(result.output).toContain("read_file");
    expect(result.output).toContain("grep_search");
    const path = savedPath(result.output);
    expect(readFileSync(path, "utf8")).toBe(expected);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(renameSync).toHaveBeenCalledWith(path.replace(/output.log$/, "output.tmp"), path);
  });

  it("spills only above 40,000 UTF8 bytes and does not split Unicode preview boundaries", async () => {
    const small = await execute("process.stdout.write('é'.repeat(20000));");
    expect(small.output).toBe("é".repeat(20_000));
    expect(mkdtempSync).not.toHaveBeenCalled();
    const result = await execute("process.stdout.write('😀'.repeat(20000));");
    expect(result.output).not.toContain("�");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
    expect(readFileSync(savedPath(result.output), "utf8")).toBe("😀".repeat(20_000));
  });

  it("saves stdout and stderr in observed chronological order", async () => {
    const result = await execute("process.stdout.write('a'.repeat(41000)); setTimeout(() => { process.stderr.write('STDERR'); setTimeout(() => process.stdout.write('END'), 40); }, 40);");
    expect(readFileSync(savedPath(result.output), "utf8")).toBe("a".repeat(41_000) + "STDERREND");
  });

  it("publishes distinct complete files for concurrent commands", async () => {
    const results = await Promise.all([execute("process.stdout.write('A'.repeat(80000));"), execute("process.stdout.write('B'.repeat(80000));")]);
    const paths = results.map((result) => savedPath(result.output));
    expect(paths[0]).not.toBe(paths[1]);
    expect(readFileSync(paths[0]!, "utf8")).toBe("A".repeat(80_000));
    expect(readFileSync(paths[1]!, "utf8")).toBe("B".repeat(80_000));
  });

  it.each(["create", "write", "publish"])("does not fail or re-execute a command when log %s fails", async (stage) => {
    const fail = () => { throw new Error("disk unavailable"); };
    if (stage === "create") vi.mocked(mkdtempSync).mockImplementationOnce(fail);
    if (stage === "write") vi.mocked(writeSync).mockImplementationOnce(fail);
    if (stage === "publish") vi.mocked(renameSync).mockImplementationOnce(fail);
    const result = await execute("process.stdout.write('START' + 'x'.repeat(100000) + 'END');");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("START");
    expect(result.output).toContain("END");
    expect(result.output).toContain("full output log unavailable");
    expect(result.output).not.toContain("Full output saved to:");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("includes failure status after a large output", async () => {
    const result = await execute("process.stdout.write('x'.repeat(100000)); process.exitCode = 9;");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Command exited with code 9");
    expect(readFileSync(savedPath(result.output)).length).toBe(100_000);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
  });

  it("handles short writes without losing complete log bytes", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeSync).mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number) =>
      actual.writeSync(fd, buffer, offset, Math.min(length, 1024))) as typeof writeSync);
    const result = await execute("process.stdout.write('x'.repeat(80000));");
    expect(readFileSync(savedPath(result.output), "utf8")).toBe("x".repeat(80_000));
    expect(result.isError).toBe(false);
  });

  it("still blocks destructive commands before starting a process", async () => {
    const result = await shellTool.execute({ command: "rm -rf /", sandbox: "none" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Blocked:");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("sandbox streaming option", () => {
  it("returns timeout errors and streamed partial output without buffered copies", async () => {
    const chunks: Buffer[] = [];
    const result = await runInSandbox({
      command: `exec ${command("process.stdout.write('started'); setInterval(() => {}, 1000);")}`,
      cwd: process.cwd(), timeout: 300, maxBuffer: 1, forceBackend: "none",
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(Buffer.concat(chunks).toString()).toBe("started");
    expect(result.error?.message).toContain("timed out");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("reports spawn errors", async () => {
    const result = await runInSandbox({ command: "echo hi", cwd: "/agav-nonexistent-directory", timeout: 100, maxBuffer: 1, forceBackend: "none", onOutput: () => {} });
    expect(result.error?.message).toContain("ENOENT");
  });

  it.each(["seatbelt", "bubblewrap"] as const)("keeps %s security arguments in the spawn path", async (backend) => {
    vi.mocked(spawn).mockImplementationOnce((() => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      setImmediate(() => child.emit("close", 0, null));
      return child;
    }) as typeof spawn);
    const result = await runInSandbox({ command: "echo hi", cwd: process.cwd(), timeout: 1000, maxBuffer: 1, forceBackend: backend, onOutput: () => {} });
    expect(result.error).toBeNull();
    const [file, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(file).toBe(backend === "seatbelt" ? "sandbox-exec" : "bwrap");
    expect(args).toContain("echo hi");
    if (backend === "seatbelt") expect(args).toContain(`HOME_SSH=${process.env.HOME}/.ssh`);
    else expect(args?.join(" ")).toContain(`--tmpfs ${process.env.HOME}/.ssh`);
    expect(options?.env).not.toHaveProperty("GITHUB_TOKEN");
  });
});
