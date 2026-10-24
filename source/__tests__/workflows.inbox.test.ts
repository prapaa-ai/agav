import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { readdir } from "node:fs/promises";
import { runWorkflowsCli } from "../cli/workflows-cli.js";
import { inboxLines } from "../workflows/background.js";
import { listPendingDecisions } from "../workflows/decisions.js";
import { claimUnseenNotifications, mailboxDir, notificationFor, postRunNotification } from "../workflows/notify.js";
import { createRun, executeRun } from "../workflows/runtime.js";
import { startRunner } from "../workflows/runner.js";
import { buildConsent } from "../workflows/grant.js";
import { WorkflowStore } from "../workflows/store.js";
import { cancelRun } from "../workflows/control.js";
import { createPendingDecision, decide, readDecision } from "../workflows/decisions.js";
import { def, fakeHost, FakeCoordinator, registry, tempStore, testConfig } from "./helpers/workflow-fixtures.js";

let store: WorkflowStore, cleanup: () => Promise<void>;
beforeEach(async () => { ({ store, cleanup } = await tempStore()); });
afterEach(async () => { vi.restoreAllMocks(); await cleanup(); });

const gated = def([{ id: "gate", type: "approval", prompt: "deploy?" }]);

function sink(): PassThrough & { text: () => string } {
  const stream = new PassThrough() as PassThrough & { text: () => string };
  let text = "";
  stream.on("data", chunk => { text += String(chunk); });
  stream.text = () => text;
  return stream;
}

describe("inbox", () => {
  it("lists pending decisions concisely, across runs or for one run", async () => {
    const a = await createRun(store, gated, {});
    const b = await createRun(store, def([{ id: "other", type: "approval", prompt: "ok?" }]), {});
    await executeRun(store, a.id, registry, testConfig(), undefined, fakeHost());
    await executeRun(store, b.id, registry, testConfig(), undefined, fakeHost());
    const all = await inboxLines(store);
    expect(all).toHaveLength(2);
    expect(all.join("\n")).toMatch(new RegExp(`◐ ${a.id.slice(0, 8)}\\s+dec_[a-f0-9]{16}\\s+approval\\s+gate\\s+deploy\\?`));
    expect(await inboxLines(store, b.id)).toHaveLength(1);
  });

  it("CLI inbox, then approve <run> <node> --note, writes one decision; a second approve loses", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const run = await createRun(store, gated, {});
    await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    const opts = { config: testConfig(), store, getCoordinator: async () => new FakeCoordinator(), cliPath: "/x/cli.js" };
    const inbox = sink();
    expect(await runWorkflowsCli(["inbox"], { ...opts, stdout: inbox })).toBe(0);
    expect(inbox.text()).toContain("approval");
    const out = sink();
    expect(await runWorkflowsCli(["approve", run.id, "gate", "--note", "ship", "it"], { ...opts, stdout: out })).toBe(0);
    expect(out.text()).toMatch(/approval on gate approved/);
    expect(await listPendingDecisions(store)).toHaveLength(0);
    const decisionId = (await readdir(`${store.runDir(run.id)}/decisions`)).find(name => name.endsWith(".decided.json"))!.replace(".decided.json", "");
    const late = sink();
    expect(await runWorkflowsCli(["deny", run.id, decisionId], { ...opts, stdout: late })).toBe(1);
    expect(late.text()).toMatch(/already approved/);
    const empty = sink();
    await runWorkflowsCli(["inbox", run.id], { ...opts, stdout: empty });
    expect(empty.text()).toContain("No pending workflow decisions.");
    // The run itself was never written by the decider.
    expect((await store.read(run.id, registry)).nodes[0]).toMatchObject({ status: "waiting_approval" });
    const done = await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    expect(done.nodes[0]).toMatchObject({ status: "passed", decision: { note: "ship it" } });
  });
});

