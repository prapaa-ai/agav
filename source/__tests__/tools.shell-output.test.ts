import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    mkdtempSync: vi.fn(actual.mkdtempSync),
    writeSync: vi.fn(actual.writeSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: vi.fn(actual.platform) };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn(actual.execFile) };
});

import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { dirname } from "node:path";
import { platform } from "node:os";
import { shellTool } from "../tools/shell.js";
import { runInSandbox } from "../utils/sandbox.js";

const directories = new Set<string>();
const command = (code: string) => `"${process.execPath}" -e ${JSON.stringify(code).replace(/\$/g, "\\$")}`;
const execute = (code: string) => shellTool.execute({ command: command(code), sandbox: "none" });
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  if (platform() === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm is parenthesized and may itself contain spaces or parentheses.
      // A zombie has exited, but its PID exists until its parent reaps it.
      return stat.slice(stat.lastIndexOf(")") + 1).trimStart().split(" ")[0] !== "Z";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}
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

  it("decodes split Unicode independently across interleaved streams", async () => {
    vi.mocked(spawn).mockImplementationOnce((() => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      setImmediate(() => {
        child.stdout.write(Buffer.from([0xf0, 0x9f]));
        child.stderr.write(Buffer.from([0xc3]));
        child.stdout.write(Buffer.from([0x98, 0x80]));
        child.stderr.write(Buffer.from([0xa9]));
        child.stdout.write("x".repeat(41000));
        child.stdout.end(Buffer.from([0xc3])); // Flush an incomplete final sequence.
        child.stderr.end();
        setImmediate(() => child.emit("close", 0, null));
      });
      return child;
    }) as typeof spawn);
    const result = await execute("");
    expect(readFileSync(savedPath(result.output), "utf8")).toBe("😀é" + "x".repeat(41000) + "�");
    expect(result.output).toMatch(/^😀é/);
  });

  it("persists chronological output when only the formatted failure crosses the cap", async () => {
    const result = await execute("process.stdout.write('HEAD' + 'x'.repeat(39972) + 'TAIL'); process.exitCode = 7;");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("HEAD");
    expect(result.output).toContain("TAIL");
    expect(result.output).toContain("Command exited with code 7");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
    expect(readFileSync(savedPath(result.output), "utf8")).toBe("HEAD" + "x".repeat(39972) + "TAIL");
  });

  it("spills when the stdout/stderr separator alone crosses the cap", async () => {
    const result = await execute("process.stdout.write('x'.repeat(20000)); setTimeout(() => process.stderr.write('y'.repeat(20000)), 40);");
    expect(readFileSync(savedPath(result.output), "utf8")).toBe("x".repeat(20000) + "y".repeat(20000));
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
  });

  it("caps saved logs at 16MiB without stopping or rerunning the command and retains the final tail", async () => {
    const quota = 16 * 1024 * 1024;
    const result = await execute("process.stdout.write('HEAD' + 'x'.repeat(16 * 1024 * 1024) + 'TAIL'); setTimeout(() => { process.stdout.write('FINISHED'); process.exitCode = 7; }, 40);");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("HEAD");
    expect(result.output).toContain("TAILFINISHED");
    expect(result.output).toContain("Command exited with code 7");
    expect(result.output).toContain("16 MiB");
    expect(result.output).toContain("partial");
    expect(result.output).not.toContain("Full output saved to:");
    const path = result.output.match(/Partial output saved to: (.+)\n/)?.[1];
    expect(path).toBeDefined();
    directories.add(dirname(path!));
    expect(statSync(path!).size).toBe(quota);
    expect(readFileSync(path!, "utf8")).toBe("HEAD" + "x".repeat(quota - 4));
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(40_000);
    expect(spawn).toHaveBeenCalledTimes(1);
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

describe("process cleanup liveness check", () => {
  it.each(["R", "S", "D", "T", "Z"])("only treats Linux zombie state as exited (%s)", (state) => {
    vi.mocked(platform).mockReturnValue("linux");
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValueOnce(`12345 (command with ) parentheses) ${state} 1 12345`);
    expect(isProcessRunning(12345)).toBe(state !== "Z");
    expect(readFileSync).toHaveBeenCalledWith("/proc/12345/stat", "utf8");
  });

  it("accepts ESRCH and a process reaped between the PID probe and stat read", () => {
    vi.mocked(platform).mockReturnValue("linux");
    const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(isProcessRunning(12345)).toBe(false);
    expect(readFileSync).not.toHaveBeenCalled();
    kill.mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("reaped"), { code: "ENOENT" });
    });
    expect(isProcessRunning(12345)).toBe(false);
  });

  it("does not mistake permission failures for process exit", () => {
    vi.mocked(platform).mockReturnValue("linux");
    const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw Object.assign(new Error("probe denied"), { code: "EPERM" });
    });
    expect(() => isProcessRunning(12345)).toThrow("probe denied");
    kill.mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("stat denied"), { code: "EACCES" });
    });
    expect(() => isProcessRunning(12345)).toThrow("stat denied");
  });

  it("requires PID disappearance outside Linux", () => {
    vi.mocked(platform).mockReturnValue("darwin");
    vi.spyOn(process, "kill").mockReturnValue(true);
    expect(isProcessRunning(12345)).toBe(true);
    expect(readFileSync).not.toHaveBeenCalled();
  });
});

