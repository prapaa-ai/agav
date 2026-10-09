# Background processes: cross-platform solution design

Step 2 design artifact. This selects the architecture for the final repository-root `solution.md`; it does not implement the feature or claim that platform behavior has been tested.

Inputs: [requirements review](pr-241-solution-requirements.md) and [PR knowledge capture](pr-241-background-process-knowledge.md). Where they disagree, the requirements review supersedes the original capture.

## 1. Scope and guarantees

Introduce an opt-in background execution service, separate from the short-command tool. It launches approved long-running jobs, retains bounded output, supports observation and explicit stopping, and reconnects after Agav restarts. Command schedules skip LLM execution while retaining the same authorization boundary.

The shared contract on Linux, Windows and macOS is:

- Ordinary CLI exit disconnects the client, not the job. Cancelling an observation or wait does not stop the job.
- Launch reports accepted, starting or running accurately; accepting a request does not imply successful command startup.
- Status reflects observed outcomes, including uncertainty. A stop request is not a confirmed termination.
- Commands, environments and sandbox capabilities are platform-specific; lifecycle and policy behavior are consistent.
- Existing `run_command` and prompt schedules retain their behavior.

Baseline exclusions: automatic restart after reboot, execution of schedules while no interactive client is connected, survival of logout or administrator/service-manager teardown, portable strong containment of arbitrary escaping descendants, and exactly-once execution or notification. Optional service integration can address some exclusions later, with separate consent.

## 2. Architecture and ownership

Use one on-demand coordinator per user and state directory, with an independent supervisor per job. The coordinator is not an installed OS service: it starts when a client connects and may exit after its clients disconnect and pending control operations settle. Job supervisors continue independently.

| Component | Responsibility |
| --- | --- |
| Tool and slash-command adapters | Present capabilities, collect consent, submit requests, display results. No direct launch path. |
| Coordinator | Common authorization, idempotent requests, schedule evaluation, concurrency reservations, client routing and delivery acknowledgements. |
| Per-job supervisor | Own the launched workload, maintain lifecycle state and heartbeat, handle stop requests, consume output and emit completion events. |
| Platform adapter | Detached startup, workload ownership, identity checks, supported termination, local IPC and private storage access. |
| Versioned storage | Immutable launch specifications, supervisor-owned lifecycle state, coordinator-owned control intents, schedule reservations and event acknowledgements. |

One authenticated local IPC boundary serves interactive tools, headless clients, slash commands and schedule triggers. Unix sockets and Windows named pipes receive user-restricted access controls. Client identity alone is not consent: each request still passes policy checks.

A kernel-held coordinator lock and a separate per-job writer lock prevent competing owners. Use the appropriate native locking primitive on each OS, with stable lock objects that are not deleted/replaced while participants may hold them. Never steal a lock solely because a timestamp expires. A hung owner is unavailable until it exits or is explicitly recovered.

The coordinator exclusively writes launch intents and controls; the supervisor exclusively writes normal lifecycle state. A recovery owner may change lifecycle state only after acquiring its lock and reconciling live ownership evidence. UI acknowledgements never rewrite job state. This avoids the PR's parent/runner/UI read-modify-write races.

Trade-off: a coordinator and a small platform adapter add packaging and lifecycle complexity, but eliminate duplicate cron dispatch, divergent permission gates and multi-writer state corruption.

## 3. Launch specification and authorization

Resolve a complete, immutable specification before approval: executable and arguments or exact shell string/interpreter; canonical working directory; environment policy and credential references; isolation backend and access policy; ownership scope; concurrency, duration and logging limits; and manual or recurring execution.

Prefer executable-plus-arguments invocation. Shell mode remains available for user-approved pipelines and scripts, but approval covers that exact shell text and interpreter. Do not rewrite or translate shell syntax between OSes.

The shared policy evaluator applies these rules:

1. Read-only observation requires access to the owning user's job and appropriate project scope. Start, stop, cleanup and recurring-grant changes are separate sensitive actions.
2. Deny-writes blocks new background launches and schedule launches even when a previous recurring grant exists. Stop remains separately governed because emergency termination can be necessary in a restricted session; never classify it as read-only or silently permit it.
3. Headless starts require an explicit matching grant or policy rule. Without one, fail with an actionable message; do not silently approve because no dialog exists.
4. Resolve isolation capabilities before consent. Required isolation unavailable means refusal. Unrestricted execution is a distinct, explicitly approved mode, not fallback from a failed sandbox.
5. Bind approval to the full specification and policy revision, not just a command pattern. Restricted grants distinguish start from stop and cannot be widened by a supplied unrelated field.
6. Validate the specification again at dispatch; changed executable identity, interpreter, directory, access scope or limits require renewed authorization. Command file changes cannot be made fully race-free by hashes; disclose that this is approval binding, not a defence against a malicious same-user actor.

