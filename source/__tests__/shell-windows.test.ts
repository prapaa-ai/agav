import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInSandbox } from "../utils/sandbox.js";
import { shellTool } from "../tools/shell.js";

// Real cmd.exe parsing, not an argv mock. Fixtures require no npm downloads.
describe.skipIf(process.platform !== "win32")("Windows shell quoting", () => {
  let directory: string;
  let executable: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agav shell quoting "));
    executable = join(directory, "inspect args.cmd");
    await writeFile(executable, '@echo off\r\necho first=[%~1]\r\necho second=[%~2]\r\necho third=[%~3]\r\n');
  });
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function run(command: string, streaming: boolean) {
    const chunks: Buffer[] = [];
    const result = await runInSandbox({
      command, cwd: directory, timeout: 5000, maxBuffer: 40_000,
      ...(streaming ? { onOutput: (chunk: Buffer) => { chunks.push(chunk); } } : {}),
    });
    return { ...result, output: streaming ? Buffer.concat(chunks).toString() : result.stdout + result.stderr };
  }

  it.each([false, true])("preserves executable and argument quotes (streaming: %s)", async (streaming) => {
    const result = await run(`"${executable}" "argument with spaces" "" "C:\\output dir\\"`, streaming);
    expect(result.error).toBeNull();
    expect(result.output).toContain("first=[argument with spaces]");
    expect(result.output).toContain("second=[]");
    expect(result.output).toContain("third=[C:\\output dir\\]");
  });

  it.each([false, true])("preserves pipes, redirection and chaining (streaming: %s)", async (streaming) => {
    const result = await run(`"${executable}" "argument with spaces" | findstr first > "result file.txt" && type "result file.txt"`, streaming);
    expect(result.error).toBeNull();
    expect(result.output.trim()).toBe("first=[argument with spaces]");
  });

  it.each([false, true])("retains stderr and nonzero exit status (streaming: %s)", async (streaming) => {
    await writeFile(executable, "@echo off\r\necho fixture failure 1>&2\r\nexit /b 7\r\n");
    const result = await run(`"${executable}"`, streaming);
    expect(result.error?.message).toBe("Command exited with code 7");
    expect(result.output).toContain("fixture failure");
  });

  it("runs quoted batch paths through run_command", async () => {
    const result = await shellTool.execute({ command: `"${executable}" "argument with spaces"` });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("first=[argument with spaces]");
  });
});