describe("sandbox streaming option", () => {
  it.skipIf(process.platform === "win32")("keeps successful commands successful while descendants hold their pipes", async () => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    const result = await runInSandbox({
      command: command("require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();"),
      cwd: process.cwd(), timeout: 100, maxBuffer: 1, forceBackend: "none",
      onOutput: (chunk) => chunks.push(chunk),
    });
    // Descendants retaining output pipes remain bounded by the command timeout.
    expect(result.error).toBeNull();
    expect(Date.now() - started).toBeLessThan(650);
  });

  it.skipIf(process.platform === "win32")("keeps buffered success bounded while descendants hold their pipes", async () => {
    const started = Date.now();
    const result = await runInSandbox({
      command: "sleep 1.5 & printf OK",
      cwd: process.cwd(), timeout: 100, maxBuffer: 1024, forceBackend: "none",
    });
    expect(result.error).toBeNull();
    expect(result.stdout).toBe("OK");
    expect(Date.now() - started).toBeLessThan(650);
  });

  it.each(["abort", "maxBuffer"])("retains %s errors after successful leader exit and pipe-drain timeout", async (reason) => {
    const controller = new AbortController();
    vi.mocked(spawn).mockImplementationOnce((() => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      setImmediate(() => {
        child.emit("exit", 0, null);
        if (reason === "abort") controller.abort();
        else child.stdout.write("overflow");
      });
      return child; // Retain pipes until bounded drainage forces completion.
    }) as typeof spawn);
    const result = await runInSandbox({
      command: "echo hi", cwd: process.cwd(), timeout: 20, maxBuffer: 1,
      forceBackend: "none", signal: controller.signal,
    });
    expect(result.error?.message).toBe(reason === "abort"
      ? "Command cancelled." : "Command output exceeded maxBuffer.");
  });

  it.skipIf(process.platform === "win32")("escalates when the actual command and descendant ignore SIGTERM", async () => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    const code = "process.on('SIGTERM', () => {}); const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setTimeout(() => {}, 1500)'], { stdio: ['ignore', 'inherit', 'inherit'] }); process.stdout.write(process.pid + ',' + child.pid); setTimeout(() => {}, 1500);";
    const result = await runInSandbox({
      command: `exec ${command(code)}`,
      cwd: process.cwd(), timeout: 100, maxBuffer: 1, forceBackend: "none",
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(result.error?.message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(650);
    const pids = Buffer.concat(chunks).toString().split(",").map(Number);
    expect(pids).toHaveLength(2);
    for (const pid of pids) {
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      // Stay well below the fixture's 1500ms natural exit: a missed kill must fail.
      await vi.waitFor(() => expect(isProcessRunning(pid)).toBe(false), { timeout: 100, interval: 10 });
    }
    expect(vi.mocked(spawn).mock.calls[0]?.[2]?.detached).toBe(true);
  });

  it("terminates Windows process trees and escalates with taskkill /F", async () => {
    vi.mocked(platform).mockReturnValue("win32");
    vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _options: object, callback: Function) => {
      callback(null, "", "");
      return {};
    }) as typeof execFile);
    vi.mocked(spawn).mockImplementationOnce((() => {
      const child = new EventEmitter() as any;
      child.pid = 12345;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      return child;
    }) as typeof spawn);
    const result = await runInSandbox({ command: "echo hi", cwd: process.cwd(), timeout: 20, maxBuffer: 1, forceBackend: "none", onOutput: () => {} });
    expect(result.error?.message).toContain("timed out");
    expect(spawn).toHaveBeenCalledWith("cmd.exe", ["/c", "echo hi"], expect.objectContaining({ detached: false }));
    expect(execFile).toHaveBeenCalledWith("taskkill", ["/PID", "12345", "/T"], { timeout: 150 }, expect.any(Function));
    expect(execFile).toHaveBeenCalledWith("taskkill", ["/PID", "12345", "/T", "/F"], { timeout: 150 }, expect.any(Function));
  });

  it("bounds pipe drainage even if a descendant escapes the process group", async () => {
    vi.mocked(spawn).mockImplementationOnce((() => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      return child; // Neither close nor exit is delivered.
    }) as typeof spawn);
    const started = Date.now();
    const result = await runInSandbox({ command: "echo hi", cwd: process.cwd(), timeout: 20, maxBuffer: 1, forceBackend: "none", onOutput: () => {} });
    expect(result.error?.message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(650);
    const child = vi.mocked(spawn).mock.results[0]!.value;
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

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