Destructive-command patterns remain defence-in-depth warnings or policy blocks. They do not parse every shell grammar or establish safety. Remove the proposed blanket `--force` bypass and the idea that an `approved: true` record establishes trust.

Threat boundary: private state and IPC protect against accidental edits and other users. They do not protect against malicious unsandboxed code running as the same OS user. Use a verified isolation backend or a separate execution identity for that threat; do not claim otherwise.

## 4. Platform adaptations

| Concern | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Detached supervisor | New session, independent streams and no UI terminal dependency. | Same POSIX baseline. | Independent detached process with no inherited UI pipes; inspect inherited Job Object constraints. |
| Workload ownership | Separate workload process group. Optional delegated cgroup provides stronger descendant ownership. | Separate workload process group; no portable cgroup equivalent. | Packaged native helper creates a Job Object, starts workload suspended, assigns it, then resumes. |
| Stop | Graceful group termination, bounded grace, forced group/cgroup termination where supported. | Same group strategy, with explicit escape limitation. | Application-level graceful request only when configured/supported; otherwise disclosed forced Job Object termination. |
| Identity | Supervisor handshake plus launch nonce and boot/process-start identity; kernel process handles when supported. | Supervisor handshake plus creation identity where available; otherwise mark weaker recovery evidence. | Supervisor handshake plus retained process handles/creation time and owned Job identity. |
| Shell | Explicit POSIX shell, normally `/bin/sh`; Bash only when selected and present. | Explicit POSIX shell; do not assume the user's interactive shell or Bash version. | Explicit `cmd.exe` or PowerShell mode with distinct grammar; `.cmd`/`.bat` shims handled deliberately. |
| Isolation | Detect Bubblewrap/namespace restrictions; optional container backend if usable for durable jobs. | Detect and validate supported Seatbelt tooling/policy; acknowledge deprecated tooling and unavailable configurations. | Job Objects are not a filesystem/network sandbox. Baseline isolation-required launches are unavailable unless a separately validated backend is installed. |
| Private storage | Owner-only directories/files, reject unsafe links or ownership. | Same POSIX permissions plus filesystem-specific canonical paths. | User-restricted ACLs; handle junctions, drive paths, UNC paths and case-insensitive environment names. |

Process groups cover ordinary descendants, not applications that deliberately daemonize or change group/session. Linux cgroups, where available, and Windows Job Objects provide stronger ownership; neither is automatically a security sandbox. Expose the effective scope before launch. A request requiring stronger ownership must fail when the platform cannot supply it.

On Windows, keep a native helper alive with the sole non-inheritable Job handle and kill-on-last-handle-close semantics. Disallow workload breakaway. Failed suspended-child assignment aborts launch before any workload runs. Loss of the runner/helper control connection requests tree termination; helper crash closes its handle. Still reconcile observed outcomes rather than assuming instant tree death. Nested or inherited Job restrictions can invalidate detachment; reject incompatible environments instead of degrading to raw PID termination.

The POSIX supervisor stays outside the workload group so it can stop the group and finish recording results. Supervisor failure may leave workload descendants alive; group IDs and historical PIDs alone cannot authorize later cleanup. If identity cannot be established safely, report recovery-required and request manual intervention.

## 5. Lifecycle, stopping and recovery

Separate lifecycle states from control state. Lifecycle includes starting, running, completed, failed, interrupted and unknown/recovery-required; stop control includes requested, acknowledged and pending outcome. Terminal success requires an observed successful exit, never disappearance or timeout.

Startup sequence: reserve capacity and persist the approved intent; start the pinned supervisor; establish its identity and workload ownership; observe command startup; publish running. Stable request IDs prevent a client retry from launching another copy. Reuse of an ID with different contents is rejected.

If a launch response is lost, reconnect to the original intent/supervisor. If the crash happened around child creation and execution is ambiguous, do not relaunch automatically. Exactly-once execution is not guaranteed; commands needing safe retries must supply their own idempotency.

Use supervisor heartbeat and authenticated reconnect for responsiveness. A missed heartbeat triggers investigation, not immediate failure. Quiet logs are valid. PID existence or permission-denied probes are inconclusive; never signal a process based solely on a persisted PID. Reboot/boot-identity changes invalidate old live ownership claims.

