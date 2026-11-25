import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { buildSandboxedCommand } from "../utils/sandbox.js";
import { testRunnerTool } from "../tools/test-runner.js";

vi.mock("../utils/sandbox.js", async importOriginal => ({
  ...await importOriginal<typeof import("../utils/sandbox.js")>(),
  buildSandboxedCommand: vi.fn(),
}));

it.skipIf(process.platform === "win32")("times out a test runner and stops its SIGTERM-resistant descendant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agav-test-timeout-"));
  const heartbeat = join(dir, "heartbeat");
  const child = `
    const { appendFileSync } = require('node:fs');
    process.on('SIGTERM', () => {});
    appendFileSync(process.argv[1], '.');
    console.log(' Tests  2 passed (2)');
    setInterval(() => appendFileSync(process.argv[1], '.'), 20);
    setTimeout(() => process.exit(0), 5000);
  `;
  const runner = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(child)}, process.argv[1]], { stdio: 'inherit' });
  `;
  const cleanup = vi.fn();
  const publish = vi.fn();
  vi.mocked(buildSandboxedCommand).mockReturnValue({
    file: process.execPath, args: ["-e", runner, heartbeat], env: {}, backend: "none", cleanup, publish,
  });
  try {
    const result = await testRunnerTool.execute({ framework: "vitest", timeout_ms: 1000 });
    expect(result.output).toContain("timed out after 1000 ms");
    expect(result.verification).toMatchObject({ status: "failed", passed: 2, exitCode: null });
    expect(publish).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    const before = await readFile(heartbeat, "utf8");
    await delay(200);
    expect(await readFile(heartbeat, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 7000);
