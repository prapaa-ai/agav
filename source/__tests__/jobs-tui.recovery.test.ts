import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinator, type Coordinator } from "../background-jobs/coordinator/service.js";
import { IpcClient } from "../background-jobs/ipc/client.js";
import { jobPath } from "../background-jobs/storage/paths.js";
import type { SessionPolicySnapshot } from "../background-jobs/types.js";

const shared = vi.hoisted(() => ({ coordinator: undefined as Coordinator | undefined }));
vi.mock("../background-jobs-integration.js", () => ({
  getSharedCoordinator: async () => shared.coordinator!,
  getSharedScheduleEngine: async () => ({ listSchedules: async () => [] }),
}));
const { JobsTUI } = await import("../components/jobs-tui.js");
const { createJobsAdapter, describeStopResult } = await import("../resources/job-adapters.js");
const { default: render } = await import("../ink/render.js");
let root: string, id: string, c: Coordinator;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agav-ui-recovery-"));
  c = await createCoordinator({ root });
  shared.coordinator = c;
  id = randomUUID();
  await c.repositories.jobs.create({ jobId: id, requestId: randomUUID(), specHash: "fixture", protocolVersion: 1, state: "recovery-required", stopState: "none", nonce: "", uncertaintyReason: "ambiguous dispatch" });
  vi.spyOn(IpcClient, "connectWithRetry").mockRejectedValue(new Error("offline"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
async function mount(permissionMode: SessionPolicySnapshot["permissionMode"] = "auto-accept", columns = 140, rows = 45) {
  let output = "";
  const stdout = new EventEmitter() as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, columns, rows, write: (s: string) => { output += s; return true; } });
  const stdin = new EventEmitter() as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
  const instance = render(h(JobsTUI, { permissionMode, onExit: vi.fn() }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 25));
      await instance.waitUntilRenderFlush();
      const latest = output.split("Background jobs ·").at(-1) ?? "";
      if (i >= 2 && !latest.includes("Working…")) return;
    }
  };
  const key = async (s: string) => { output = ""; stdin.emit("data", Buffer.from(s)); await settle(); };
  await settle();
  return { key, frame: () => "Background jobs ·" + (output.replaceAll(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").split("Background jobs ·").at(-1) ?? ""), close: () => instance.unmount() };
}
describe("jobs manager recovery", () => {
  it.each(["n", "\x1b"])("requires explicit confirmation even in auto-accept; %j denies", async answer => {
    const abandon = vi.spyOn(c, "abandonJob");
    const ui = await mount();
    try {
      expect(ui.frame()).toContain("a: Abandon");
      expect(ui.frame()).not.toContain("x: Stop");
      expect(ui.frame()).not.toContain("d: Delete");
      await ui.key("a");
      expect(ui.frame()).toContain("outcome and descendants remain unverified");
      expect(ui.frame()).toMatch(/No processes will be\s+stopped/);
      expect(abandon).not.toHaveBeenCalled();
      await ui.key(answer);
      expect(abandon).not.toHaveBeenCalled();
      expect((await c.poll(id)).abandonment).toBeUndefined();
    } finally { ui.close(); }
  });
  it.each(["recovery-required", "unknown"] as const)("abandons %s from details, hides from active list and preserves audit", async state => {
    await c.repositories.jobs.update(id, { state });
    const ui = await mount("ask");
    try {
      await ui.key("\r");
      expect(ui.frame()).toContain("a: Abandon");
      await ui.key("a"); await ui.key("y");
      expect(ui.frame()).toContain("Capacity released");
      expect(ui.frame()).toContain("No resources found");
      const summary = await c.poll(id);
      expect(summary.state).toBe(state);
      expect(summary.stopState).toBe("none");
      expect(summary.abandonment).toBeDefined();
      expect(await c.findByRequestId(summary.requestId)).toEqual(summary);
      const bytes = await readFile(jobPath(c.root, id), "utf8");
      await ui.key("h");
      expect(ui.frame()).toContain("[abandoned]");
      expect(ui.frame()).not.toContain("a: Abandon");
      expect(ui.frame()).not.toContain("x: Stop");
      expect(ui.frame()).not.toContain("d: Delete");
      await ui.key("a"); await ui.key("d"); await ui.key("x");
      expect(await readFile(jobPath(c.root, id), "utf8")).toBe(bytes);
      await ui.key("\r");
      expect(ui.frame()).toContain("abandonedAt:");
      expect(ui.frame()).toContain("no processes were stopped");
    } finally { ui.close(); }
    expect(await createJobsAdapter().list()).toEqual([]);
    expect((await createJobsAdapter().get(id))?.detail).toContain("abandonedAt:");
    shared.coordinator = await createCoordinator({ root });
    expect(await createJobsAdapter().list()).toEqual([]);
  });
  it.each(["deny-writes", "terminal-change", "reconnect", "storage-denied"])("reports %s without hiding or claiming success", async kind => {
    const ui = await mount(kind === "deny-writes" ? "deny-writes" : "auto-accept");
    try {
      await ui.key("a");
      if (kind === "terminal-change") await c.repositories.jobs.update(id, { state: "completed", exitCode: 0 });
      if (kind === "reconnect") vi.mocked(IpcClient.connectWithRetry).mockResolvedValue({ request: async () => ({ type: "poll", job: { ...(await c.repositories.jobs.get(id)), state: "running" } }), close: async () => {} } as unknown as IpcClient);
      if (kind === "storage-denied") vi.spyOn(c.repositories.jobs, "update").mockRejectedValueOnce(Object.assign(new Error("EACCES: audit publication denied"), { code: "EACCES" }));
      await ui.key("y");
      expect(ui.frame()).toMatch(kind === "deny-writes" ? /deny-writes/ : kind === "terminal-change" ? /not uncertain/ : kind === "reconnect" ? /reconnected/ : /EACCES/);
      expect(ui.frame()).not.toContain("Capacity released");
      expect((await c.repositories.jobs.get(id))?.abandonment).toBeUndefined();
      expect(await createJobsAdapter().list()).toHaveLength(1);
    } finally { ui.close(); }
  });
  it("never offers abandonment on a capabilities report opened from an uncertain job", async () => {
    const ui = await mount();
    try {
      await ui.key("c");
      expect(ui.frame()).toContain("availableIsolationBackends:");
      expect(ui.frame()).not.toContain("a: Abandon");
      await ui.key("a");
      expect((await c.poll(id)).abandonment).toBeUndefined();
    } finally { ui.close(); }
  });
  it.each(["unknown", "recovery-required"] as const)("never calls %s nothing running", state => {
    const text = describeStopResult({ jobId: id, requestId: "r", state, stopState: "none" });
    expect(text).toContain("Termination is unverified");
    expect(text).not.toMatch(/not running|nothing to stop/);
  });
});

it("preserves acknowledged stop evidence", () => {
  const text = describeStopResult({ jobId: id, requestId: "r", state: "unknown", stopState: "acknowledged" });
  expect(text).toContain("Termination is unverified");
  expect(text).not.toContain("no stop was dispatched");
  expect(text).toContain("stopState: acknowledged");
});
it("keeps hidden evidence discoverable in an empty 80x24 list", async () => {
  await c.abandonJob(id, true, { permissionMode: "auto-accept", headlessApprovedActions: [] });
  const ui = await mount("auto-accept", 80, 24);
  try {
    expect(ui.frame()).toContain("No resources found");
    expect(ui.frame()).toMatch(/h: Show\s+abandoned/);
    expect(ui.frame()).toMatch(/Empty does not prove nothing is\s+running/);
    await ui.key("h");
    expect(ui.frame()).toContain("[abandoned]");
    expect(ui.frame()).toMatch(/h: Hide\s+abandoned/);
    await ui.key("h");
    expect(ui.frame()).toContain("No resources found");
  } finally { ui.close(); }
});

it("clamps selection after filtering and shows the remaining full ID", async () => {
  const other = randomUUID();
  await c.repositories.jobs.create({ jobId: other, requestId: randomUUID(), specHash: "fixture", protocolVersion: 1, state: "unknown", stopState: "none", nonce: "" });
  const abandon = vi.spyOn(c, "abandonJob");
  const ui = await mount();
  try {
    await ui.key("\x1b[B");
    await ui.key("a"); await ui.key("y");
    expect(abandon).toHaveBeenCalledOnce();
    const abandoned = abandon.mock.calls[0]![0];
    const remaining = abandoned === id ? other : id;
    expect(ui.frame()).toContain(remaining.slice(0, 8));
    expect(ui.frame()).not.toContain(abandoned.slice(0, 8));
    await ui.key("\r");
    expect(ui.frame()).toContain("jobId: " + remaining);
    expect(ui.frame()).toContain("a: Abandon");
  } finally { ui.close(); }
});
it("does not confirm abandonment after unmount or interpret search as actions", async () => {
  const abandon = vi.spyOn(c, "abandonJob");
  const ui = await mount();
  try {
    await ui.key("s"); await ui.key("ah");
    expect(ui.frame()).toContain("Search: ah");
    expect(abandon).not.toHaveBeenCalled();
    await ui.key("\x1b"); await ui.key("a");
    expect(ui.frame()).toContain("y: Confirm");
    ui.close();
    await ui.key("y");
    expect(abandon).not.toHaveBeenCalled();
    expect((await c.poll(id)).abandonment).toBeUndefined();
  } finally { ui.close(); }
});