Stop is an idempotent request to the supervisor, with a bounded grace period and optional approved escalation. It targets only verified owned workloads. The supervisor remains alive to drain output and publish the actual result. Natural completion racing with stop can remain normal completion. Unsupported signal names are rejected; portable clients use stop intent rather than pretending Windows has POSIX graceful signals.

Wait subscribes to state changes with a timeout and cancellation. Cancellation releases the observer immediately and returns current state; the job is unaffected.

## 6. Persistence and packaging

Resolve the state directory to an absolute path before spawning anything; keep the existing Agav config-directory convention. Custom state directories must be local, user-private and support the required locking/publication semantics. Reject unsuitable network/shared storage rather than promising NFS/SMB safety.

Use full collision-resistant job IDs; prefixes are accepted only when uniquely matched. Identifiers are not paths. Derive record/log paths inside the validated state root rather than trusting record-supplied arbitrary paths. Quarantine malformed records with visible diagnostics; never silently turn unreadable state into an empty successful job list.

Publish versioned state with same-filesystem atomic replacement and an explicit file/directory flush strategy supported by the platform. Readers close handles promptly. Windows sharing violations get bounded retries; never delete the last good record to make replacement work. Atomicity and durability are separate properties; document guarantees on supported filesystems and treat incomplete/corrupt publications conservatively.

Persistent state includes request IDs, launch nonce, protocol version, identity evidence, revision, real exit status, termination reason and stable completion-event ID. If storage fails, do not acknowledge an unpersisted operation or report a guessed terminal result.

Ship immutable versioned supervisor assets. npm installations use the supported Node runtime; standalone releases provide a bundled supervisor runtime or validated internal supervisor mode. Do not assume `process.execPath` is Node or require a runtime download at job start. Windows helper binaries must be released for every supported architecture. Validate runtime overrides before launch.

Pin active jobs to their protocol/asset version, retain those assets until their jobs finish, and preserve compatibility during upgrades. An incompatible client may inspect known metadata but must refuse unsafe control or migration of active jobs.

## 7. Environment and command paths

Construct an explicit environment instead of inheriting everything and applying a substring regex. Preserve documented platform essentials such as search paths, home/temp locations and Windows system variables; normalize Windows key casing and prohibit duplicate case variants.

Filter runtime-injection variables by default, including interpreter options and dynamic-loader hooks. Let users opt into additional named variables after disclosure. Credential inheritance requires explicit consent and credential references resolved at launch; never persist credential values in job records, grants or diagnostics. Explain missing/filtered variable names without exposing values. This is not protection against a command that can read the user's credential files.

Canonicalize the approved working directory through symlinks/junctions, ensure it exists and is a directory, and bind outside-project use to explicit consent. Reject filesystem roots by default unless specifically approved. Directory restrictions reduce accidents; sandbox policies, not the working directory, enforce access boundaries.

Executable lookup and quoting belong to the platform adapter. Windows argument serialization, paths with spaces/non-ASCII characters and batch shims need defined behavior; never compose them using POSIX quoting rules.

## 8. Bounded logs and resource policy

The supervisor consumes stdout/stderr pipes and writes fixed-size numbered segments. Workloads never hold retained-log descriptors. Rotate by closing a segment and opening the next, not renaming an active descriptor. Segment deletion waits for owned readers to close; Windows sharing failures have bounded retries.

Suggested opt-in release defaults: 5 MiB segments, 20 MiB retained per job across both streams, 200 MiB per-user log budget, 4 concurrently running jobs and 7-day completed-log retention. These are configurable starting policies, not established performance limits. Reserve aggregate capacity before launch; metadata and temporary-file budgets are accounted separately. Optional CPU/memory enforcement is capability-dependent and must not be advertised universally.

Enforce byte budgets even for a single enormous line or invalid UTF-8. Drain pipes while retaining only bounded output. If deletion or disk writes fail, do not grow beyond the quota or block the child indefinitely: apply the approved logging-failure policy, by default request stop and drain/discard during termination. Escaped descendants may remain; report this limitation. Track dropped bytes and retention gaps when persistence is available.

Log reads use byte-bounded tails/cursors across segments, with line counts as a presentation preference. Metadata-only list/poll never read log contents. Completion excerpts have a small total byte budget and labelled stdout/stderr sections, weighted by outcome. Preserve real exit codes and sanitize terminal control sequences; output is untrusted data, not tool instructions.

Cleanup is a separate sensitive action. It never deletes active/unknown job evidence or assets, and reports protected entries. Completed result summaries and unacknowledged completion events remain after log expiry. If their bounded metadata budget is exhausted, block new starts and ask for acknowledged cleanup/export; do not silently discard pending events.

