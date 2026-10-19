/**
 * WP-05 (0.4 + 0.9): `stream` / `tail` plumbing for the `run_background_job`
 * tool's `log` action and the `/job log` slash command.
 *
 * The fake coordinator's `log()` runs the same branching that
 * `coordinator/service.ts` (on-disk fallback) and `supervisor/lifecycle.ts`
 * (live IPC handler) use. It calls `readCursor` (first 64 KiB) when
 * `maxBytes` is absent and `readTail` otherwise, over real segment files. So
 * these tests cover what reaches `coordinator.log` and what comes back.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SegmentedLogWriter } from "../logging/segment-writer.js";
import { readCursor, readTail } from "../logging/segment-reader.js";
import type { LogTail } from "../types.js";

vi.mock("../../config/config.js", () => ({
  loadConfig: async () => ({ backgroundJobsEnabled: true, permissionMode: "auto-accept" }),
}));

const { backgroundJobTool } = await import("../../tools/background-job.js");
const { jobCommand } = await import("../../commands/job.js");
const { __setSharedCoordinatorForTests } = await import("../../background-jobs-integration.js");

type LogOpts = { maxBytes?: number; cursor?: string; stream?: "stdout" | "stderr" };

let dir: string;
let logCalls: Array<{ jobId: string; opts: LogOpts | undefined }>;

function fakeCoordinator() {
  return {
    async log(jobId: string, opts?: LogOpts): Promise<LogTail> {
      logCalls.push({ jobId, opts });
      const stream = opts?.stream ?? "stdout";
      if (opts?.cursor !== undefined || opts?.maxBytes === undefined) {
        return readCursor(dir, stream, opts?.cursor, opts?.maxBytes);
      }
      const result = await readTail(dir, stream, opts.maxBytes);
      return { ...result, cursor: "" };
    },
  };
}

async function writeStream(stream: "stdout" | "stderr", text: string): Promise<void> {
  const writer = new SegmentedLogWriter(dir, { segmentBytes: 1_000_000, retainedBytesPerJob: 10_000_000, onFailure: () => {} });
  await writer.init();
  await writer.write(stream, Buffer.from(text, "utf8"));
  await writer.close();
}

function commandContext(): any {
  return { config: { permissionMode: "auto-accept", backgroundJobsEnabled: true } };
}

async function runSlash(args: string): Promise<string> {
  const result = await jobCommand.execute(args, commandContext());
  expect(result.type).toBe("message");
  return result.type === "message" ? result.text : "";
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agav-bg-log-stream-tail-"));
  logCalls = [];
  __setSharedCoordinatorForTests(fakeCoordinator() as any);
});

afterEach(async () => {
  __setSharedCoordinatorForTests(null);
  await rm(dir, { recursive: true, force: true });
});

describe("run_background_job action=log", () => {
  it("advertises stream and tail additively in the schema", () => {
    const props = backgroundJobTool.schema.inputSchema.properties as Record<string, any>;
    expect(props.stream).toMatchObject({ type: "string", enum: ["stdout", "stderr"] });
    expect(props.tail).toMatchObject({ type: "number" });
    expect(props.maxBytes).toBeDefined();
    expect(backgroundJobTool.schema.inputSchema.required).toEqual(["action"]);
  });

  it("defaults to stdout from the start (no maxBytes, so first 64 KiB)", async () => {
    await writeStream("stdout", "out-line-1\nout-line-2\n");
    await writeStream("stderr", "err-line\n");
    const result = await backgroundJobTool.execute({ action: "log", jobId: "job-1" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("out-line-1\nout-line-2\n");
    expect(logCalls).toEqual([{ jobId: "job-1", opts: { maxBytes: undefined, stream: "stdout" } }]);
  });

  it("keeps the current first-64-KiB default when tail is absent", async () => {
    await writeStream("stdout", "A".repeat(64 * 1024) + "TAIL-END");
    const result = await backgroundJobTool.execute({ action: "log", jobId: "job-1" });
    expect(result.output.startsWith("AAAA")).toBe(true);
    expect(result.output).not.toContain("TAIL-END");
    expect(result.output).toContain("[output truncated]");
  });

  it("reads stderr when stream=stderr", async () => {
    await writeStream("stdout", "out\n");
    await writeStream("stderr", "boom on stderr\n");
    const result = await backgroundJobTool.execute({ action: "log", jobId: "job-1", stream: "stderr" });
    expect(result.output).toBe("boom on stderr\n");
    expect(logCalls[0]!.opts).toEqual({ maxBytes: undefined, stream: "stderr" });
  });

  it("tail smaller than the stream returns only the last N bytes, marked truncated", async () => {
    await writeStream("stdout", "0123456789");
    const result = await backgroundJobTool.execute({ action: "log", jobId: "job-1", tail: 4 });
    expect(result.output).toBe("6789\n[output truncated]");
    expect(logCalls[0]!.opts).toEqual({ maxBytes: 4, stream: "stdout" });
  });

  it("tail larger than the stream returns everything, not truncated", async () => {
    await writeStream("stderr", "short");
    const result = await backgroundJobTool.execute({ action: "log", jobId: "job-1", stream: "stderr", tail: 1000 });
    expect(result.output).toBe("short");
    expect(logCalls[0]!.opts).toEqual({ maxBytes: 1000, stream: "stderr" });
  });

  it("missing stderr file gives empty output with a note", async () => {
    await writeStream("stdout", "only stdout\n");
    const result = await backgroundJobTool.execute({ action: "log", jobId: "job-1", stream: "stderr" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("(no stderr output captured)");
  });

  it("keeps maxBytes as a deprecated alias of tail; tail wins when both are given", async () => {
    await writeStream("stdout", "0123456789");
    await backgroundJobTool.execute({ action: "log", jobId: "job-1", maxBytes: 3 });
    await backgroundJobTool.execute({ action: "log", jobId: "job-1", maxBytes: 3, tail: 5 });
    expect(logCalls.map((c) => c.opts)).toEqual([
      { maxBytes: 3, stream: "stdout" },
      { maxBytes: 5, stream: "stdout" },
    ]);
  });

  it("rejects an invalid stream or tail without calling the coordinator", async () => {
    const badStream = await backgroundJobTool.execute({ action: "log", jobId: "job-1", stream: "both" });
    const badTail = await backgroundJobTool.execute({ action: "log", jobId: "job-1", tail: -1 });
    expect(badStream.isError).toBe(true);
    expect(badTail.isError).toBe(true);
    expect(logCalls).toHaveLength(0);
  });
});

describe("/job log", () => {
  it("defaults to stdout from the start", async () => {
    await writeStream("stdout", "hello\n");
    expect(await runSlash("log job-1")).toBe("hello\n");
    expect(logCalls).toEqual([{ jobId: "job-1", opts: { maxBytes: undefined, stream: "stdout" } }]);
  });

  it("--stderr --tail N passes { stream, maxBytes } to coordinator.log", async () => {
    await writeStream("stderr", "abcdefghij");
    expect(await runSlash("log job-1 --stderr --tail 3")).toBe("hij\n[output truncated]");
    expect(logCalls[0]!.opts).toEqual({ maxBytes: 3, stream: "stderr" });
  });

  it("accepts --tail=N and a tail larger than the stream", async () => {
    await writeStream("stdout", "tiny");
    expect(await runSlash("log job-1 --tail=500")).toBe("tiny");
    expect(logCalls[0]!.opts).toEqual({ maxBytes: 500, stream: "stdout" });
  });

  it("missing stderr gives a note", async () => {
    expect(await runSlash("log job-1 --stderr")).toBe("(no stderr output captured)");
  });

  it("still accepts the legacy positional maxBytes", async () => {
    await writeStream("stdout", "0123456789");
    expect(await runSlash("log job-1 2")).toBe("89\n[output truncated]");
    expect(logCalls[0]!.opts).toEqual({ maxBytes: 2, stream: "stdout" });
  });

  it("rejects a bad --tail or unknown flag with usage, without calling the coordinator", async () => {
    expect(await runSlash("log job-1 --tail")).toContain("Usage: /job log <id> [--stderr] [--tail N]");
    expect(await runSlash("log job-1 --tail 0")).toContain("--tail needs a positive whole number");
    expect(await runSlash("log job-1 --bogus")).toContain('Unknown option "--bogus"');
    expect(logCalls).toHaveLength(0);
  });
});

describe("help text (0.9)", () => {
  it("no longer claims that nothing triggers schedules", async () => {
    expect(backgroundJobTool.schema.description).not.toContain("no periodic timer");
    expect(backgroundJobTool.schema.description).toContain("only while an interactive agav session");
    expect(jobCommand.usage).not.toContain("no periodic timer");
    expect(jobCommand.usage).toContain("only while an interactive agav session");
    expect(jobCommand.usage).toContain("/job log <id> [--stderr] [--tail N]");
  });
});
