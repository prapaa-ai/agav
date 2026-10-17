import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  BackgroundJobError,
  isScheduleRevoked,
  isTerminalLifecycle,
  type CoordinatorClient,
  type JobRecord,
  type LaunchSpec,
  type Repositories,
  type ScheduleId,
  type ScheduleOccurrenceRecord,
  type ScheduleRecord,
  type SessionPolicySnapshot,
} from "../types.js";
import type { AuthorizationService } from "../authorization/service.js";
import { buildMinimalEnvironment, normalizeWindowsEnvKeyCasing } from "../launch-spec/environment.js";
import { getPlatformAdapter } from "../platform/index.js";
import { withCoordinatorLock, withJobLock } from "../storage/single-writer-lock.js";
import { computeNextOccurrence, parseCronExpression } from "./cron.js";
import { reserveOccurrence } from "./occurrence-reservation.js";
import { classifyOccurrence } from "./ownership.js";

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

export interface ScheduleRun {
  occurrence: ScheduleOccurrenceRecord;
  job?: JobRecord;
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

  /**
   * Permanently remove a schedule and its run records. Refused (`invalid-state`) while the schedule
   * is still enabled or any job it launched (or a pending dispatch) is still active. Launched jobs
   * themselves are never touched.
   */
  deleteSchedule(scheduleId: ScheduleId): Promise<void>;

  /** Never touches jobs already launched. */
  setScheduleEnabled(scheduleId: ScheduleId, enabled: boolean, session: SessionPolicySnapshot): Promise<ScheduleRecord>;

  /** Newest first. */
  listRuns(scheduleId: ScheduleId): Promise<ScheduleRun[]>;

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
  void args.root;

