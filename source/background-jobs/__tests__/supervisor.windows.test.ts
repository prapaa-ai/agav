import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { JobSupervisor } from "../supervisor/lifecycle.js";
import { createFileRepositories } from "../storage/repositories.js";
import { resolveStorageRoot } from "../storage/paths.js";
import { getSocketPath } from "../ipc/socket-path.js";
import { getPlatformAdapter } from "../platform/index.js";
import { IpcClient } from "../ipc/client.js";
import { isTerminalLifecycle, type InvocationSpec as Invocation, type JobRecord, type LaunchSpec } from "../types.js";

async function withJob(invocation: Invocation, body: (ctx: {
  client: IpcClient; spec: LaunchSpec; job: () => Promise<JobRecord | undefined>;
}) => Promise<void>, prepare?: (cwd: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "agav-supervisor-windows-"));
  const cwd = join(base, "cwd with spaces ü");
  await mkdir(cwd);
  await prepare?.(cwd);
  const root = await resolveStorageRoot(join(base, "state"));
  const repositories = createFileRepositories(root);
  const jobId = randomUUID();
  const requestId = randomUUID();
  const adapter = await getPlatformAdapter();
  const caps = await adapter.detectCapabilities();
  const spec: LaunchSpec = {
    requestId, invocation, cwd, env: { ...process.env } as Record<string, string>,
    credentialRefs: [], isolation: { backend: "none", required: false },
    ownershipScope: caps.strongestOwnershipScope,
    limits: { logSegmentBytes: 1024 * 1024, retainedLogBytesPerJob: 2 * 1024 * 1024,
      aggregatePerUserLogBudgetBytes: 10 * 1024 * 1024, maxConcurrentJobs: 4, completedLogRetentionDays: 7 },
    headless: false, createdAt: new Date().toISOString(),
  };
  await repositories.specs.put(spec);
  await repositories.jobs.create({ jobId, requestId, specHash: "test", protocolVersion: 1,
    state: "accepted", stopState: "none", nonce: randomUUID() });
  const socketPath = getSocketPath(root, `job-${jobId}`);
  const supervisor = new JobSupervisor({ jobId, requestId, repositories, root, socketPath, stopGraceMs: 1000 });
  let client: IpcClient | undefined;
  try {
    await supervisor.start(spec);
    client = await IpcClient.connectWithRetry(socketPath, { retries: 30, delayMs: 50 });
    await body({ client, spec, job: () => repositories.jobs.get(jobId) });
  } finally {
    await client?.close();
    // Fixtures are self-bounded; even a failed stop cannot leave work running.
    await supervisor.requestStop("test cleanup").catch(() => {});
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const job = await repositories.jobs.get(jobId);
      if (job && isTerminalLifecycle(job.state)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await supervisor.shutdown();
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    delete process.env.AGAV_CMD_TEST;
  }
}

async function waitTerminal(client: IpcClient): Promise<JobRecord | undefined> {
  const reply = await client.request({ type: "wait" }, 8000) as { job?: JobRecord };
  return reply.job;
}

// Portable fixture also checks that the POSIX process-group contract is retained.
describe("supervisor platform ownership", () => {
  it("preserves direct argv and UTF-8 output for a fast successful workload", async () => {
    await withJob({ mode: "direct", executable: process.execPath,
      args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "space ü & | % ! \\"] }, async ({ client }) => {
      expect((await waitTerminal(client))?.state).toBe("completed");
      const log = await client.request({ type: "log", maxBytes: 4096 }) as { text: string };
      expect(JSON.parse(log.text)).toEqual(["space ü & | % ! \\"]);
    });
  }, 15000);

  it("does not classify natural Windows exit code 1 as a requested interruption", async () => {
    await withJob({ mode: "direct", executable: process.execPath, args: ["-e", "process.exit(1)"] }, async ({ client }) => {
      const final = await waitTerminal(client);
      expect(final?.state).toBe("failed");
      expect(final?.exitCode).toBe(1);
      expect(final?.stopState).toBe("none");
    });
  }, 15000);
  it("persists the approved scope and stops the actual workload through IPC", async () => {
    await withJob({ mode: "direct", executable: process.execPath,
      args: ["-e", 'console.log("ready"); setTimeout(() => {}, 4000)'] }, async ({ client, spec, job }) => {
      expect((await job())?.ownershipScope).toBe(spec.ownershipScope);
      if (process.platform === "win32") expect((await job())?.identity?.creationIdentity).toBe("unavailable");
      const reply = await client.request({ type: "stop" }) as { type: string };
      expect(reply.type).toBe("stop");
      const final = await waitTerminal(client);
      expect(final?.state).toBe("interrupted");
      expect((await job())?.stopState).toBe("observed-stopped");
      expect(final?.resultEventId).toBeDefined();
    });
  }, 15000);
});

describe.skipIf(process.platform !== "win32")("actual Windows shell invocation", () => {
  it("preserves cmd quotes, spaces, Unicode, operators and environment expansion", async () => {
    await withJob({ mode: "shell", interpreter: "cmd",
      commandText: 'echo "quoted & text" & echo %AGAV_CMD_TEST% | findstr expanded' }, async ({ client }) => {
      const final = await waitTerminal(client);
      expect(final?.state).toBe("completed");
      const log = await client.request({ type: "log", maxBytes: 4096 }) as { text: string };
      expect(log.text).toContain('"quoted & text"');
      expect(log.text).toContain("expanded");
    }, async () => { process.env.AGAV_CMD_TEST = "expanded"; });
  }, 15000);

  it("executes an explicitly selected cmd batch shim in a path with spaces", async () => {
    await withJob({ mode: "shell", interpreter: "cmd", commandText: '".\\batch shim.cmd" "arg with spaces"' }, async ({ client }) => {
      expect((await waitTerminal(client))?.state).toBe("completed");
      const log = await client.request({ type: "log", maxBytes: 4096 }) as { text: string };
      expect(log.text).toContain("arg with spaces");
    }, async cwd => { await writeFile(join(cwd, "batch shim.cmd"), "@echo off\r\necho %~1\r\n"); });
  }, 15000);

  it("preserves PowerShell quoted command text", async () => {
    await withJob({ mode: "shell", interpreter: "powershell", commandText: '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Write-Output "ps ü & quoted"' }, async ({ client }) => {
      expect((await waitTerminal(client))?.state).toBe("completed");
      const log = await client.request({ type: "log", maxBytes: 4096 }) as { text: string };
      expect(log.text).toContain("ps ü & quoted");
    });
  }, 15000);
});
