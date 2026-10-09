/**
 * T01 — Frozen contracts for the background-jobs subsystem.
 *
 * This file is the single synchronization barrier described in subtasks.md.
 * It defines shared types, protocol/schema versions, lifecycle/uncertainty
 * states, launch-spec shape, capability reporting, storage ownership and
 * platform-adapter primitives so that every other component (T02-T18) can be
 * implemented against stable interfaces without importing each other's
 * internals.
 *
 * Ownership: this module belongs to the integration owner (T01). Other tasks
 * MUST NOT edit it directly — request a versioned contract change instead.
 *
 * Module boundaries (no reverse dependencies):
 *   platform/*        -> implements PlatformAdapter, no imports from storage/ipc/etc.
 *   storage/*         -> consumes platform primitives only
 *   ipc/*             -> consumes platform primitives only
 *   launch-spec.ts    -> pure normalization, consumes platform path/env helpers
 *   authorization.ts  -> consumes storage + launch-spec, never imports coordinator
 *   logging/*         -> reports failures via callback, never imports supervisor/coordinator
 *   supervisor/*      -> consumes storage, ipc, launch-spec, logging, platform; does not
 *                        depend on coordinator lifetime
 *   recovery.ts       -> consumes storage + ipc; returns decisions, does not orchestrate
 *   mailbox.ts        -> consumes storage + ipc; no UI imports
 *   coordinator.ts    -> consumes authorization, supervisor launcher, recovery, mailbox,
 *                        schedule-engine; is the only orchestration owner
 *   schedule-engine.ts-> consumes storage + authorization + coordinator client API
 *   tools/, commands/ -> consume coordinator client API only, never launch directly
 */

// ---------------------------------------------------------------------------
// Protocol / schema versioning
// ---------------------------------------------------------------------------

/** Bump on any wire- or disk-incompatible change. Pinned per-job at launch time. */
export const BACKGROUND_JOBS_PROTOCOL_VERSION = 1;

/** Bump when on-disk record shapes change in an incompatible way. */
export const BACKGROUND_JOBS_STORAGE_VERSION = 1;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Full collision-resistant job identifier (uuid v4). Never truncate for storage paths. */
export type JobId = string;

/** Stable request identity so retries refer to the original launch, not a new one. */
export type RequestId = string;

/** Stable completion-event identity used for mailbox dedup. */
export type EventId = string;

/** Stable authorization grant identity. */
export type GrantId = string;

/** Stable schedule identity (distinct from legacy prompt-schedule ids in config/scheduler.ts). */
export type ScheduleId = string;

/** Stable reserved-occurrence identity for a single schedule trigger instant. */
export type OccurrenceId = string;

/** Opaque per-client/session identity used for mailbox presentation claims. */
export type ClientId = string;

// ---------------------------------------------------------------------------
// Lifecycle vs. stop-control (kept deliberately separate per solution.md §6)
// ---------------------------------------------------------------------------

/**
 * Authoritative job lifecycle. "unknown" and "recovery-required" are first
 * class — they are not errors, they are states a client must be able to
 * render and act on explicitly.
 */
export type LifecycleState =
  | "accepted" // capacity reserved + intent persisted, supervisor not yet confirmed
  | "starting" // supervisor handshake in progress, workload not yet observed running
  | "running" // workload startup observed
  | "completed" // confirmed normal exit, exit code known
  | "failed" // confirmed abnormal exit, exit code/signal known
  | "interrupted" // confirmed stop-induced termination
  | "unknown" // supervisor/coordinator lost contact; no safe evidence either way
  | "recovery-required"; // dispatch may or may not have executed; must not auto-retry

/** Separate from lifecycle: tracks an explicit stop request's own progress. */
export type StopControlState =
  | "none"
  | "requested"
  | "acknowledged"
  | "escalated"
  | "observed-stopped"
  | "observed-completed-first"; // natural completion raced the stop request

export function isTerminalLifecycle(state: LifecycleState): boolean {
  return state === "completed" || state === "failed" || state === "interrupted";
}

export function isUncertainLifecycle(state: LifecycleState): boolean {
  return state === "unknown" || state === "recovery-required";
}

// ---------------------------------------------------------------------------
// Launch specification (immutable once approved; a changed spec needs new consent)
// ---------------------------------------------------------------------------

export type ShellInterpreter = "posix-sh" | "bash" | "cmd" | "powershell";