  // Serializes read-check-write on one schedule record across sessions and
  // processes. Lock acquisition does not wait, so retry briefly; callers keep
  // the critical section short and never hold it across a human prompt.
  // The name is prefixed so it cannot collide with a job id.
  async function withScheduleLock<T>(scheduleId: ScheduleId, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withJobLock(args.root, `schedule-${scheduleId}`, fn);
      } catch (error) {
        if (!(error instanceof BackgroundJobError && error.code === "lock-held") || attempt >= 100) throw error;
        await sleep(25 + Math.floor(Math.random() * 25));
      }
    }
  }

  // Same retry shape as the schedule lock: acquisition never waits, and holders keep it briefly.
  async function withCoordinatorLockRetrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withCoordinatorLock(args.root, fn);
      } catch (error) {
        if (!(error instanceof BackgroundJobError && error.code === "lock-held") || attempt >= 100) throw error;
        await sleep(25 + Math.floor(Math.random() * 25));
      }
    }
  }

  /**
   * Must run under the schedule lock. Returns whether the schedule is still owned by a job or a
   * live pending dispatch, reading fresh state (never a cache; ownership rule: ./ownership.ts).
   *
   * Jobless reservations older than the window are not simply ignored: elapsed time does not prove
   * their dispatcher stopped (it may only be suspended). They are FENCED first, under the coordinator
   * lock that also guards job creation, so either the dispatcher's job already exists (the schedule
   * stays owned) or its reservation is marked recovery-required and its `beforeAdmit` check aborts it.
   */
  async function scheduleIsOwned(scheduleId: ScheduleId): Promise<boolean> {
    const occurrences = await repositories.occurrences.listForSchedule(scheduleId);
    if (occurrences.length === 0) return false;
    const jobs = await repositories.jobs.list();
    const now = Date.now();
    let owned = false;
    const expired: ScheduleOccurrenceRecord[] = [];
    for (const occ of occurrences) {
      const ownership = classifyOccurrence(occ, jobs.find((j) => j.requestId === occ.requestId), now);
      if (ownership === "active") owned = true;
      else if (ownership === "expired") expired.push(occ);
    }
    if (expired.length === 0) return owned;

    await withCoordinatorLockRetrying(async () => {
      const freshJobs = await repositories.jobs.list();
      const freshOccurrences = await repositories.occurrences.listForSchedule(scheduleId);
      for (const occ of expired) {
        const job = freshJobs.find((j) => j.requestId === occ.requestId);
        if (job !== undefined) {
          // The dispatcher got its job in after all: it owns the schedule while that job is live.
          if (!isTerminalLifecycle(job.state)) owned = true;
          continue;
        }
        const current = freshOccurrences.find((o) => o.occurrenceId === occ.occurrenceId);
        if (current === undefined || current.status !== "reserved") continue;
        await repositories.occurrences.update(occ.occurrenceId, {
          status: "recovery-required",
          reason: "Dispatch expired without creating a job; fenced so a resumed dispatcher cannot launch.",
        });
      }
    });
    return owned;
  }

  return {
    async createSchedule(input) {
      parseCronExpression(input.cron);

      const scheduleId = randomUUID();
      // Validate timezone before prompting or persisting an approval.
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
      // Resolve cwd BEFORE approval so the grant hash covers the absolute
      // directory, not a relative one that would resolve differently when a
      // later trigger runs from another project.
      // Likewise resolve the effective environment now (same allow-list the
      // normalizer applies), so the grant hash covers it and every dispatch
      // launches with exactly this env, not the dispatcher's PATH/HOME.
      const platform = (await getPlatformAdapter()).platform;
      const effectiveEnv = { ...buildMinimalEnvironment(platform).env, ...input.launchSpecTemplate.env };
      const launchSpecTemplate = {
        ...input.launchSpecTemplate,
        cwd: resolve(input.launchSpecTemplate.cwd),
        env: platform === "win32" ? normalizeWindowsEnvKeyCasing(effectiveEnv) : effectiveEnv,
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

    // Revocation blocks future triggers only; reserved/in-flight occurrences and running jobs are untouched.
    // Authorization may block on a human prompt, so the schedule is re-read
    // before committing and the revocation is applied to that fresh record:
    // revoke always wins over a concurrent pause/resume.
    async revokeSchedule(scheduleId, session) {
      const schedule = await repositories.schedules.get(scheduleId);
      if (schedule === undefined) {
        throw new BackgroundJobError("not-found", `No schedule found for scheduleId "${scheduleId}".`);
      }
      const decision = await authorizationService.authorize("schedule-revoke", schedule.launchSpecTemplate, session);
      if (!decision.allowed) {
        throw new BackgroundJobError("authorization-denied", decision.reason);
      }
      await withScheduleLock(scheduleId, async () => {
        const current = await repositories.schedules.get(scheduleId);
        if (current === undefined) {
          throw new BackgroundJobError("not-found", `No schedule found for scheduleId "${scheduleId}".`);
        }
        // Clearing the pause marker is what makes revocation permanent.
        await repositories.schedules.put({ ...current, enabled: false, pausedAt: undefined });
      });
    },

    async listSchedules() {
      return repositories.schedules.list();
    },

    async deleteSchedule(scheduleId) {
      await withScheduleLock(scheduleId, async () => {
        const current = await repositories.schedules.get(scheduleId);
        if (current === undefined) {
          throw new BackgroundJobError("not-found", `No schedule found for scheduleId "${scheduleId}".`);
        }
        // Checked under the lock so a concurrent resume or dispatch cannot slip in between check and delete.
        if (current.enabled) {
          throw new BackgroundJobError(
            "invalid-state",
            `Cannot delete schedule "${scheduleId}": it is still enabled. Pause or revoke it first.`,
          );
        }
        if (await scheduleIsOwned(scheduleId)) {
          throw new BackgroundJobError(
            "invalid-state",
            `Cannot delete schedule "${scheduleId}": a job it launched is still active or a launch is pending.`,
          );
        }
        // Run records first, the schedule last: until it is gone the delete can simply be retried.
        await repositories.occurrences.deleteForSchedule(scheduleId);
        await repositories.schedules.delete(scheduleId);
      });
    },

    async setScheduleEnabled(scheduleId, enabled, session) {
      const schedule = await repositories.schedules.get(scheduleId);
      if (schedule === undefined) {
        throw new BackgroundJobError("not-found", `No schedule found for scheduleId "${scheduleId}".`);
      }
      if (isScheduleRevoked(schedule)) {
        throw new BackgroundJobError("authorization-denied", "This schedule was revoked and cannot be re-enabled. Create a new schedule instead.");
      }
      if (schedule.enabled === enabled) return schedule;
      // Resuming re-allows launches, so it is gated like creation (deny-writes
      // blocks it); pausing is gated like revocation and is never blocked.
      const decision = await authorizationService.authorize(
        enabled ? "schedule-create" : "schedule-revoke",
        schedule.launchSpecTemplate,
        session,
      );
      if (!decision.allowed) {
        throw new BackgroundJobError("authorization-denied", decision.reason);
      }
      if (enabled) {
        // Dispatch revalidates the original grant; fail now rather than
        // silently skipping every future trigger.
        const grant = await authorizationService.revalidateBeforeDispatch(schedule.grantId, schedule.launchSpecTemplate);
        if (!grant.allowed) throw new BackgroundJobError("authorization-denied", grant.reason);
      }
      // Authorization/revalidation may have blocked on a human prompt; recheck
      // the stored record under the schedule lock so a concurrent revoke (or
      // another pause/resume) is never overwritten with the stale snapshot.
      return withScheduleLock(scheduleId, async () => {
        const current = await repositories.schedules.get(scheduleId);
        if (current === undefined) {
          throw new BackgroundJobError("not-found", `No schedule found for scheduleId "${scheduleId}".`);
        }
        if (isScheduleRevoked(current)) {
          throw new BackgroundJobError("authorization-denied", "This schedule was revoked and cannot be re-enabled. Create a new schedule instead.");
        }
        if (current.enabled !== schedule.enabled || current.pausedAt !== schedule.pausedAt) {
          throw new BackgroundJobError("authorization-denied", "This schedule was changed by another session while approval was pending. Retry the pause/resume.");
        }
        const updated: ScheduleRecord = { ...current, enabled, pausedAt: enabled ? undefined : new Date().toISOString() };
        await repositories.schedules.put(updated);
        return updated;
      });
    },

    async listRuns(scheduleId) {
      const [occurrences, jobs] = await Promise.all([
        repositories.occurrences.listForSchedule(scheduleId),
        repositories.jobs.list(),
      ]);
      return occurrences
        .map((occurrence) => ({ occurrence, job: jobs.find((j) => j.requestId === occurrence.requestId) }))
        .sort((a, b) => b.occurrence.createdAt.localeCompare(a.occurrence.createdAt));
    },

    async evaluateOnce({ nowUtc, connectedSessions }) {
      const results: ScheduleEvaluationResult[] = [];

      const schedules = await repositories.schedules.list();
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;

        const fields = parseCronExpression(schedule.cron);
        // Start one minute back so an occurrence due right now is not missed between polls.
        const occurrence = computeNextOccurrence(fields, schedule.timezone, new Date(nowUtc.getTime() - 60_000));
        if (occurrence === undefined || occurrence.utc.getTime() > nowUtc.getTime()) {
          results.push({ scheduleId: schedule.scheduleId, outcome: "no-occurrence-due" });
          continue;
        }

        // A connected deny-writes session suppresses launches. Checked BEFORE reserving, and the
        // skipped slot is never backfilled or retried.
        const restrictive = authorizationService.aggregateRestrictivePolicy(connectedSessions);
        if (restrictive.blocksNewLaunches) {
          results.push({
            scheduleId: schedule.scheduleId,
            outcome: "skipped-restrictive-policy",
            reason: restrictive.reason,
          });
          continue;
        }

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

        // Reserve durably BEFORE dispatch; if another pass already claimed this occurrence, back off.
        const requestId = randomUUID();
        // Re-read under the schedule lock: a revoke/pause committed after the
        // list above must stop this trigger. A revoke landing after the
        // reservation does not cancel it (same as an in-flight job).
        let reserved = false;
        let record: ScheduleOccurrenceRecord | undefined;
        let stillEnabled = true;
        let overlapping = false;
        await withScheduleLock(schedule.scheduleId, async () => {
          const current = await repositories.schedules.get(schedule.scheduleId);
          if (current === undefined || !current.enabled || current.grantId !== schedule.grantId) {
            stillEnabled = false;
            return;
          }
          // One active job per schedule, checked atomically with the reservation so adjacent-slot
          // passes (possibly on other hosts) cannot both launch. Counts non-terminal jobs (unknown /
          // recovery-required included) and still-pending reservations that have no job record yet.
          if (await scheduleIsOwned(schedule.scheduleId)) {
            overlapping = true;
            return;
          }
          ({ reserved, record } = await reserveOccurrence({
            repositories,
            schedule: current,
            occurrenceUtc: occurrence.utc,
            localKey: occurrence.localKey,
            requestId,
          }));
        });
        if (!stillEnabled) {
          results.push({ scheduleId: schedule.scheduleId, outcome: "no-occurrence-due" });
          continue;
        }
        if (overlapping || !reserved) {
          results.push({ scheduleId: schedule.scheduleId, outcome: "skipped-overlap" });
          continue;
        }

        // `scheduleGrant` makes the coordinator launch the exact approved template and revalidate the
        // existing grant; the session below is deliberately non-minting so nothing new can be approved.
        try {
          await coordinator.start(
            {
              requestId,
              invocation: schedule.launchSpecTemplate.invocation,
              cwd: schedule.launchSpecTemplate.cwd,
              isolation: schedule.launchSpecTemplate.isolation,
              env: schedule.launchSpecTemplate.env,
              limits: schedule.launchSpecTemplate.limits,
              scheduleGrant: {
                grantId: schedule.grantId,
                template: schedule.launchSpecTemplate,
                // Runs under the coordinator lock right before the job record is created: a
                // dispatcher resumed after its reservation expired and was fenced must not launch.
                beforeAdmit: async () => {
                  const mine = (await repositories.occurrences.listForSchedule(schedule.scheduleId))
                    .find((o) => o.occurrenceId === record!.occurrenceId);
                  if (mine === undefined || mine.status !== "reserved") {
                    throw new BackgroundJobError(
                      "invalid-state",
                      "This dispatch expired and was fenced; its occurrence was not launched.",
                    );
                  }
                },
              },
            },
            { permissionMode: "ask", headlessApprovedActions: [] },
          );
          await repositories.occurrences.update(record!.occurrenceId, { status: "dispatched" });
          results.push({ scheduleId: schedule.scheduleId, outcome: "dispatched" });
        } catch (error) {
          // Any dispatch failure may be ambiguous, so the occurrence is marked recovery-required and
          // never retried (the reservation holds that slot for good). Non-capacity failures are
          // reported as "skipped-grant-invalid" for lack of a better outcome value.
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
