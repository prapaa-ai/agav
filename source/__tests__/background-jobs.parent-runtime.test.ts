import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoordinator, type Coordinator } from "../background-jobs/coordinator/service.js";
import { __setSharedCoordinatorForTests } from "../background-jobs-integration.js";
import { ConfirmationQueue } from "../agent/confirmation-queue.js";
import { ConversationState } from "../agent/conversation.js";
import { runAgentLoop } from "../agent/loop.js";
import { createToolRegistry } from "../tools/registry-factory.js";
import { fixtureCommand, killWindowsFixtureSupervisor } from "./background-job-fixtures.js";

// Only config is substituted: no user config, default storage or existing jobs
// are touched. Coordinator, authorization, platform, IPC and runner are real.
vi.mock("../config/config.js", () => ({ loadConfig: async () => ({ backgroundJobsEnabled: true, permissionMode: "ask" }) }));
let root: string;
let coordinator: Coordinator;
let workloadDeadline = 0;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-parent-runtime-"));
  coordinator = await createCoordinator({ root });
  __setSharedCoordinatorForTests(coordinator);
  workloadDeadline = 0;
});
afterEach(async () => {
  // Fixtures are bounded: Windows stop does not prove descendants stopped.
  if (Date.now() < workloadDeadline) await new Promise(r => setTimeout(r, workloadDeadline - Date.now()));
  for (const job of await coordinator.repositories.jobs.list()) {
    if (process.platform === "win32") await killWindowsFixtureSupervisor(job.jobId);
    else await coordinator.cleanup(job.jobId, { permissionMode: "auto-accept", headlessApprovedActions: [] });
  }
  __setSharedCoordinatorForTests(null);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 20000);
async function parent(input: Record<string, unknown>, accept = true) {
  const queue = new ConfirmationQueue();
  const approvals: any[] = [];
  queue.bind(item => {
    if (item) { approvals.push(item.input); queueMicrotask(() => queue.resolve(accept ? "yes" : "no")); }
  });
  let turn = 0;
  const provider = { name: "fixture", async *stream() {
    if (turn++ === 0) {
      yield { type: "tool_call_start", toolCallId: "bg", toolName: "run_background_job" };
      yield { type: "tool_call_delta", toolCallId: "bg", argsJson: JSON.stringify(input) };
      yield { type: "tool_call_end", toolCallId: "bg" };
      yield { type: "message_end", stopReason: "tool_calls" };
    } else { yield { type: "text_delta", text: "done" }; yield { type: "message_end", stopReason: "end_turn" }; }
  } } as any;
  const conversation = new ConversationState(); conversation.addUserMessage("fixture background action");
  const events: any[] = [];
  // Deliberately no signal: reproduces the parent's dropped-policy bug.
  for await (const event of runAgentLoop({ provider, conversation, toolRegistry: createToolRegistry(), model: "fixture", permissionMode: "ask", confirmTool: (toolName, input) => queue.enqueue({ toolName, input }) })) events.push(event);
  const result = events.find(e => e.type === "tool_result");
  expect(result).toBeDefined();
  return { result, approvals };
}
function jobId(output: string) {
  const id = /Started background job (\S+) /.exec(output)?.[1];
  expect(id, output).toBeTruthy(); return id!;
}
describe("real parent background execution", () => {
  it("rejects without launching, then approves exact normalized spec and launches/logs/waits", async () => {
    const command = fixtureCommand("parent-runtime-marker", 200);
    const denied = await parent({ action: "start", command }, false);
    expect(denied.result.isError).toBe(true);
    expect(await coordinator.repositories.jobs.list()).toHaveLength(0);
    const started = await parent({ action: "start", command });
    expect(started.result.isError, started.result.output).toBe(false);
    expect(started.approvals).toHaveLength(1);
    expect(started.approvals[0].spec.isolation).toEqual({ backend: "none", required: false });
    expect(started.approvals[0].spec.ownershipScope).toBe(process.platform === "win32" ? "unverified" : "process-group");
    const id = jobId(started.result.output);
    const waited = await parent({ action: "wait", jobId: id });
    expect(waited.result.isError, waited.result.output).toBe(false);
    expect(waited.result.output).toContain("state: completed");
    expect(waited.approvals).toHaveLength(0);
    const logged = await parent({ action: "log", jobId: id });
    expect(logged.result.output).toContain("parent-runtime-marker");
    const grants = await coordinator.authorization.authorize("start", started.approvals[0].spec, { permissionMode: "ask", headlessApprovedActions: [] });
    expect(grants.allowed).toBe(true);
    const changed = await coordinator.authorization.authorize("start", { ...started.approvals[0].spec, cwd: "changed" }, { permissionMode: "ask", headlessApprovedActions: [] });
    expect(changed.allowed).toBe(false);
    console.log("REAL_PARENT_RUNTIME", JSON.stringify({ platform: process.platform, start: started.result.output, wait: waited.result.output, log: logged.result.output, ownership: started.approvals[0].spec.ownershipScope }));
  }, 20000);
  it("approves stop separately and reports Windows uncertainty honestly", async () => {
    workloadDeadline = Date.now() + 7000;
    const started = await parent({ action: "start", command: fixtureCommand("bounded-stop-fixture", 4000) });
    expect(started.result.isError, started.result.output).toBe(false);
    const id = jobId(started.result.output);
    const stopped = await parent({ action: "stop", jobId: id });
    expect(stopped.result.isError, stopped.result.output).toBe(false);
    expect(stopped.approvals).toHaveLength(1);
    expect(stopped.approvals[0].action).toBe("stop");
    const polled = await parent({ action: "poll", jobId: id });
    expect(polled.result.output).toContain(process.platform === "win32" ? "state: unknown" : "state: interrupted");
    if (process.platform === "win32") {
      expect(polled.result.output).toContain("stopState: acknowledged");
      expect(polled.result.output).not.toContain("stopState: observed-stopped");
    }
    console.log("REAL_PARENT_STOP", JSON.stringify({ platform: process.platform, stop: stopped.result.output, poll: polled.result.output }));
  }, 20000);
});