/** Direct executable/argument invocation OR explicit shell-text invocation — never both. */
export type InvocationSpec =
  | { mode: "direct"; executable: string; args: string[] }
  | { mode: "shell"; interpreter: ShellInterpreter; commandText: string };

export type IsolationBackend =
  | "bubblewrap"
  | "seatbelt"
  | "docker"
  | "job-object" // Windows ownership control, NOT a filesystem/network sandbox
  | "none";

export interface IsolationPolicy {
  /** Backend the caller is requesting, or "none" for explicitly approved unrestricted execution. */
  backend: IsolationBackend;
  /** When true, launch must fail closed if `backend` is unavailable — never silently downgrade. */
  required: boolean;
}

export type ProcessOwnershipScope =
  | "process-group" // POSIX: separate session/process-group for the workload
  | "job-object" // Windows: native Job Object tree ownership
  | "delegated-cgroup" // Linux optional stronger descendant control
  | "unverified"; // ownership could not be established; refuse unless explicitly accepted

export interface RecurrenceBinding {
  scheduleId: ScheduleId;
  /** Version of the schedule's approved terms this launch was authorized under. */
  scheduleVersion: number;
  cron?: string;
  timezone?: string;
}

export interface ResourceLimits {
  logSegmentBytes: number;
  retainedLogBytesPerJob: number;
  aggregatePerUserLogBudgetBytes: number;
  maxConcurrentJobs: number;
  completedLogRetentionDays: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  logSegmentBytes: 5 * 1024 * 1024,
  retainedLogBytesPerJob: 20 * 1024 * 1024,
  aggregatePerUserLogBudgetBytes: 200 * 1024 * 1024,
  maxConcurrentJobs: 4,
  completedLogRetentionDays: 7,
};

/**
 * The complete, approved launch specification. Consent is bound to the hash
 * of this object (see `specHash` in JobRecord / Grant); any material change
 * requires renewed approval.
 */
export interface LaunchSpec {
  requestId: RequestId;
  invocation: InvocationSpec;
  /** Canonicalized, existence-verified working directory (post symlink/junction resolution). */
  cwd: string;
  /** Minimal constructed environment; never contains raw secret values (see EnvPlan). */
  env: Record<string, string>;
  /** Names of credentials resolved at launch time; values never persisted here. */
  credentialRefs: string[];
  isolation: IsolationPolicy;
  ownershipScope: ProcessOwnershipScope;
  limits: ResourceLimits;
  recurrence?: RecurrenceBinding;
  /** True only for a separately, explicitly approved headless execution path. */
  headless: boolean;
  createdAt: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Capability reporting (T02/T03/T04 fill these in; never silently assume)
// ---------------------------------------------------------------------------

export interface PlatformCapabilities {
  platform: "linux" | "darwin" | "win32";
  /** Isolation backends this host can actually use right now, not merely theoretically. */
  availableIsolationBackends: IsolationBackend[];
  /** Strongest ownership scope this host/adapter can currently guarantee. */
  strongestOwnershipScope: ProcessOwnershipScope;
  supportsGracefulApplicationShutdown: boolean;
  supportsDelegatedCgroup: boolean;
  nativeHelperAvailable: boolean;
  /** Human-readable reasons for any capability that is unavailable. */
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Platform adapter primitives (T02/T03/T04 implement; others consume only this)
// ---------------------------------------------------------------------------

export interface ProcessIdentity {
  pid: number;
  /** Best-effort boot/process-creation identity (e.g. Linux /proc start time, Windows CreationTime). */
  creationIdentity: string;
}

export interface DetachedLaunchResult {
  identity: ProcessIdentity;
  /** Opaque adapter-specific ownership handle (process group id, Job handle ref, cgroup path, ...). */
  ownershipHandle: string;
  ownershipScope: ProcessOwnershipScope;
}

export interface StopOutcome {
  observedStopped: boolean;
  escalated: boolean;
  /** True when the adapter can state no owned descendants remain (e.g. cgroup empty check). */
  verifiedNoDescendants: boolean;
  limitations: string[];
}

/**
 * Boundary every OS-specific implementation must satisfy. Storage/IPC/
 * supervisor code must only ever talk to this interface, never to
 * node:child_process or OS primitives directly, so behavior stays uniform.
 */
export interface PlatformAdapter {
  readonly platform: "linux" | "darwin" | "win32";

  detectCapabilities(): Promise<PlatformCapabilities>;

