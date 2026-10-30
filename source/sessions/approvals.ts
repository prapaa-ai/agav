import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ConfirmResult } from "../agent/loop.js";
import type { QueuedConfirmation } from "../agent/confirmation-queue.js";
import type { PermissionMode } from "../config/config.js";
import { createExclusive } from "../background-jobs/storage/atomic-file.js";
import { inputHash } from "../workflows/decisions.js";
import { assertSessionRuntimeId, type SessionRuntimeStore } from "./store.js";

export type SessionApprovalRequest = Omit<QueuedConfirmation, "resolve"> & { warning?: string };
export interface PendingSessionApproval extends SessionApprovalRequest {
  version: 1;
  approvalId: string;
  sessionId: string;
  generation: string;
  inputHash: string;
  createdAt: string;
}
export interface SessionApprovalDecision {
  version: 1;
  approvalId: string;
  sessionId: string;
  generation: string;
  inputHash: string;
  result: ConfirmResult;
  decidedAt: string;
}
export interface SessionApprovalBrokerOptions { permissionFloor?: PermissionMode; pollMs?: number }
function path(store: SessionRuntimeStore, sessionId: string, approvalId: string, decided = false): string {
  assertSessionRuntimeId(approvalId);
  return join(store.directory(sessionId), "approvals", `${approvalId}${decided ? ".decided" : ""}.json`);
}
function validResult(result: unknown): result is ConfirmResult {
  return result === "yes" || result === "no" || result === "always" ||
    (!!result && typeof result === "object" && (result as { choice?: unknown }).choice === "no" &&
      ((result as { feedback?: unknown }).feedback === undefined || typeof (result as { feedback?: unknown }).feedback === "string"));
}
// Consent records must remain in place on parse failure: moving a corrupt decision
// aside would make a later reader treat it as unanswered and publish new consent.
async function readApprovalJson<T>(file: string): Promise<T | undefined> {
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try { return JSON.parse(raw) as T; }
  catch { throw new Error(`Corrupt session approval JSON: ${file}`); }
}

const discoveryWarnings = new Map<string, string>();
/** Warn once per observed file version, with bounded memory across presentation polls. */
export async function warnSessionDiscovery(file: string, error: unknown): Promise<void> {
  const stat = await fs.stat(file).catch(() => undefined);
  const message = error instanceof Error ? error.message : String(error);
  const version = `${stat?.mtimeMs}:${stat?.ctimeMs}:${stat?.size}:${message}`;
  if (discoveryWarnings.get(file) === version) return;
  discoveryWarnings.delete(file);
  discoveryWarnings.set(file, version);
  if (discoveryWarnings.size > 512) discoveryWarnings.delete(discoveryWarnings.keys().next().value!);
  console.warn(`Skipping session discovery entry ${file}: ${message}`);
}

async function readPending(store: SessionRuntimeStore, sessionId: string, approvalId: string): Promise<PendingSessionApproval | undefined> {
  const record = await readApprovalJson<PendingSessionApproval>(path(store, sessionId, approvalId));
  if (record !== undefined && (!record || record.version !== 1 || record.sessionId !== sessionId || record.approvalId !== approvalId ||
      typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
      typeof record.generation !== "string" || typeof record.toolName !== "string" || !record.input || typeof record.input !== "object" ||
      record.inputHash !== inputHash(record.input))) throw new Error(`Corrupt session approval: ${approvalId}`);
  return record;
}
async function readDecision(store: SessionRuntimeStore, pending: PendingSessionApproval): Promise<SessionApprovalDecision | undefined> {
  const record = await readApprovalJson<SessionApprovalDecision>(path(store, pending.sessionId, pending.approvalId, true));
  if (record !== undefined && (!record || record.version !== 1 || record.approvalId !== pending.approvalId || record.sessionId !== pending.sessionId ||
      record.generation !== pending.generation || record.inputHash !== pending.inputHash || !validResult(record.result))) throw new Error(`Corrupt session approval result: ${pending.approvalId}`);
  return record;
}
function normalize(result: ConfirmResult, pending: SessionApprovalRequest, floor?: PermissionMode): ConfirmResult {
  if (result !== "always") return result;
  if (pending.explicitApprovalOnly) return "no";
  if (pending.toolName === "run_background_job" || (floor !== undefined && floor !== "auto-accept")) return "yes";
  return result;
}

