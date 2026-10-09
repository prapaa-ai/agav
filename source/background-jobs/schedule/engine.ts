/**
 * T15 — Recurring process-schedule engine (solution.md §11).
 *
 * This module owns schedule CRUD (create/revoke/list) and the periodic
 * evaluation pass that decides, for each enabled schedule, whether an
 * occurrence is due and — if so — whether it is safe to dispatch. Dispatch
 * happens ONLY through the injected `CoordinatorClient.start()`; this file
 * never imports supervisor/launcher code directly, matching the
 * module-boundary rule in types.ts ("schedule-engine.ts -> consumes
 * storage + authorization + coordinator client API").
 */
import { randomUUID } from "node:crypto";

import {
  BackgroundJobError,
  isTerminalLifecycle,
  type CoordinatorClient,
  type JobRecord,
  type LaunchSpec,
  type Repositories,
  type ScheduleId,
  type ScheduleRecord,
  type SessionPolicySnapshot,
} from "../types.js";
import type { AuthorizationService } from "../authorization/service.js";
import { computeNextOccurrence, parseCronExpression } from "./cron.js";
import { reserveOccurrence } from "./occurrence-reservation.js";

export type ScheduleEvaluationOutcome =
  | "dispatched"
  | "skipped-overlap"
  | "skipped-capacity"
  | "skipped-restrictive-policy"
  | "skipped-grant-invalid"
  | "no-occurrence-due";

export interface ScheduleEvaluationResult {
  scheduleId: ScheduleId;
  outcome: ScheduleEvaluationOutcome;
  reason?: string;
}

export interface ScheduleEngine {
  createSchedule(input: {
    cron: string;
    timezone: string;
    launchSpecTemplate: Omit<LaunchSpec, "requestId" | "createdAt">;
    session: SessionPolicySnapshot;
  }): Promise<ScheduleRecord>;

  revokeSchedule(scheduleId: ScheduleId, session: SessionPolicySnapshot): Promise<void>;

  listSchedules(): Promise<ScheduleRecord[]>;

  evaluateOnce(args: {
    nowUtc: Date;
    connectedSessions: SessionPolicySnapshot[];
  }): Promise<ScheduleEvaluationResult[]>;
}

export interface CreateScheduleEngineArgs {
  repositories: Repositories;
  coordinator: CoordinatorClient;
  authorizationService: AuthorizationService;
  root: string;
}

