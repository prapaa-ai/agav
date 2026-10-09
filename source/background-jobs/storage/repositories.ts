/**
 * T05 — Durable storage and record repositories.
 *
 * Implements the frozen `Repositories` contract from `types.ts` (T01).
 * No coordinator/supervisor business logic lives here — only persistence,
 * atomic publication, single-writer locking and ID/prefix resolution per
 * solution.md §7.
 *
 * On-disk layout under `root` (see paths.ts for exact derivations):
 *   specs/<requestId>.json                — immutable LaunchSpec, one writer ever
 *   jobs/<jobId>.json                      — JobRecord, single lifecycle writer per job (withJobLock)
 *   control-intents/<intentId>.json        — one ControlIntent per file; `listForJob` scans + filters
 *   events/<eventId>.json                  — CompletionEventRecord
 *   acks/<eventId>--<clientId>.json        — AcknowledgementRecord, persisted independently of events
 *   schedules/<scheduleId>.json            — ScheduleRecord
 *   occurrences/<occurrenceId>.json        — ScheduleOccurrenceRecord, reserved via exclusive create
 *   locks/*.lock                           — OS-held lock files (single-writer-lock.ts)
 *   quarantine/                            — corrupt records moved aside instead of silently dropped
 *
 * Control intents are one-file-per-intent (rather than one array file per
 * job) so that `create`/`update` are each a single atomic publication with
 * no read-modify-write race across intents for the same job; `listForJob`
 * reads the whole directory and filters by `jobId`, which is cheap at the
 * expected intent volume (stop/cleanup requests are rare per job).
 */
import { readdir } from "node:fs/promises";

import type {
  AcknowledgementRecord,
  CompletionEventRecord,
  ControlIntent,
  EventId,
  JobId,
  JobRecord,
  LaunchSpec,
  Repositories,
  RequestId,
  ScheduleId,
  ScheduleOccurrenceRecord,
  ScheduleRecord,
} from "../types.js";
import { BackgroundJobError } from "../types.js";
import { createExclusive, readJsonIfExists, writeAtomic } from "./atomic-file.js";
import {
  acksDir,
  ackPath,
  controlIntentPath,
  controlIntentsDir,
  eventPath,
  eventsDir,
  jobPath,
  jobsDir,
  occurrencePath,
  occurrencesDir,
  quarantineDir,
  resolvePrefix as resolvePrefixHelper,
  schedulePath,
  schedulesDir,
  specPath,
} from "./paths.js";
import { withJobLock } from "./single-writer-lock.js";