## 9. Completion delivery

Publish terminal state and a stable completion event together. The coordinator discovers events on reconnect and assigns each to one live client. The client deduplicates using the event ID, presents the message and acknowledges presentation; acknowledgement is independently persisted by the coordinator.

Subscriber exceptions are isolated and observable. Failure to acknowledge leaves the event pending; it cannot cause an uncontrolled polling storm. Retry transient failures with bounded backoff and surface persistent failure in the job/event list. On client disconnect, unacknowledged presentation claims can be reassigned; never infer acknowledgement from a timeout.

Guarantee replay of retained pending events, not exactly-once human-visible delivery. A crash between presentation and acknowledgement can produce a duplicate; a timestamp written first can lose a message. Shared per-user acknowledgement avoids every simultaneous session announcing the same completion, while all sessions can still inspect results. Successful job execution is independent of notification success.

## 10. Scheduling design

The coordinator is the single evaluator across connected sessions. It evaluates schedules only while at least one interactive session is attached, preserving the documented baseline. Existing prompt schedules continue to submit prompts with no schema incompatibility; process schedules use the shared launch path.

Creating a process schedule requires explicit recurring consent covering command, interpreter, directory, isolation, environment policy, cadence/timezone and limits. Changing those terms invalidates the grant. At trigger time recheck current restrictive policies and capabilities; do not request surprise unattended approval, silently downgrade isolation or use an expired grant. Any deny-writes session connected to the coordinator suppresses process-schedule launches while it remains attached; other restrictive policies are combined conservatively. Existing jobs are not automatically stopped.

Reserve each schedule occurrence durably with a schedule-version/time-slot identity before dispatch, associate it with a stable launch request, and reconcile after crashes. An uncertain dispatch is not retried automatically. This avoids routine duplicate dispatch, but does not promise exactly-once command effects.

Default overlap policy: one active job per schedule, with unknown jobs counting as active; skip overlapping/capacity-blocked occurrences and record the reason. Do not accumulate an unbounded queue or backfill disconnected downtime. Validate cron grammar/ranges at creation, preserve command whitespace verbatim, persist a timezone, and specify DST behavior: nonexistent local times are skipped; repeated local times execute at most once per local occurrence. Clock rollback cannot replay a persisted occurrence.

When resuming after downtime, future eligible ticks resume normally; no catch-up. A blocked or failed occurrence records its reason and does not retry within the same slot. Unavailable cwd/credentials/backend, invalid consent and policy revocation produce visible schedule diagnostics. Revocation blocks future starts; stopping an existing job is a separate action.

## 11. Failure handling and dependency assumptions

| Failure | Required behavior |
| --- | --- |
| CLI/coordinator exits | Existing supervisors continue; reconnect before controls resume. Schedules pause when no interactive client is attached. |
| Runner/helper dies | Reconcile ownership; use confirmed interruption only when supported by evidence, otherwise recovery-required. Never infer success. |
| Disk full/sharing denial | Bounded retries, no unpersisted acknowledgements, refuse new launches, apply logging-failure policy to running jobs. |
| Owner hangs | Report unavailable; do not steal locks or launch a duplicate workload. |
| Required sandbox/helper/runtime absent | Reject launch with the missing capability named. |
| Upgrade while job runs | Retain pinned assets/protocol; refuse incompatible control instead of replacing the runner. |
| Sleep/clock change | Heartbeat gaps are not proof of death; scheduling resumes without replaying recorded slots. |
| Reboot/logout/session teardown | No automatic rerun; report interrupted or unknown according to available evidence. |

The portable release requires validated detached startup, private IPC/storage, native locking and Windows Job Object support. Optional cgroups, sandbox tools and application-specific graceful shutdown have separate capability flags. No shell script, `taskkill` PID walk or generic POSIX signal emulation substitutes for unavailable verified ownership.

## 12. Design decisions for final integration

Keep the durable record/supervisor approach and action-aware consent; replace stamp-only notifications, raw PID cleanup, unbounded inherited log files and string-regex environment filtering. Add shared coordinator ownership, immutable launch grants, Windows native ownership support and explicit uncertainty states. Remove ordinary-exit job termination and sandbox equivalence assumptions.

Step 3 should consolidate this design into `solution.md`, including phased rollout and concrete acceptance criteria for all three OSes. This artifact intentionally stops at architecture and behavioral decisions: no production changes, source implementation snippets or executed platform compatibility tests.
