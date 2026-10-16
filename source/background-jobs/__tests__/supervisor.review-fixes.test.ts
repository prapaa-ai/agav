import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { JobSupervisor } from "../supervisor/lifecycle.js";
import { SegmentedLogWriter } from "../logging/segment-writer.js";
import { createFileRepositories } from "../storage/repositories.js";
import { resolveStorageRoot } from "../storage/paths.js";
import { getSocketPath } from "../ipc/socket-path.js";
import { IpcClient } from "../ipc/client.js";
import type { LaunchSpec, JobRecord } from "../types.js";

async function fixture(body: (ctx: { supervisor: JobSupervisor; spec: LaunchSpec; socket: string; job: () => Promise<JobRecord | undefined>; base: string }) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "agav-review-fix-"));
  const root = await resolveStorageRoot(join(base, "state"));
  const repositories = createFileRepositories(root);
  const jobId = randomUUID(), requestId = randomUUID();
  const spec: LaunchSpec = {
    requestId, invocation: { mode: "direct", executable: process.execPath, args: ["-e", 'console.log("ready"); setTimeout(() => {}, 1500)'] },
    cwd: base, env: { ...process.env } as Record<string, string>, credentialRefs: [],
    isolation: { backend: "none", required: false }, ownershipScope: process.platform === "win32" ? "unverified" : "process-group",
    limits: { logSegmentBytes: 1024, retainedLogBytesPerJob: 4096, aggregatePerUserLogBudgetBytes: 16384, maxConcurrentJobs: 4, completedLogRetentionDays: 7 },
    headless: false, createdAt: new Date().toISOString(),
  };
  await repositories.specs.put(spec);
  await repositories.jobs.create({ jobId, requestId, specHash: "test", protocolVersion: 1, state: "accepted", stopState: "none", nonce: randomUUID() });
  const socket = getSocketPath(root, `job-${jobId}`);
  const supervisor = new JobSupervisor({ jobId, requestId, root, repositories, socketPath: socket, stopGraceMs: 300, logOperationTimeoutMs: 100 } as ConstructorParameters<typeof JobSupervisor>[0]);
  try { await body({ supervisor, spec, socket, job: () => repositories.jobs.get(jobId), base }); }
  finally {
    vi.restoreAllMocks();
    await supervisor.requestStop("fixture cleanup");
    await new Promise(resolve => setTimeout(resolve, 1800));
    await supervisor.shutdown();
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

async function until(job: () => Promise<JobRecord | undefined>, predicate: (record: JobRecord | undefined) => boolean, budget = 900) {
  const deadline = Date.now() + budget;
  let record;
  do { record = await job(); if (predicate(record)) return record; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline);
  return record;
}

describe("review lifecycle regressions", () => {
  it("executes a stop accepted over IPC during writer initialization exactly once", async () => {
    await fixture(async ({ supervisor, spec, socket, job }) => {
      const init = SegmentedLogWriter.prototype.init;
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(SegmentedLogWriter.prototype, "init").mockImplementation(async function (this: SegmentedLogWriter) { await barrier; await init.call(this); });
      const started = supervisor.start(spec);
      const client = await IpcClient.connectWithRetry(socket, { retries: 30, delayMs: 20 });
      try {
        expect((await job())?.state).toBe("starting");
        await client.request({ type: "stop" });
        expect((await job())?.stopState).toBe("requested");
        release();
        await started;
        await client.request({ type: "stop" });
        const final = await until(job, record => record?.state === "interrupted");
        expect(final?.state).toBe("interrupted");
        expect(final?.resultEventId).toBeDefined();
      } finally { release(); await started; await client.close(); }
    });
  }, 10000);

  it("retires a stalled log writer, drains/discards, and publishes an observed result within a bound", async () => {
    await fixture(async ({ supervisor, spec, job }) => {
      const write = vi.spyOn(SegmentedLogWriter.prototype, "write").mockImplementation(() => new Promise<void>(() => {}));
      await supervisor.start(spec);
      const final = await until(job, record => record?.state === "interrupted");
      expect(final?.state).toBe("interrupted");
      expect(final?.uncertaintyReason).toMatch(/logging.*(timed out|stall).*discard/i);
      expect(final?.resultEventId).toBeDefined();
      expect(write).toHaveBeenCalledTimes(1);
    });
  }, 10000);

  it("handles a rejected log write without poisoning final publication or leaking an unhandled rejection", async () => {
    await fixture(async ({ supervisor, spec, job }) => {
      vi.spyOn(SegmentedLogWriter.prototype, "write").mockRejectedValue(new Error("injected write failure"));
      await supervisor.start(spec);
      const final = await until(job, record => record?.state === "interrupted");
      expect(final?.state).toBe("interrupted");
      expect(final?.uncertaintyReason).toMatch(/logging.*injected write failure.*discard/i);
      expect(final?.resultEventId).toBeDefined();
    });
  }, 10000);

  it("shutdown drains final publication, not only the job update chain", async () => {
    await fixture(async ({ supervisor, spec, job }) => {
      const write = SegmentedLogWriter.prototype.write;
      let entered!: () => void;
      const writing = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(SegmentedLogWriter.prototype, "write").mockImplementation(async function (this: SegmentedLogWriter, stream, chunk) {
        entered();
        await barrier;
        await write.call(this, stream, chunk);
      });
      spec.invocation = { mode: "direct", executable: process.execPath, args: ["-e", 'console.log("final-output")'] };
      await supervisor.start(spec);
      await writing;
      let drained = false;
      const shutdown = supervisor.shutdown().then(() => { drained = true; });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(drained).toBe(false);
      release();
      await shutdown;
      expect((await job())?.state).toBe("completed");
      expect((await job())?.resultEventId).toBeDefined();
    });
  }, 10000);

  it.skipIf(process.platform !== "win32")("does not claim a stopped workload tree while a shell descendant still writes its activity marker", async () => {
    await fixture(async ({ supervisor, spec, socket, job, base }) => {
      const marker = join(base, "activity.txt");
      const code = `const fs=require('fs'); const t=setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),40); setTimeout(()=>{clearInterval(t)},1200)`;
      spec.invocation = { mode: "shell", interpreter: "cmd", commandText: `"${process.execPath}" -e "${code.replaceAll('"', '\\"')}"` };
      await supervisor.start(spec);
      const deadline = Date.now() + 700;
      let before = "";
      while (!before && Date.now() < deadline) { before = await readFile(marker, "utf8").catch(() => ""); await new Promise(resolve => setTimeout(resolve, 20)); }
      expect(before.length).toBeGreaterThan(0);
      const client = await IpcClient.connect(socket);
      try {
        const reply = await client.request({ type: "stop" }) as { job: JobRecord };
        await new Promise(resolve => setTimeout(resolve, 160));
        const after = await readFile(marker, "utf8");
        expect(after.length).toBeGreaterThan(before.length);
        expect(reply.job.stopState).not.toBe("observed-stopped");
        const current = await job();
        expect(current?.uncertaintyReason).toMatch(/child only.*descendant/i);
        expect(current?.state).toBe("unknown");
      } finally { await client.close(); }
    });
  }, 10000);
});