describe("notifications", () => {
  it("formats waiting and terminal notifications with the short run id", async () => {
    const run = await createRun(store, gated, {});
    const parked = await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    expect(notificationFor(parked)?.text).toBe(`Run ${run.id.slice(0, 8)} waiting for approval: gate`);
    expect(notificationFor({ ...parked, status: "passed" })?.text).toBe(`Run ${run.id.slice(0, 8)} passed`);
    expect(notificationFor({ ...parked, status: "running" })).toBeUndefined();
  });

  it("the runner posts a waiting notification that is shown exactly once across sessions", async () => {
    const run = await createRun(store, gated, {}, { host: "background" });
    run.consent = buildConsent(gated, run.cwd, "ask", []);
    await store.lock(run.id, () => store.save(run));
    const parked = await startRunner(run.id, { store, registry, config: testConfig({ permissionMode: "ask" }), getCoordinator: async () => new FakeCoordinator() }).done;
    expect(parked.status).toBe("waiting_approval");
    await postRunNotification(store, parked); // a duplicate post is a no-op (create-once)
    expect((await readdir(mailboxDir(store))).filter(name => name.endsWith(".json"))).toHaveLength(1);
    const first = await claimUnseenNotifications(store, "session-a");
    expect(first.map(item => item.text)).toEqual([`Run ${run.id.slice(0, 8)} waiting for approval: gate`]);
    expect(await claimUnseenNotifications(store, "session-a")).toEqual([]);
    expect(await claimUnseenNotifications(store, "session-b")).toEqual([]);
    // A later status is a new notification.
    await postRunNotification(store, { ...parked, status: "passed" });
    expect((await claimUnseenNotifications(store, "session-b")).map(item => item.kind)).toEqual(["passed"]);
  });

  it("concurrent sessions never both claim the same notification", async () => {
    const run = await createRun(store, gated, {});
    await postRunNotification(store, { ...(await store.read(run.id, registry)), status: "failed" });
    const [a, b] = await Promise.all([claimUnseenNotifications(store, "a"), claimUnseenNotifications(store, "b")]);
    expect(a.length + b.length).toBe(1);
  });

  it("the resumed runner posts its terminal notification once", async () => {
    const run = await createRun(store, gated, {}, { host: "background" });
    run.consent = buildConsent(gated, run.cwd, "ask", []);
    await store.lock(run.id, () => store.save(run));
    const ctx = { store, registry, config: testConfig({ permissionMode: "ask" }), getCoordinator: async () => new FakeCoordinator() };
    await startRunner(run.id, ctx).done;
    const [pending] = await listPendingDecisions(store, run.id);
    await decide(store, run.id, pending!.decisionId, true, "u@h");
    expect((await startRunner(run.id, ctx).done).status).toBe("passed");
    expect((await startRunner(run.id, ctx).done).status).toBe("passed"); // a re-run of a terminal run posts nothing new
    const shown = await claimUnseenNotifications(store, "s");
    expect(shown.map(item => item.text)).toEqual([`Run ${run.id.slice(0, 8)} waiting for approval: gate`, `Run ${run.id.slice(0, 8)} passed`]);
    expect(await claimUnseenNotifications(store, "s2")).toEqual([]);
  });

  it("cancelling a parked run (no runner) posts a cancelled notification", async () => {
    const run = await createRun(store, gated, {});
    await executeRun(store, run.id, registry, testConfig(), undefined, fakeHost());
    expect((await cancelRun(store, run.id, registry)).status).toBe("cancelled");
    expect((await claimUnseenNotifications(store, "s")).map(item => item.kind)).toEqual(["cancelled"]);
  });
});

describe("agent_tool_consent records", () => {
  it("round-trips and is decided once", async () => {
    const run = await createRun(store, gated, {});
    const pending = await createPendingDecision(store, run.id, { kind: "agent_tool_consent", nodeId: "gate", summary: "agent wants shell", resolved: { toolName: "shell", input: { command: "ls" }, inputHash: "x" } });
    expect((await readDecision(store, run.id, pending.decisionId))?.pending.kind).toBe("agent_tool_consent");
    expect((await decide(store, run.id, pending.decisionId, true, "a")).won).toBe(true);
    expect((await decide(store, run.id, pending.decisionId, false, "b"))).toMatchObject({ won: false, record: { decision: "approve", decidedBy: "a" } });
  });
});