/** Returns current-generation, outstanding requests, including those created before the first transcript save. */
export async function listPendingApprovals(store: SessionRuntimeStore, sessionId?: string): Promise<PendingSessionApproval[]> {
  const records = sessionId === undefined ? await store.list() : [await store.read(sessionId)];
  const pending: PendingSessionApproval[] = [];
  for (const record of records) {
    if (!record || !["starting", "running", "needs-approval"].includes(record.status)) continue;
    const directory = join(store.directory(record.id), "approvals");
    let names: string[];
    try { names = await fs.readdir(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") await warnSessionDiscovery(directory, error);
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".decided.json") || name.startsWith(".")) continue;
      const approvalId = name.slice(0, -5);
      let file = join(store.directory(record.id), "approvals", name);
      try {
        const item = await readPending(store, record.id, approvalId);
        if (!item || item.generation !== record.generation) continue;
        file = path(store, record.id, approvalId, true);
        if (!await readDecision(store, item)) pending.push(item);
      } catch (error) {
        // Discovery is presentation-only; never answer or remove a corrupt request.
        await warnSessionDiscovery(file, error);
      }
    }
  }
  return pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.approvalId.localeCompare(b.approvalId));
}

/** Caller holds the session lock, including the pending-count read and status save. */
async function reconcileStatus(store: SessionRuntimeStore, sessionId: string, generation: string): Promise<void> {
  const runtime = await store.read(sessionId);
  if (!runtime || runtime.generation !== generation || !["starting", "running", "needs-approval"].includes(runtime.status)) return;
  const status = (await listPendingApprovals(store, sessionId)).length ? "needs-approval" : "running";
  if (runtime.status !== status) {
    runtime.status = status;
    await store.save(runtime);
  }
}

// A broker-local floor may tighten, but never relax, the persisted policy.
function effectiveFloor(persisted?: PermissionMode, local?: PermissionMode): PermissionMode | undefined {
  if (persisted === "deny-writes" || local === "deny-writes") return "deny-writes";
  if (persisted === "ask" || local === "ask") return "ask";
  return persisted ?? local;
}

/** Exact request identity and exclusive publication make concurrent answers single-winner. */
export async function decideSessionApproval(store: SessionRuntimeStore, sessionId: string, approvalId: string, result: ConfirmResult,
  expected?: { generation?: string; inputHash?: string }): Promise<{ won: boolean; record: SessionApprovalDecision }> {
  if (!validResult(result)) throw new Error("Invalid session approval choice.");
  return store.lock(sessionId, async () => {
    const runtime = await store.read(sessionId);
    const pending = await readPending(store, sessionId, approvalId);
    if (!runtime || !pending || runtime.generation !== pending.generation || !["starting", "running", "needs-approval"].includes(runtime.status) ||
        (expected?.generation !== undefined && expected.generation !== pending.generation) ||
        (expected?.inputHash !== undefined && expected.inputHash !== pending.inputHash)) throw new Error("Missing or stale session approval.");
    const existing = await readDecision(store, pending);
    if (existing) return { won: false, record: existing };
    const record: SessionApprovalDecision = { version: 1, sessionId, approvalId, generation: pending.generation, inputHash: pending.inputHash,
      result: normalize(result, pending, runtime.permissionFloor), decidedAt: new Date().toISOString() };
    if (await createExclusive(path(store, sessionId, approvalId, true), JSON.stringify(record, null, 2) + "\n")) return { won: true, record };
    const winner = await readDecision(store, pending);
    if (!winner) throw new Error("Session approval result vanished.");
    return { won: false, record: winner };
  });
}