export function createScheduleEngine(args: CreateScheduleEngineArgs): ScheduleEngine {
  const { repositories, coordinator, authorizationService } = args;
  // `args.root` is accepted for a stable constructor signature/future use
  // (e.g. future on-disk schedule-engine-local caches) but is not needed by
  // any current behavior here — every persistence operation goes through
  // `repositories`, which is already bound to a resolved root by its own
  // constructor.
  void args.root;

  return {
    async createSchedule(input) {
      // Validate the cron expression; propagate BackgroundJobError on
      // malformed input rather than catching/rewrapping it.
      parseCronExpression(input.cron);

      // Bind recurring consent to the schedule's exact terms and identity.
      const scheduleId = randomUUID();
      // Validate timezone before prompting or persisting an approval.
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
      const launchSpecTemplate = {
        ...input.launchSpecTemplate,
        recurrence: { scheduleId, scheduleVersion: 1, cron: input.cron, timezone: input.timezone },
      };
      const decision = await authorizationService.authorize(
        "schedule-create",
        launchSpecTemplate,
        input.session,
      );
      if (!decision.allowed) {
        throw new BackgroundJobError("authorization-denied", decision.reason);
      }

      const record: ScheduleRecord = {
        scheduleId,
        version: 1,
        cron: input.cron,
        timezone: input.timezone,
        launchSpecTemplate,
        grantId: decision.grant!.grantId,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      await repositories.schedules.put(record);
      return record;
    },

    // Per solution.md §4/§11: revocation blocks future triggers; it does
    // NOT touch any existing reserved/in-flight occurrence or running job.
    // This is a simple read-then-write with no extra locking for this
    // first cut (acceptable simplification per the task brief) — a
    // concurrent createSchedule/revokeSchedule race on the SAME scheduleId
    // is not expected (schedule mutation is not a high-concurrency path),
    // and worst case a lost update here only delays an already-intended
    // revocation until the next explicit retry, never resurrects a
    // previously revoked schedule.
    async revokeSchedule(scheduleId, session) {
      const schedule = await repositories.schedules.get(scheduleId);
      if (schedule === undefined) {
        throw new BackgroundJobError("not-found", `No schedule found for scheduleId "${scheduleId}".`);
      }
      const decision = await authorizationService.authorize("schedule-revoke", schedule.launchSpecTemplate, session);
      if (!decision.allowed) {
        throw new BackgroundJobError("authorization-denied", decision.reason);
      }
      await repositories.schedules.put({ ...schedule, enabled: false });
    },

    async listSchedules() {
      return repositories.schedules.list();
    },

    async evaluateOnce({ nowUtc, connectedSessions }) {
      const results: ScheduleEvaluationResult[] = [];

      // Cache the jobs listing once per evaluation pass (not required for
      // correctness, just avoids redundant repository reads across
      // multiple schedules in the same pass).
      let jobsCache: JobRecord[] | undefined;
      const getJobs = async (): Promise<JobRecord[]> => {
        if (jobsCache === undefined) {
          jobsCache = await repositories.jobs.list();
        }
        return jobsCache;
      };

      const schedules = await repositories.schedules.list();
      for (const schedule of schedules) {
        // Disabled schedules are not evaluated at all — no entry is pushed
        // for them (revokeSchedule sets enabled:false).
        if (!schedule.enabled) continue;

        const fields = parseCronExpression(schedule.cron);
        // Evaluate from one minute before `nowUtc` so an occurrence due
        // exactly "now" or within the last evaluation-granularity window is
        // detected, without ever returning an occurrence AFTER `nowUtc`
        // (checked explicitly below) — this avoids gaps between successive
        // evaluateOnce calls at typical polling cadences.
        const occurrence = computeNextOccurrence(fields, schedule.timezone, new Date(nowUtc.getTime() - 60_000));
        if (occurrence === undefined || occurrence.utc.getTime() > nowUtc.getTime()) {
          results.push({ scheduleId: schedule.scheduleId, outcome: "no-occurrence-due" });
          continue;
        }

        // An occurrence is due. Per solution.md §11: "Any connected
        // deny-writes session suppresses process-schedule launches while
        // attached." Checked BEFORE reserving anything: a later
        // evaluateOnce call at a later nowUtc will compute a newer
        // occurrence once enough time passes — no backfill bookkeeping is
        // needed here (intentional per "no unbounded queue,
        // disconnected-time backfill, or repeated retries within a
        // blocked/failed slot").
        const restrictive = authorizationService.aggregateRestrictivePolicy(connectedSessions);
        if (restrictive.blocksNewLaunches) {
          results.push({
            scheduleId: schedule.scheduleId,
            outcome: "skipped-restrictive-policy",
            reason: restrictive.reason,
          });
          continue;
        }

        // Recheck grant validity against the CURRENT launch spec template
        // before dispatch (solution.md §11: "recheck grant validity,
        // credentials, directories, capability and restrictive policy").
        const grantDecision = await authorizationService.revalidateBeforeDispatch(
          schedule.grantId,
          schedule.launchSpecTemplate,
        );
        if (!grantDecision.allowed) {
          results.push({
            scheduleId: schedule.scheduleId,
            outcome: "skipped-grant-invalid",
            reason: grantDecision.reason,
          });
          continue;
        }

        // One active/unknown job per schedule: look at every occurrence
        // previously recorded for this schedule and check whether any of
        // their associated jobs is still non-terminal (running, starting,
        // accepted, unknown, or recovery-required all count as "still
        // active/ambiguous" via isTerminalLifecycle's narrow true-set).
        const existingOccurrences = await repositories.occurrences.listForSchedule(schedule.scheduleId);
        const jobs = await getJobs();
        const hasActiveOverlap = existingOccurrences.some((occ) => {
          if (!occ.requestId) return false;
          const job = jobs.find((j) => j.requestId === occ.requestId);
          return job !== undefined && !isTerminalLifecycle(job.state);
        });
        if (hasActiveOverlap) {
          results.push({ scheduleId: schedule.scheduleId, outcome: "skipped-overlap" });
          continue;
        }

        // Reserve the occurrence durably BEFORE dispatch (solution.md §11:
        // "Reserve the occurrence durably before dispatch and associate it
        // with a stable launch request."). If another evaluation pass (or a
        // simultaneous client, or a clock-rollback replay) already claimed
        // this exact local occurrence, `reserved` is false here and this
        // pass backs off without attempting a second dispatch.
        const requestId = randomUUID();
        const { reserved, record } = await reserveOccurrence({
          repositories,
          schedule,
          occurrenceUtc: occurrence.utc,
          localKey: occurrence.localKey,
          requestId,
        });
        if (!reserved) {
          results.push({ scheduleId: schedule.scheduleId, outcome: "skipped-overlap" });
          continue;
        }

        // Dispatch via the coordinator ONLY — never a lower-level
        // supervisor/launcher path (module-boundary rule in types.ts). The
        // schedule's grant already represents consent for this exact spec
        // (established at createSchedule time and reconfirmed just above
        // via revalidateBeforeDispatch); a synthetic auto-accept session is
        // used here because schedule triggering is not tied to any one
        // human's live interactive session state beyond the
        // restrictive-policy check already performed separately above.
        try {
          await coordinator.start(
            {
              requestId,
              invocation: schedule.launchSpecTemplate.invocation,
              cwd: schedule.launchSpecTemplate.cwd,
              isolation: schedule.launchSpecTemplate.isolation,
            },
            { permissionMode: "auto-accept", headlessApprovedActions: [] },
          );
          await repositories.occurrences.update(record!.occurrenceId, { status: "dispatched" });
          results.push({ scheduleId: schedule.scheduleId, outcome: "dispatched" });
        } catch (error) {
          // Per solution.md §11: "Ambiguous dispatch is recovery-required,
          // not an automatic retry." The occurrence is marked
          // recovery-required unconditionally on ANY dispatch failure (not
          // only literally-ambiguous ones) and is never retried by this or
          // any future evaluateOnce call, since the durable reservation
          // above already claimed this exact local occurrence for good. An
          // unexpected (non-capacity) dispatch failure reuses the
          // "skipped-grant-invalid" outcome value below rather than
          // inventing a new one, since there is no better-fitting value in
          // the fixed outcome union for this case.
          const message = error instanceof Error ? error.message : String(error);
          await repositories.occurrences.update(record!.occurrenceId, {
            status: "recovery-required",
            reason: message,
          });
          if (error instanceof BackgroundJobError && error.code === "capacity-exceeded") {
            results.push({ scheduleId: schedule.scheduleId, outcome: "skipped-capacity", reason: message });
          } else {
            results.push({ scheduleId: schedule.scheduleId, outcome: "skipped-grant-invalid", reason: message });
          }
        }
      }

      return results;
    },
  };
}
