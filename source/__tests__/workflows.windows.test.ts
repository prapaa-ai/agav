import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { killWindowsFixtureSupervisor } from "./background-job-fixtures.js";

// Like the jobs integration tests, this needs pnpm build first: real detached
// supervisors must load compiled entry.js, not Vitest-transformed sources.
describe.skipIf(process.platform !== "win32")("Windows workflow program", () => {
  it("runs a consented supervised runner, cmd job and shell tool in an isolated profile", async () => {
    const home = await mkdtemp(join(tmpdir(), "agav workflow ü "));
    const work = join(home, "work with spaces");
    const data = join(home, ".agav");
    await mkdir(work); await mkdir(data);
    await writeFile(join(data, "config.json"), JSON.stringify({ backgroundJobsEnabled: true, workflowsEnabled: true, permissionMode: "auto-accept" }));
    await writeFile(join(work, "workflow.json"), JSON.stringify({ version: 1, name: "windows-smoke", nodes: [
      { id: "job", type: "job", command: "echo windows-job-ok" },
      { id: "shell", type: "tool", tool: "run_command", input: { command: "echo windows-shell-ok" }, dependsOn: ["job"] },
    ] }));
    const cliModule = new URL("../../build/cli/workflows-cli.js", import.meta.url).href;
    const cliPath = fileURLToPath(new URL("../../build/cli.js", import.meta.url));
    const code = [
      "import { PassThrough } from 'node:stream';",
      "const { runWorkflowsCli } = await import(" + JSON.stringify(cliModule) + ");",
      "const input = Object.assign(new PassThrough(), { isTTY: true }); input.end(" + JSON.stringify("y\n") + ");",
      "const output = Object.assign(new PassThrough(), { isTTY: true }); output.on('data', function(chunk) { process.stdout.write(chunk); });",
      "process.exitCode = await runWorkflowsCli(['run', 'workflow.json', '--wait'], { stdin: input, stdout: output, env: {}, cliPath: " + JSON.stringify(cliPath) + ", pollIntervalMs: 100 });",
    ].join("\n");
    try {
      const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { cwd: work, env: { ...process.env, USERPROFILE: home, HOME: home }, timeout: 30000 }).catch(error => { throw new Error(String(error.stdout) + String(error.stderr)); });
      expect(result.stderr).toContain("unsandboxed");
      expect(result.stderr).toContain("Docker");
      expect(result.stdout).toContain("job: passed");
      expect(result.stdout).toContain("shell: passed");
      const runs = join(data, "workflow-runs");
      const ids = await readdir(runs);
      const id = ids.find(name => /^[a-f0-9-]{36}\.json$/.test(name));
      expect(id).toBeDefined();
      const checkpoint = JSON.parse(await readFile(join(runs, id!), "utf8"));
      expect(checkpoint.status).toBe("passed");
      expect(checkpoint.nodes[0].output).toContain("windows-job-ok");
      expect(checkpoint.nodes[1].output).toContain("windows-shell-ok");
    } finally {
      const jobs = await readdir(join(data, "background-jobs", "jobs")).catch(() => []);
      for (const id of jobs) if (/^[a-f0-9-]{36}$/.test(id)) await killWindowsFixtureSupervisor(id);
      await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 45000);
});