/** Worker-owned promises survive presentation disconnects. Each invocation gets fresh consent identity. */
export class SessionApprovalBroker {
  private autoAccept = false;
  private readonly active = new Map<string, { request: SessionApprovalRequest; controller: AbortController }>();
  constructor(readonly store: SessionRuntimeStore, readonly sessionId: string, readonly generation: string,
    private readonly options: SessionApprovalBrokerOptions = {}) {
    assertSessionRuntimeId(sessionId);
    assertSessionRuntimeId(generation);
  }
  async confirm(request: SessionApprovalRequest, signal?: AbortSignal): Promise<ConfirmResult> {
    if (signal?.aborted) return "no";
    // Snapshot before publishing: caller mutation must not change the operation being approved.
    const snapshot = JSON.parse(JSON.stringify(request)) as SessionApprovalRequest;
    const pending: PendingSessionApproval = { ...snapshot, version: 1, approvalId: randomUUID(), sessionId: this.sessionId,
      generation: this.generation, inputHash: inputHash(snapshot.input), createdAt: new Date().toISOString() };
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.active.set(pending.approvalId, { request: snapshot, controller });
    let published = false;
    try {
      const immediate = await this.store.lock(this.sessionId, async () => {
        const runtime = await this.store.read(this.sessionId);
        if (!runtime || runtime.generation !== this.generation || !["starting", "running", "needs-approval"].includes(runtime.status)) throw new Error("Missing or stale session runtime.");
        if (signal?.aborted || controller.signal.aborted) return "no" as const;
        const floor = effectiveFloor(runtime.permissionFloor, this.options.permissionFloor);
        if (this.autoAccept && snapshot.toolName !== "run_background_job" && !snapshot.explicitApprovalOnly && (floor === undefined || floor === "auto-accept")) return "always" as const;
        if (!await createExclusive(path(this.store, this.sessionId, pending.approvalId), JSON.stringify(pending, null, 2) + "\n")) throw new Error("Duplicate session approval identity.");
        published = true;
        await reconcileStatus(this.store, this.sessionId, this.generation);
      });
      if (immediate) return immediate;
      while (true) {
        const settled = await this.store.lock(this.sessionId, async () => {
          const current = await this.store.read(this.sessionId);
          if (!current || current.generation !== this.generation || !["starting", "running", "needs-approval"].includes(current.status)) return "no";
          if (signal?.aborted || controller.signal.aborted) {
            await decideSessionApproval(this.store, this.sessionId, pending.approvalId, "no");
            return "no";
          }
          let decision = await readDecision(this.store, pending);
          const floor = effectiveFloor(current.permissionFloor, this.options.permissionFloor);
          if (!decision && this.autoAccept && !snapshot.explicitApprovalOnly && snapshot.toolName !== "run_background_job" && (floor === undefined || floor === "auto-accept")) {
            decision = (await decideSessionApproval(this.store, this.sessionId, pending.approvalId, "always")).record;
          }
          if (decision) {
            const result = normalize(decision.result, snapshot, floor);
            if (result === "always") {
              // Persist the session override without widening its independent job policy.
              current.permissionMode = "auto-accept";
              await this.store.save(current);
              this.autoAccept = true;
            }
            return result;
          }
        });
        if (settled !== undefined) return settled;
        await delay(Math.max(1, this.options.pollMs ?? 100), undefined, { signal: controller.signal }).catch(error => {
          if ((error as Error).name !== "AbortError") throw error;
        });
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.active.delete(pending.approvalId);
      if (published) await this.store.lock(this.sessionId, async () => {
        const current = await this.store.read(this.sessionId);
        if (!current || current.generation !== this.generation || !["starting", "running", "needs-approval"].includes(current.status)) return;
        // Cancellation or a failed polling operation must not leave orphaned consent.
        if (!await readDecision(this.store, pending)) await decideSessionApproval(this.store, this.sessionId, pending.approvalId, "no");
        await reconcileStatus(this.store, this.sessionId, this.generation);
      });
    }
  }
  rejectBySubagentId(subagentId: string): void {
    for (const { request, controller } of this.active.values()) if (request.subagentId === subagentId) controller.abort();
  }
  clear(): void {
    this.autoAccept = false;
    for (const { controller } of this.active.values()) controller.abort();
  }
}
