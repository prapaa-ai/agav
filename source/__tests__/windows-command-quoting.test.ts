import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildShellInvocation } from "../background-jobs/launch-spec/shell.js";
import { runInSandbox } from "../utils/sandbox.js";

const command = `"${process.execPath}" -e "console.log('space ü & pipe | literal')"`;

describe.skipIf(process.platform !== "win32")("Windows cmd command text serialization", () => {
  it("reproduces CRT argv escaping as unsuitable for cmd shell text", () => {
    const result = spawnSync("cmd.exe", ["/c", command], { encoding: "utf8", timeout: 3000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not recognized");
  });

  it("preserves a quoted executable and embedded operators with the supervisor strategy", () => {
    const { executable, args } = buildShellInvocation("cmd", command);
    const result = spawnSync(executable, [...args.slice(0, -1), `"${args.at(-1)}"`], {
      encoding: "utf8", timeout: 3000, windowsVerbatimArguments: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("space ü & pipe | literal");
  });

  it("preserves cmd pipelines and quoted ampersands with the supervisor strategy", () => {
    const { executable, args } = buildShellInvocation("cmd", 'echo "quoted & text" & echo second | findstr second');
    const result = spawnSync(executable, [...args.slice(0, -1), `"${args.at(-1)}"`], {
      encoding: "utf8", timeout: 3000, windowsVerbatimArguments: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"quoted & text"');
    expect(result.stdout).toContain("second");
  });

  it.each([false, true])("short commands preserve quoted executable shell text (streaming: %s)", async (streaming) => {
    const chunks: Buffer[] = [];
    const result = await runInSandbox({ command, cwd: process.cwd(), timeout: 3000,
      maxBuffer: 4096, forceBackend: "none", onOutput: streaming ? chunk => chunks.push(chunk) : undefined });
    expect(result.error).toBeNull();
    expect((streaming ? Buffer.concat(chunks).toString() : result.stdout).trim()).toBe("space ü & pipe | literal");
    expect(result.stderr).toBe("");
  });

  it.each([false, true])("short commands retain pipelines, redirection and literal metacharacters (streaming: %s)", async (streaming) => {
    const root = await mkdtemp(join(tmpdir(), "agav quoting "));
    try {
      const chunks: Buffer[] = [];
      const result = await runInSandbox({
        command: 'echo "literal & | < > ( ) spaces" > "output file.txt" & type "output file.txt" | findstr literal',
        cwd: root, timeout: 3000, maxBuffer: 4096, forceBackend: "none",
        onOutput: streaming ? chunk => chunks.push(chunk) : undefined,
      });
      expect(result.error).toBeNull();
      expect((streaming ? Buffer.concat(chunks).toString() : result.stdout).trim()).toBe('"literal & | < > ( ) spaces"');
      expect((await readFile(join(root, "output file.txt"), "utf8")).trim()).toBe('"literal & | < > ( ) spaces"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a batch shim in a spaced path without interpreting quoted argv as commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "agav quoting "));
    try {
      await writeFile(join(root, "shim file.cmd"), '@echo off\r\necho %1\r\n');
      const result = await runInSandbox({ command: '"shim file.cmd" "literal & echo INJECTED"',
        cwd: root, timeout: 3000, maxBuffer: 4096, forceBackend: "none" });
      expect(result.error).toBeNull();
      expect(result.stdout.trim()).toBe('"literal & echo INJECTED"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
