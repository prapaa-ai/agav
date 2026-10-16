import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorizationService } from "../background-jobs/authorization/service.js";
import { createGrantStore } from "../background-jobs/authorization/grant-store.js";
import { DEFAULT_RESOURCE_LIMITS, type SessionPolicySnapshot } from "../background-jobs/types.js";
import { createFileRepositories } from "../background-jobs/storage/repositories.js";
import { createScheduleEngine } from "../background-jobs/schedule/engine.js";
import { ConfirmationQueue } from "../agent/confirmation-queue.js";

let root: string;
const spec = {
  invocation: { mode: "shell" as const, interpreter: "cmd" as const, commandText: "echo approved" },
  cwd: process.cwd(), env: {}, credentialRefs: [], isolation: { backend: "none" as const, required: false },
  ownershipScope: "unverified" as const, limits: DEFAULT_RESOURCE_LIMITS, headless: false,
};
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agav-ask-auth-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function session(confirm: (action: string, value: unknown) => Promise<boolean>, signal?: AbortSignal): SessionPolicySnapshot {
  return { permissionMode: "ask", headlessApprovedActions: [], confirmBackgroundAction: confirm, signal } as SessionPolicySnapshot;
}

describe("background ask authorization", () => {
  it("persists approval only for the exact specification", async () => {
    const service = createAuthorizationService(root);
    const confirm = vi.fn(async () => true);
    const decision = await service.authorize("start", spec, session(confirm));
    expect(decision.allowed).toBe(true);
    expect(confirm).toHaveBeenCalledWith("start", spec);
    expect((await createGrantStore(root).list())).toHaveLength(1);
    expect((await service.authorize("start", { ...spec, cwd: "different" }, { permissionMode: "ask", headlessApprovedActions: [] })).allowed).toBe(false);
  });
  it.each([false, "throw"])("rejection/error %s never grants", async (choice) => {
    const service = createAuthorizationService(root);
    const result = await service.authorize("start", spec, session(async () => { if (choice === "throw") throw Error("closed"); return false; }));
    expect(result.allowed).toBe(false);
    expect(await createGrantStore(root).list()).toHaveLength(0);
  });
  it("aborting a pending confirmation denies even if a late yes arrives", async () => {
    const service = createAuthorizationService(root);
    const controller = new AbortController();
    let accept!: (value: boolean) => void;
    const pending = service.authorize("start", spec, session(() => new Promise(r => { accept = r; }), controller.signal));
    await vi.waitFor(() => expect(accept).toBeDefined());
    controller.abort();
    expect((await pending).allowed).toBe(false);
    accept(true);
    expect(await createGrantStore(root).list()).toHaveLength(0);
  });
  it("headless and deny-writes cannot invoke the interactive callback", async () => {
    const service = createAuthorizationService(root);
    const confirm = vi.fn(async () => true);
    expect((await service.authorize("start", spec, session(confirm), { headless: true })).allowed).toBe(false);
    expect((await service.authorize("start", spec, { ...session(confirm), permissionMode: "deny-writes" })).allowed).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect((await service.authorize("start", spec, { permissionMode: "ask", headlessApprovedActions: [] })).allowed).toBe(false);
  });
  it("schedule approval binds cron and timezone, not just command", async () => {
    const service = createAuthorizationService(root);
    const repositories = createFileRepositories(root);
    const engine = createScheduleEngine({ root, repositories, authorizationService: service, coordinator: {} as any });
    const confirm = vi.fn(async () => true);
    const input = { cron: "0 9 * * *", timezone: "UTC", launchSpecTemplate: spec, session: session(confirm) };
    await engine.createSchedule(input);
    expect(confirm).toHaveBeenCalledTimes(1);
    await expect(engine.createSchedule({ ...input, cron: "0 10 * * *", session: { permissionMode: "ask", headlessApprovedActions: [] } })).rejects.toMatchObject({ code: "authorization-denied" });
    await expect(engine.createSchedule({ ...input, timezone: "America/New_York", session: { permissionMode: "ask", headlessApprovedActions: [] } })).rejects.toMatchObject({ code: "authorization-denied" });
    expect(await repositories.schedules.list()).toHaveLength(1);
  });
  it("clearing the shared UI queue rejects active and queued requests", async () => {
    const queue = new ConfirmationQueue();
    queue.bind(() => {});
    const first = queue.enqueue({ toolName: "run_background_job", input: {} });
    const second = queue.enqueue({ toolName: "run_background_job", input: {}, subagentId: "sa-1" });
    queue.clear();
    expect(await Promise.race([Promise.all([first, second]), new Promise(r => setTimeout(() => r("hung"), 50))])).toEqual(["no", "no"]);
  });
});