/** List json-record ids (filenames minus `.json`) in a directory; empty if the directory does not exist yet. */
async function listIds(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** List `<a>--<b>` compound ids, returning the `a` and `b` components. */
async function listAckIds(dir: string): Promise<Array<{ eventId: string; clientId: string }>> {
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .map((id) => {
        const idx = id.indexOf("--");
        return idx === -1 ? { eventId: id, clientId: "" } : { eventId: id.slice(0, idx), clientId: id.slice(idx + 2) };
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

/** Deep-equality good enough for comparing persisted JSON records (order-independent on top-level keys). */
function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function createFileRepositories(root: string): Repositories {
  const quarantine = quarantineDir(root);

  const specs: Repositories["specs"] = {
    async put(spec: LaunchSpec): Promise<void> {
      const path = specPath(root, spec.requestId);
      const existing = await readJsonIfExists<LaunchSpec>(path, quarantine);
      if (existing !== undefined) {
        if (deepEqualJson(existing, spec)) {
          // Idempotent retry with the identical spec succeeds silently
          // (solution.md §6: "stable request IDs make retries refer to the
          // original launch").
          return;
        }
        throw new BackgroundJobError(
          "spec-changed",
          `LaunchSpec for requestId "${spec.requestId}" is immutable and already differs from the stored version.`,
        );
      }
      await writeAtomic(path, JSON.stringify(spec, null, 2));
    },
    async get(requestId: RequestId): Promise<LaunchSpec | undefined> {
      return readJsonIfExists<LaunchSpec>(specPath(root, requestId), quarantine);
    },
  };

  const jobs: Repositories["jobs"] = {
    async create(record: JobRecord): Promise<void> {
      const path = jobPath(root, record.jobId);
      const existing = await readJsonIfExists<JobRecord>(path, quarantine);
      if (existing !== undefined) {
        throw new BackgroundJobError("storage-unavailable", `JobRecord already exists for jobId "${record.jobId}".`);
      }
      await writeAtomic(path, JSON.stringify(record, null, 2));
    },
    async update(jobId: JobId, patch: Partial<JobRecord>): Promise<void> {
      await withJobLock(root, jobId, async () => {
        const path = jobPath(root, jobId);
        const existing = await readJsonIfExists<JobRecord>(path, quarantine);
        if (existing === undefined) {
          throw new BackgroundJobError("not-found", `No JobRecord found for jobId "${jobId}".`);
        }
        const updated: JobRecord = { ...existing, ...patch };
        await writeAtomic(path, JSON.stringify(updated, null, 2));
      });
    },
    async get(jobId: JobId): Promise<JobRecord | undefined> {
      return readJsonIfExists<JobRecord>(jobPath(root, jobId), quarantine);
    },
    async list(): Promise<JobRecord[]> {
      const ids = await listIds(jobsDir(root));
      const records: JobRecord[] = [];
      for (const id of ids) {
        const record = await readJsonIfExists<JobRecord>(jobPath(root, id), quarantine);
        if (record !== undefined) records.push(record);
      }
      return records;
    },
    async resolvePrefix(prefix: string): Promise<JobId> {
      const ids = await listIds(jobsDir(root));
      return resolvePrefixHelper(ids, prefix);
    },
  };

  const controlIntents: Repositories["controlIntents"] = {
    async create(intent: ControlIntent): Promise<void> {
      const path = controlIntentPath(root, intent.id);
      const existing = await readJsonIfExists<ControlIntent>(path, quarantine);
      if (existing !== undefined) {
        throw new BackgroundJobError("storage-unavailable", `ControlIntent already exists for id "${intent.id}".`);
      }
      await writeAtomic(path, JSON.stringify(intent, null, 2));
    },
    async update(id: string, patch: Partial<ControlIntent>): Promise<void> {
      const path = controlIntentPath(root, id);
      const existing = await readJsonIfExists<ControlIntent>(path, quarantine);
      if (existing === undefined) {
        throw new BackgroundJobError("not-found", `No ControlIntent found for id "${id}".`);
      }
      const updated: ControlIntent = { ...existing, ...patch };
      await writeAtomic(path, JSON.stringify(updated, null, 2));
    },
    async listForJob(jobId: JobId): Promise<ControlIntent[]> {
      const ids = await listIds(controlIntentsDir(root));
      const records: ControlIntent[] = [];
      for (const id of ids) {
        const record = await readJsonIfExists<ControlIntent>(controlIntentPath(root, id), quarantine);
        if (record !== undefined && record.jobId === jobId) records.push(record);
      }
      return records;
    },
  };

  const events: Repositories["events"] = {
    async create(event: CompletionEventRecord): Promise<void> {
      const path = eventPath(root, event.eventId);
      const existing = await readJsonIfExists<CompletionEventRecord>(path, quarantine);
      if (existing !== undefined) {
        throw new BackgroundJobError("storage-unavailable", `CompletionEventRecord already exists for eventId "${event.eventId}".`);
      }
      await writeAtomic(path, JSON.stringify(event, null, 2));
    },
    async get(eventId: EventId): Promise<CompletionEventRecord | undefined> {
      return readJsonIfExists<CompletionEventRecord>(eventPath(root, eventId), quarantine);
    },
    async listPending(): Promise<CompletionEventRecord[]> {
      const eventIds = await listIds(eventsDir(root));
      const ackedEventIds = new Set((await listAckIds(acksDir(root))).map((a) => a.eventId));
      const pending: CompletionEventRecord[] = [];
      for (const id of eventIds) {
        if (ackedEventIds.has(id)) continue;
        const record = await readJsonIfExists<CompletionEventRecord>(eventPath(root, id), quarantine);
        if (record !== undefined) pending.push(record);
      }
      return pending;
    },
  };

  const acks: Repositories["acks"] = {
    async create(ack: AcknowledgementRecord): Promise<void> {
      const path = ackPath(root, ack.eventId, ack.clientId);
      await writeAtomic(path, JSON.stringify(ack, null, 2));
    },
    async get(eventId: EventId): Promise<AcknowledgementRecord | undefined> {
      // Any client's ack is sufficient evidence the event is acknowledged;
      // return the first one found (acks are keyed by eventId+clientId so
      // multiple clients could in principle each ack independently).
      const ids = await listAckIds(acksDir(root));
      for (const { eventId: evId, clientId } of ids) {
        if (evId !== eventId) continue;
        const record = await readJsonIfExists<AcknowledgementRecord>(ackPath(root, evId, clientId), quarantine);
        if (record !== undefined) return record;
      }
      return undefined;
    },
  };

  const schedules: Repositories["schedules"] = {
    async put(record: ScheduleRecord): Promise<void> {
      await writeAtomic(schedulePath(root, record.scheduleId), JSON.stringify(record, null, 2));
    },
    async get(scheduleId: ScheduleId): Promise<ScheduleRecord | undefined> {
      return readJsonIfExists<ScheduleRecord>(schedulePath(root, scheduleId), quarantine);
    },
    async list(): Promise<ScheduleRecord[]> {
      const ids = await listIds(schedulesDir(root));
      const records: ScheduleRecord[] = [];
      for (const id of ids) {
        const record = await readJsonIfExists<ScheduleRecord>(schedulePath(root, id), quarantine);
        if (record !== undefined) records.push(record);
      }
      return records;
    },
  };

  const occurrences: Repositories["occurrences"] = {
    async reserve(record: ScheduleOccurrenceRecord): Promise<boolean> {
      // Atomic-create-exclusive: "already reserved" is an expected outcome
      // used to prevent duplicate scheduling (solution.md §11), not an error.
      const path = occurrencePath(root, record.occurrenceId);
      return createExclusive(path, JSON.stringify(record, null, 2));
    },
    async update(occurrenceId: string, patch: Partial<ScheduleOccurrenceRecord>): Promise<void> {
      const path = occurrencePath(root, occurrenceId);
      const existing = await readJsonIfExists<ScheduleOccurrenceRecord>(path, quarantine);
      if (existing === undefined) {
        throw new BackgroundJobError("not-found", `No ScheduleOccurrenceRecord found for occurrenceId "${occurrenceId}".`);
      }
      const updated: ScheduleOccurrenceRecord = { ...existing, ...patch };
      await writeAtomic(path, JSON.stringify(updated, null, 2));
    },
    async listForSchedule(scheduleId: ScheduleId): Promise<ScheduleOccurrenceRecord[]> {
      const ids = await listIds(occurrencesDir(root));
      const records: ScheduleOccurrenceRecord[] = [];
      for (const id of ids) {
        const record = await readJsonIfExists<ScheduleOccurrenceRecord>(occurrencePath(root, id), quarantine);
        if (record !== undefined && record.scheduleId === scheduleId) records.push(record);
      }
      return records;
    },
  };

  return { specs, jobs, controlIntents, events, acks, schedules, occurrences };
}

// Exported for tests/diagnostics only; not part of the Repositories contract.
export const __internal = { stableStringify, deepEqualJson };
