import { describe, expect, it } from "vitest";
import { execFile, type ExecFileException } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./helpers/workflows-cli-process.mjs", import.meta.url));

describe("workflow CLI process output", () => {
  it.each([["y\n", 0], ["n\n", 1]] as const)("drains piped launch output and preserves exit status (approval=%j)", async (approval, exitCode) => {
    const home = await mkdtemp(join(tmpdir(), "agav-workflow-output-"));
    const description = "buffered launch result ".repeat(100_000);
    try {
      await mkdir(join(home, ".agav"));
      await writeFile(join(home, ".agav", "config.json"), JSON.stringify({ workflowsEnabled: true, backgroundJobsEnabled: true }));
      const definition = { version: 1, name: "large-launch", description, nodes: [{ id: "job", type: "job", command: "echo hi" }] };
      const file = join(home, "workflow.json");
      await writeFile(file, JSON.stringify(definition));
      const { error, stdout, stderr } = await new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>(resolve => execFile(process.execPath, [
        "--experimental-test-module-mocks", "--import", "tsx", fixture, "workflows", "run", file, "--json",
      ], {
        env: { ...process.env, HOME: home, USERPROFILE: home, AGAV_HOME: join(home, ".agav"), NODE_NO_WARNINGS: "1", WORKFLOW_TEST_APPROVAL: approval },
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
      expect(error?.code ?? 0).toBe(exitCode);
      expect(stderr).toContain("Approve this background run?");
      if (exitCode === 0) {
        expect(stdout.length).toBeGreaterThan(description.length);
        expect(JSON.parse(stdout)).toMatchObject({ status: "started", run: { definition } });
      } else {
        expect(stdout).toBe("");
        expect(stderr).toContain("Workflow run not approved.");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
