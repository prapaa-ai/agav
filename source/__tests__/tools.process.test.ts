import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBackgroundProcessOutputTail, processTool, refreshBackgroundProcessNotifications, resetBackgroundProcessesForTests, subscribeToProcessEvents } from "../tools/process.js";

function nodeCommand(source: string): string {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${encoded}', 'base64').toString())"`;
}

describe("process tool", () => {
  let jobsDir: string;
  const originalJobsDir = process.env["AGAV_BACKGROUND_PROCESS_DIR"];

  beforeEach(async () => {
    jobsDir = await mkdtemp(join(tmpdir(), "agav-process-jobs-"));
    process.env["AGAV_BACKGROUND_PROCESS_DIR"] = jobsDir;
  });

  afterEach(async () => {
    await resetBackgroundProcessesForTests();
    if (originalJobsDir === undefined) delete process.env["AGAV_BACKGROUND_PROCESS_DIR"];
    else process.env["AGAV_BACKGROUND_PROCESS_DIR"] = originalJobsDir;
    await rm(jobsDir, { recursive: true, force: true });
  });

  it("starts a daemon command without waiting for it to finish", async () => {
    const startedAt = Date.now();
    const result = await processTool.execute({
      action: "start",
      command: nodeCommand("setTimeout(() => { console.log('done'); }, 300)")
    });

    expect(result.isError).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result.output).toMatch(/Started daemon background process [a-f0-9-]{8}/);
    expect(result.output).toContain("will keep running after agav exits");
  });

  it("polls, waits, and returns captured logs after re-reading persisted state", async () => {
    const start = await processTool.execute({
      action: "start",
      command: nodeCommand("setTimeout(() => { console.log('finished-ok'); }, 20)")
    });
    const id = start.output.match(/process ([a-f0-9-]{8})/)?.[1];
    expect(id).toBeTruthy();

    const waited = await processTool.execute({ action: "wait", id, timeout_ms: 2000 });

    expect(waited.isError).toBe(false);
    expect(waited.output).toContain("exited 0");
    expect(waited.output).toContain("finished-ok");

    const listed = await processTool.execute({ action: "list" });
    expect(listed.output).toContain(id!);
    expect(listed.output).toContain("exited 0");
  });

  it("notifies subscribers for completed jobs found during reattach polling", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToProcessEvents(listener);

    const start = await processTool.execute({
      action: "start",
      command: nodeCommand("setTimeout(() => { console.log('notify-ok'); }, 20)")
    });
    const id = start.output.match(/process ([a-f0-9-]{8})/)?.[1];
    const waited = await processTool.execute({ action: "wait", id, timeout_ms: 2000 });
    expect(waited.isError).toBe(false);

    await refreshBackgroundProcessNotifications();

    expect(listener).toHaveBeenCalledTimes(1);
    const record = listener.mock.calls[0][0].record;
    expect(record.id).toBe(id);
    expect(getBackgroundProcessOutputTail(record, 3)).toContain("notify-ok");
    unsubscribe();
  });

  it("does not notify the same completed job twice", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToProcessEvents(listener);

    const start = await processTool.execute({
      action: "start",
      command: nodeCommand("console.log('once')")
    });
    const id = start.output.match(/process ([a-f0-9-]{8})/)?.[1];
    await processTool.execute({ action: "wait", id, timeout_ms: 2000 });

    await refreshBackgroundProcessNotifications();
    await refreshBackgroundProcessNotifications();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("blocks destructive commands at tool execution time", async () => {
    const result = await processTool.execute({ action: "start", command: "git reset --hard" });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("destructive command pattern");
  });
});
