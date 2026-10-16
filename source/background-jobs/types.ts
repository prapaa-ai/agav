/**
 * Shared contracts for the background-jobs subsystem.
 *
 * Module boundaries (no reverse dependencies):
 *   platform/*        -> implements PlatformAdapter, no imports from storage/ipc/etc.
 *   storage/*, ipc/*  -> consume platform primitives only
 *   authorization     -> consumes storage + launch-spec, never imports coordinator
 *   logging/*         -> reports failures via callback, never imports supervisor/coordinator
 *   supervisor/*      -> does not depend on coordinator lifetime
 *   coordinator       -> the only orchestration owner
 *   tools/, commands/ -> consume the coordinator client API only, never launch directly
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
// Lifecycle vs. stop-control (kept deliberately separate)
// ---------------------------------------------------------------------------

/** "unknown" and "recovery-required" are first-class states, not errors. */
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

/** Accepted/starting/running: the only states a stop request can act on. */
export function isLiveLifecycle(state: LifecycleState): boolean {
  return state === "accepted" || state === "starting" || state === "running";
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

/** Consent is bound to the hash of this object (`specHash`); any material change requires renewed approval. */
export interface LaunchSpec {
  requestId: RequestId;
  invocation: InvocationSpec;
  /** Canonicalized, existence-verified working directory (post symlink/junction resolution). */
  cwd: string;
  /** Minimal constructed environment; never contains raw secret values. */
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
// Capability reporting (never silently assume)
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
// Platform adapter primitives
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

/** Storage/IPC/supervisor code talks to this interface, never to node:child_process or OS primitives directly. */
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
// Storage ownership: one authoritative writer per record kind
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
  /** The supervisor's own identity/ownership (distinct from the workload's), so cleanup can terminate it. Absent if launch failed before it was recorded. */
  supervisorIdentity?: ProcessIdentity;
  supervisorOwnershipHandle?: string;
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
  /** Set while paused (disabled but resumable); a disabled record WITHOUT this is revoked (see `isScheduleRevoked`). */
  pausedAt?: string;
}

export function isScheduleRevoked(schedule: Pick<ScheduleRecord, "enabled" | "pausedAt">): boolean {
  return !schedule.enabled && schedule.pausedAt === undefined;
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

/** Coordinator/supervisor never read/write files directly. */
export interface Repositories {
  specs: {
    put(spec: LaunchSpec): Promise<void>;
    get(requestId: RequestId): Promise<LaunchSpec | undefined>;
    /** No-op when absent. */
    delete(requestId: RequestId): Promise<void>;
  };
  jobs: {
    create(record: JobRecord): Promise<void>;
    /** Single lifecycle writer per job; callers must hold the job lock. */
    update(jobId: JobId, patch: Partial<JobRecord>): Promise<void>;
    get(jobId: JobId): Promise<JobRecord | undefined>;
    list(): Promise<JobRecord[]>;
    /** Resolve an unambiguous full id from a prefix; throws on ambiguity. */
    resolvePrefix(prefix: string): Promise<JobId>;
    /** Takes the job lock; no-op when absent. Callers must have verified the job is not live. */
    delete(jobId: JobId): Promise<void>;
  };
  controlIntents: {
    create(intent: ControlIntent): Promise<void>;
    update(id: string, patch: Partial<ControlIntent>): Promise<void>;
    listForJob(jobId: JobId): Promise<ControlIntent[]>;
    deleteForJob(jobId: JobId): Promise<void>;
  };
  events: {
    create(event: CompletionEventRecord): Promise<void>;
    get(eventId: EventId): Promise<CompletionEventRecord | undefined>;
    listPending(): Promise<CompletionEventRecord[]>;
    /** Also removes the acknowledgements of the deleted events. */
    deleteForJob(jobId: JobId): Promise<void>;
  };
  acks: {
    create(ack: AcknowledgementRecord): Promise<void>;
    get(eventId: EventId): Promise<AcknowledgementRecord | undefined>;
  };
  schedules: {
    put(record: ScheduleRecord): Promise<void>;
    get(scheduleId: ScheduleId): Promise<ScheduleRecord | undefined>;
    list(): Promise<ScheduleRecord[]>;
    /** No-op when absent. */
    delete(scheduleId: ScheduleId): Promise<void>;
  };
  occurrences: {
    reserve(record: ScheduleOccurrenceRecord): Promise<boolean>; // false => already reserved
    update(occurrenceId: OccurrenceId, patch: Partial<ScheduleOccurrenceRecord>): Promise<void>;
    listForSchedule(scheduleId: ScheduleId): Promise<ScheduleOccurrenceRecord[]>;
    deleteForSchedule(scheduleId: ScheduleId): Promise<void>;
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

/** The existing job an action targets. Display-only: it is not part of the consent hash. */
export interface ConfirmSubject {
  jobId: JobId;
  /** The schedule that launched the job; absent for an independent run. */
  parent?: { scheduleId: ScheduleId; cron?: string };
}

/** Session-wide restrictive policy snapshot; authorization consumes this, never the live coordinator. */
export interface SessionPolicySnapshot {
  permissionMode: "ask" | "auto-accept" | "deny-writes";
  headlessApprovedActions: GrantAction[];
  /** Trusted interactive host callback; never populated from tool arguments. */
  confirmBackgroundAction?: (
    action: GrantAction,
    spec: Omit<LaunchSpec, "requestId" | "createdAt">,
    subject?: ConfirmSubject,
  ) => Promise<boolean>;
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
  | "unsupported-platform"
  /** The target exists but is in a state that does not allow the requested operation (e.g. deleting a live job). */
  | "invalid-state"
  /** On-disk store VERSION is newer than BACKGROUND_JOBS_STORAGE_VERSION. */
  | "store-version-newer";

export class BackgroundJobError extends Error {
  constructor(public readonly code: BackgroundJobErrorCode, message: string) {
    super(message);
    this.name = "BackgroundJobError";
  }
}

/**
 * A supervisor launch failure that happened BEFORE any process could have been spawned
 * (e.g. missing supervisor asset), so the job definitely never ran and its capacity can be
 * released. Any other launch failure is ambiguous and is left for reconciliation.
 */
export class PreSpawnLaunchError extends BackgroundJobError {
  constructor(code: BackgroundJobErrorCode, message: string) {
    super(code, message);
    this.name = "PreSpawnLaunchError";
  }
}

// ---------------------------------------------------------------------------
// Coordinator client API
// ---------------------------------------------------------------------------

export interface StartJobRequest {
  requestId: RequestId;
  invocation: InvocationSpec;
  cwd: string;
  envInherit?: string[];
  isolation: IsolationPolicy;
  headless?: boolean;
  /** Explicit env values overlaid on the minimal inherited env (distinct from `envInherit`, a list of names). */
  env?: Record<string, string>;
  /** Partial limits merged over DEFAULT_RESOURCE_LIMITS during launch-spec normalization. */
  limits?: Partial<ResourceLimits>;
  /**
   * Dispatch under an already-approved schedule grant: the coordinator revalidates `grantId`
   * against `template` and launches from `template` rather than the request's own fields.
   */
  scheduleGrant?: {
    grantId: GrantId;
    template: Omit<LaunchSpec, "requestId" | "createdAt">;
    /**
     * Run inside the admission transaction (coordinator lock held), after the idempotent-retry check
     * and before the job record is created. Throwing aborts the launch. A schedule dispatcher uses it
     * to prove its reservation was not fenced, atomically with creating the job.
     */
    beforeAdmit?: () => Promise<void>;
  };
}

export interface JobSummary {
  jobId: JobId;
  requestId: RequestId;
  state: LifecycleState;
  stopState: StopControlState;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  /** Launch command text and working directory, filled by list()/poll() from the persisted LaunchSpec when readable. */
  command?: string;
  cwd?: string;
}

export interface LogTail {
  text: string;
  truncated: boolean;
  cursor: string;
}

/** The only entry point for launching background commands (tools, slash commands, headless, schedules). */
export interface CoordinatorClient {
  start(request: StartJobRequest, session: SessionPolicySnapshot): Promise<JobSummary>;
  list(): Promise<JobSummary[]>;
  poll(jobIdOrPrefix: string): Promise<JobSummary>;
  log(jobIdOrPrefix: string, opts?: { maxBytes?: number; cursor?: string; stream?: "stdout" | "stderr" }): Promise<LogTail>;
  wait(jobIdOrPrefix: string, signal?: AbortSignal): Promise<JobSummary>;
  stop(jobIdOrPrefix: string, session: SessionPolicySnapshot): Promise<JobSummary>;
  cleanup(jobIdOrPrefix: string, session: SessionPolicySnapshot): Promise<void>;
  capabilities(): Promise<PlatformCapabilities>;
  /** Optional — callers must feature-check. */
  findByRequestId?(requestId: RequestId): Promise<JobSummary | undefined>;
}