  /** Canonicalize a path (resolve symlinks/junctions) and verify it exists. Throws if missing. */
  canonicalizePath(path: string): Promise<string>;

  /** Acquire an OS-held exclusive lock file at `path`. Returns a release function. Never deletes a held lock. */
  acquireLock(path: string): Promise<() => Promise<void>>;

  /** Start the per-job supervisor process fully detached from the current TTY/parent lifetime. */
  launchDetachedSupervisor(args: {
    supervisorEntry: string;
    argv: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<DetachedLaunchResult>;

  /** True only when there is positive evidence the identity is still the same live process. */
  verifyAlive(identity: ProcessIdentity): Promise<boolean>;

  /** Graceful stop of the owned workload scope, bounded grace, then adapter-appropriate escalation. */
  stopOwnedScope(ownershipHandle: string, ownershipScope: ProcessOwnershipScope, graceMs: number): Promise<StopOutcome>;

  /** Force-terminate the owned workload scope. Last resort; still returns verification evidence. */
  forceStopOwnedScope(ownershipHandle: string, ownershipScope: ProcessOwnershipScope): Promise<StopOutcome>;
}

// ---------------------------------------------------------------------------
// Storage ownership: one authoritative writer per record kind (solution.md §7)
// ---------------------------------------------------------------------------

export interface JobRecord {
  jobId: JobId;
  requestId: RequestId;
  specHash: string;
  protocolVersion: number;
  state: LifecycleState;
  stopState: StopControlState;
  identity?: ProcessIdentity;
  ownershipHandle?: string;
  ownershipScope?: ProcessOwnershipScope;
  /** The per-job SUPERVISOR process's own identity (distinct from `identity`, which is the workload's). Used so a future cleanup/reaping flow can terminate the supervisor itself via PlatformAdapter.stopOwnedScope. Optional: older records predating this field, and any job whose launch failed before the supervisor's identity was recorded, will not have it. */
  supervisorIdentity?: ProcessIdentity;
  /** Opaque ownership handle for the supervisor process itself (see PlatformAdapter.DetachedLaunchResult.ownershipHandle). */
  supervisorOwnershipHandle?: string;
  /** Ownership scope for the supervisor process itself (see PlatformAdapter.DetachedLaunchResult.ownershipScope). */
  supervisorOwnershipScope?: ProcessOwnershipScope;
  /** Random value established at supervisor handshake; distinguishes PID reuse. */
  nonce: string;
  startedAt?: string;
  heartbeatAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  resultEventId?: EventId;
  /** Set when reconciliation could not establish a safe outcome. */
  uncertaintyReason?: string;
}

export interface ControlIntent {
  id: string;
  jobId: JobId;
  kind: "stop" | "cleanup";
  requestedAt: string;
  status: "pending" | "acknowledged" | "completed" | "failed";
}

export interface CompletionEventRecord {
  eventId: EventId;
  jobId: JobId;
  outcome: "completed" | "failed" | "interrupted";
  exitCode: number | null;
  signal: string | null;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  truncated: boolean;
  createdAt: string;
}

export interface AcknowledgementRecord {
  eventId: EventId;
  clientId: ClientId;
  acknowledgedAt: string;
}

export interface ScheduleRecord {
  scheduleId: ScheduleId;
  version: number;
  cron: string;
  timezone: string;
  launchSpecTemplate: Omit<LaunchSpec, "requestId" | "createdAt">;
  grantId: GrantId;
  enabled: boolean;
  createdAt: string;
}

export interface ScheduleOccurrenceRecord {
  occurrenceId: OccurrenceId;
  scheduleId: ScheduleId;
  /** Local-time trigger instant this occurrence represents; prevents replay after clock rollback. */
  occurrenceKey: string;
  requestId: RequestId;
  status: "reserved" | "dispatched" | "skipped" | "recovery-required";
  reason?: string;
  createdAt: string;
}

/** Repository boundary for T05. Coordinator/supervisor never read/write files directly. */
export interface Repositories {
  specs: {
    put(spec: LaunchSpec): Promise<void>;
    get(requestId: RequestId): Promise<LaunchSpec | undefined>;
  };
  jobs: {
    create(record: JobRecord): Promise<void>;
    /** Single lifecycle writer per job; callers must hold the job lock. */
    update(jobId: JobId, patch: Partial<JobRecord>): Promise<void>;
    get(jobId: JobId): Promise<JobRecord | undefined>;
    list(): Promise<JobRecord[]>;
    /** Resolve an unambiguous full id from a prefix; throws on ambiguity. */
    resolvePrefix(prefix: string): Promise<JobId>;
  };
  controlIntents: {
    create(intent: ControlIntent): Promise<void>;
    update(id: string, patch: Partial<ControlIntent>): Promise<void>;
    listForJob(jobId: JobId): Promise<ControlIntent[]>;
  };
  events: {
    create(event: CompletionEventRecord): Promise<void>;
    get(eventId: EventId): Promise<CompletionEventRecord | undefined>;
    listPending(): Promise<CompletionEventRecord[]>;
  };
  acks: {
    create(ack: AcknowledgementRecord): Promise<void>;
    get(eventId: EventId): Promise<AcknowledgementRecord | undefined>;
  };
  schedules: {
    put(record: ScheduleRecord): Promise<void>;
    get(scheduleId: ScheduleId): Promise<ScheduleRecord | undefined>;
    list(): Promise<ScheduleRecord[]>;
  };
  occurrences: {
    reserve(record: ScheduleOccurrenceRecord): Promise<boolean>; // false => already reserved
    update(occurrenceId: OccurrenceId, patch: Partial<ScheduleOccurrenceRecord>): Promise<void>;
    listForSchedule(scheduleId: ScheduleId): Promise<ScheduleOccurrenceRecord[]>;
  };
}

// ---------------------------------------------------------------------------
// Authorization / grants
// ---------------------------------------------------------------------------

export type GrantAction = "start" | "stop" | "cleanup" | "schedule-create" | "schedule-revoke" | "headless-start";

export interface Grant {
  grantId: GrantId;
  action: GrantAction;
  specHash: string;
  createdAt: string;
  revokedAt?: string;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason: string;
  /** When allowed, the grant that authorized it (new or pre-existing). */
  grant?: Grant;
}

/** Session-wide restrictive policy snapshot; authorization consumes this, never the live coordinator. */
export interface SessionPolicySnapshot {
  permissionMode: "ask" | "auto-accept" | "deny-writes";
  headlessApprovedActions: GrantAction[];
  /** Trusted interactive host callback; never populated from tool arguments. */
  confirmBackgroundAction?: (action: GrantAction, spec: Omit<LaunchSpec, "requestId" | "createdAt">) => Promise<boolean>;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Error / uncertainty semantics
// ---------------------------------------------------------------------------

export type BackgroundJobErrorCode =
  | "capacity-exceeded"
  | "isolation-unavailable"
  | "authorization-denied"
  | "spec-changed"
  | "ambiguous-id"
  | "not-found"
  | "storage-unavailable"
  | "lock-held"
  | "recovery-required"
  | "unsupported-platform";

export class BackgroundJobError extends Error {
  constructor(public readonly code: BackgroundJobErrorCode, message: string) {
    super(message);
    this.name = "BackgroundJobError";
  }
}

// ---------------------------------------------------------------------------
// Coordinator client API (T14 implements; T16 tools/commands consume only this)
// ---------------------------------------------------------------------------

export interface StartJobRequest {
  requestId: RequestId;
  invocation: InvocationSpec;
  cwd: string;
  envInherit?: string[];
  isolation: IsolationPolicy;
  headless?: boolean;
}

export interface JobSummary {
  jobId: JobId;
  requestId: RequestId;
  state: LifecycleState;
  stopState: StopControlState;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
}

export interface LogTail {
  text: string;
  truncated: boolean;
  cursor: string;
}

/**
 * The one entry point tools, slash commands, headless clients and schedules
 * must all go through. No background command is ever launched by any other
 * code path.
 */
export interface CoordinatorClient {
  start(request: StartJobRequest, session: SessionPolicySnapshot): Promise<JobSummary>;
  list(): Promise<JobSummary[]>;
  poll(jobIdOrPrefix: string): Promise<JobSummary>;
  log(jobIdOrPrefix: string, opts?: { maxBytes?: number; cursor?: string }): Promise<LogTail>;
  wait(jobIdOrPrefix: string, signal?: AbortSignal): Promise<JobSummary>;
  stop(jobIdOrPrefix: string, session: SessionPolicySnapshot): Promise<JobSummary>;
  cleanup(jobIdOrPrefix: string, session: SessionPolicySnapshot): Promise<void>;
  capabilities(): Promise<PlatformCapabilities>;
}
