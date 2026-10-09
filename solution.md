# Solution plan: reliable background jobs on Linux, Windows and macOS

**Status:** Proposed design and delivery plan; not an implemented feature.

**Scope:** Reintroduce the useful ideas from [PR #241](https://github.com/prapaa-ai/agav/pull/241), correcting its lifecycle, authorization, persistence and resource-management weaknesses. That PR was closed without merging, so this is a plan to introduce the feature—not a patch to an existing production `process` tool.

**Supporting analysis:** [Knowledge capture](pr-241-background-process-knowledge.md), [corrected requirements](pr-241-solution-requirements.md), and [cross-platform design](pr-241-solution-design.md). This final plan supersedes conflicting recommendations in the original capture. Its exploratory probes are not evidence of end-to-end compatibility on all platforms.

## 1. Problem and motivation

The existing short-command tool has a 30-second timeout, captures output for the current turn, and owns commands within that turn. It should remain suitable for quick commands; increasing its timeout or abandoning its sandbox would not create reliable background execution.

Users need to start approved builds, tests, scripts and dev servers without blocking conversation, inspect bounded logs, explicitly stop work, and reconnect after exiting Agav. Recurring shell commands also need a scheduling path that does not require an LLM turn on every trigger.

The original PR chose a sound foundation—detached supervisors and persisted job records—but left important edges unresolved: dead records, competing writers, premature killed statuses, notification failures, unlimited logs, ambiguous identifiers and divergent schedule authorization.

## 2. Recommended solution and guarantees

Introduce an **opt-in background-job subsystem** with one on-demand coordinator per user/state directory and one independent supervisor per job. Use a shared behavioral contract with OS-specific execution adapters.

The subsystem must provide:

- Non-blocking launch, with distinct accepted, starting and running outcomes.
- Job survival across ordinary CLI exit and reconnection to the original job.
- Authoritative lifecycle reporting, including explicit unknown/recovery-required states.
- Bounded retained output and bounded log reads.
- Authorized, retry-safe stop requests and cancellable waits.
- Recurring command schedules with explicit consent and trigger-time checks.
- Explicit disclosure of isolation and process-ownership capabilities.

**Not guaranteed in the baseline:** survival of reboot/logout or administrator teardown; automatic restart; schedules running without an interactive Agav session; complete containment of deliberately escaping POSIX descendants; exactly-once command effects or human-visible notification delivery. These are separate future capabilities, not implied by “detached.”

Existing `run_command` and `/schedule add` prompt behavior remain compatible. No background command is launched merely because the feature is installed or a model chooses its name.

## 3. Architecture and separation of responsibilities

| Component | Responsibility |
| --- | --- |
| Tool and slash-command adapters | Present capabilities and warnings, obtain consent, submit requests and display results. Never launch directly. |
| Per-user coordinator | Authorize all entry points; reserve capacity; handle idempotent controls; evaluate command schedules; route completion events and persist acknowledgements. |
| Per-job supervisor | Own the workload, maintain job state and heartbeat, consume output, handle stop requests and publish the observed result. |
| Platform adapter | Detached startup, local IPC, process identity, ownership/termination, native locks and storage permissions. |
| Private versioned storage | Immutable launch specifications, lifecycle state, control intents, schedule occurrence records and event acknowledgements. |

The coordinator starts on demand. It may exit after clients disconnect and pending controls settle; supervisors do not depend on its lifetime. Scheduling runs only while an interactive client is attached.

Use authenticated, user-restricted local IPC: Unix sockets on Linux/macOS and named pipes on Windows. The coordinator remains the common authorization boundary for model tools, manual commands, headless clients and schedules.

**Trade-off:** this is more infrastructure than one generated runner script, but it removes duplicate dispatch, permission-path divergence and competing writes without requiring installation of an always-on OS service.

## 4. Authorization, isolation and trust

Before approval, resolve a complete launch specification: executable/arguments or exact shell text and interpreter; canonical directory; environment and credential references; isolation/backend policy; process-ownership scope; concurrency/duration/logging limits; and manual or recurring execution.

Bind consent to that specification and revalidate before dispatch. Material changes require renewed approval. Scoped policy rules distinguish start, stop and cleanup; irrelevant request fields cannot widen a grant.

- Observation is read-only, subject to job ownership/project access. Start, stop, cleanup and schedule-consent changes are separate sensitive actions.
- Deny-writes blocks new manual and scheduled launches, including previously approved recurring launches. Stop is separately authorized so an explicitly requested emergency stop remains possible; it is never silently treated as safe introspection.
- Headless execution needs an explicit applicable grant; absent a handler is not consent.
- Schedule creation authorizes repetition explicitly, not just the first execution. Revocation blocks future launches; it does not silently terminate existing work.
- Determine the actual isolation backend before approval. Required isolation unavailable means refusal. Explicitly approved unrestricted execution is a separate mode; never downgrade silently.
- Regex destructive-command checks remain warnings/defence in depth, not a comprehensive shell security model. Do not add a blanket force flag that bypasses authorization.

Private files and IPC restrict other users and accidental changes. They do **not** defend against malicious unrestricted commands running as the same OS user. Directory checks, filtered secrets, command hashes or an approval Boolean do not change that boundary. Stronger threats require a validated sandbox or separate execution identity.

## 5. Cross-platform execution design

| Concern | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Supervisor lifetime | Separate session and independent streams, without UI terminal dependencies. | Same POSIX baseline. | Independent detached process; validate inherited Job Object restrictions and avoid UI pipes. |
| Workload ownership | Separate process group; optional delegated cgroup for stronger descendant control. | Separate process group; disclose that daemonized/escaped descendants are outside the baseline. | Native helper owns a Job Object; launch suspended, assign, then resume. No workload breakaway. |
| Graceful stop | Termination request to the verified owned group, bounded grace, then approved escalation. | Same group strategy. | Configured application shutdown where supported; otherwise disclose forced termination. POSIX signal names are not a graceful Windows contract. |
| Strong stop | Group stop with escape caveat; cgroup-empty verification when available. | Group stop with escape caveat; no portable cgroup equivalent. | Job Object tree termination and observed active-process accounting. |
| Shell | Explicit POSIX shell, usually `/bin/sh`; Bash only when selected and available. | Explicit shell, not an assumption about the user's interactive shell. | Explicit `cmd.exe` or PowerShell mode, with distinct grammar and batch-shim handling. |
| Isolation | Detect usable Bubblewrap/namespaces or separately supported container backend. | Validate supported Seatbelt tooling/policy; acknowledge tooling deprecation/availability limitations. | Job Objects are ownership/resource controls, not filesystem/network sandboxes. Isolation-required launch needs a separately validated backend. |
| Filesystem and access | Local private storage, owner-only permissions and canonical paths. | Same, including symlink and filesystem casing considerations. | User-restricted ACLs, junctions, drive/UNC paths, sharing rules and case-insensitive environment names. |

The workload group is separate from the POSIX supervisor, allowing the supervisor to drain output and publish a final result after termination. Process groups do not contain descendants that deliberately escape; show the effective ownership scope before launch. Reject requests requiring stronger ownership when it is unavailable.

On Windows, package a long-lived native helper that retains the sole non-inheritable Job handle with kill-on-last-handle-close behavior. Failed Job assignment must terminate the suspended child before workload execution. Helper crash or loss of its supervisor connection initiates tree termination; reconciliation still checks outcomes rather than assuming immediate success. Incompatible inherited/nested Jobs make launch unavailable, not a reason to fall back to raw PID killing.

All three platforms support the normal approved lifecycle. They do not offer identical sandboxing or graceful shutdown mechanisms. Capability reporting and fail-closed behavior are mandatory parts of compatibility.

## 6. Lifecycle, identity and recovery

Keep lifecycle separate from stop control. Lifecycle covers starting, running and confirmed completion/failure/interruption, plus unknown/recovery-required. Stop control covers requested, acknowledged and awaiting observed outcome.

Launch first reserves capacity and persists an authorized intent; then starts the pinned supervisor, establishes ownership/identity, observes workload startup and publishes running. Stable request IDs make retries refer to the original launch. An ID reused with changed contents is rejected.

Use authenticated supervisor handshakes, a unique launch nonce, heartbeat and boot/process-creation identity where available. Retained OS process handles strengthen live ownership. PID existence alone is never sufficient to authorize a signal; PID reuse can otherwise kill unrelated work.

A missed heartbeat means investigate. Quiet logs, system sleep and permission-denied probes do not establish death. After a crash:

- Reconnect to an identifiable supervisor and preserve its state.
- Preserve verified terminal results and pending completion events.
- If command creation may have happened but execution is ambiguous, report recovery-required; do not launch a replacement automatically.
- If the supervisor is gone and workload ownership cannot be established, disclose that descendants may remain. Do not guess success or perform unsafe cleanup.
- After reboot, invalidate old live identity claims and reconcile as interrupted or unknown according to evidence; never rerun automatically.

An explicit stop goes through the supervisor, targets its verified ownership scope, permits bounded grace/escalation, and leaves it alive to drain logs and record results. Completion racing with stop may legitimately remain normal completion. Cancellation or timeout of `wait` releases only the observer and returns current state.

## 7. State consistency, storage and packaging

Enforce a single coordinator writer using an OS-held lock, and a single lifecycle writer per job. Stable lock objects must not be deleted/replaced while held. A stale timestamp is not permission to steal ownership. A hung writer is unavailable until it exits or is explicitly recovered.

Separate immutable launch specifications, supervisor lifecycle records, coordinator control intents and delivery acknowledgements. Recovery may take lifecycle ownership only after acquiring its lock and reconciling live evidence. UI actions never overwrite runner state.

Use same-filesystem atomic publication with declared flush/durability behavior. Atomic replacement prevents partial reads, not concurrent lost updates or all power-loss scenarios. Handle Windows sharing violations with bounded retries; retain the last good record. Do not acknowledge unpersisted operations.

Resolve custom storage roots to absolute paths and require local, private storage with validated locking/publication semantics. Network/shared storage is outside the baseline. IDs are not file paths; derive all paths inside the validated root and reject unsafe links/junctions. Use full collision-resistant IDs; every prefix-based action rejects ambiguity. Quarantine corrupt records visibly instead of reporting an empty successful list.

Ship immutable, versioned supervisor assets rather than rewriting executable scripts on every start. npm installs use a supported Node runtime; standalone installs bundle a supervisor runtime or validated internal mode. Do not assume the CLI executable can interpret `.mjs`, or download a runtime at job launch. Windows helpers ship for each supported architecture.

Pin active jobs to their assets/protocol version and retain those assets through upgrades. Incompatible clients refuse unsafe controls/migrations rather than replacing running code.

## 8. Environment, directories and invocation

Prefer direct executable/argument invocation. Explicit shell mode preserves the original text, whitespace and interpreter; do not translate POSIX syntax into Windows syntax. The platform adapter handles quoting, executable resolution, batch shims and arguments with spaces/non-ASCII characters.

Construct a documented minimal environment, including OS essentials for executable discovery, home/temp locations and Windows system paths. Normalize Windows key casing. Filter runtime-injection variables by default and allow additional named inheritance only through explicit policy.

Credentials use consented references resolved at launch; values are never persisted in grants, records or diagnostics. Report missing/filtered variable names, not values. Environment filtering cannot stop unrestricted commands from reading credential files.

Canonicalize directories through symlinks/junctions, verify they exist and require explicit outside-project consent. Filesystem roots are rejected by default unless specifically approved. A working-directory restriction is an accidental-misuse guard, not filesystem containment.

## 9. Logs, resource limits and cleanup

The supervisor consumes workload pipes and owns all retained log files. Rotate into numbered segments by closing the current segment and opening the next—not by renaming a file the workload still writes. Readers must release handles; Windows deletion failures receive bounded retries.

Proposed initial defaults, subject to measurement during opt-in rollout:

| Policy | Proposed default |
| --- | --- |
| Log segment size | 5 MiB |
| Retained logs per job, both streams combined | 20 MiB |
| Aggregate per-user log budget | 200 MiB |
| Concurrent jobs | 4 |
| Completed-log retention | 7 days |
| Schedule overlap | One active job per schedule; skip overlaps |

Reserve capacity before launch, including independent bounded metadata/temporary-file accounting. Unknown jobs count against capacity until safely reconciled. CPU/memory limits are optional backend capabilities, not universal promises.

Enforce byte limits even for enormous lines, binary data and malformed UTF-8. Keep draining pipes without unbounded buffering. If persistence or segment deletion fails, apply the approved logging-failure policy: by default request stop, drain/discard during termination and expose dropped-output diagnostics. Never grow beyond quota or block the workload indefinitely because logging stalled.

Read byte-bounded tails/cursors across segments; a line count is only a display preference. List/poll metadata never read entire logs. Completion summaries contain small, labelled excerpts from both stdout and stderr, prioritize according to outcome, preserve real exit codes and indicate truncation. Escape terminal controls and treat output as untrusted data.

Cleanup is explicit and sensitive. Automatic log expiry does not delete active/unknown ownership evidence or unacknowledged completion summaries. Once a bounded metadata budget is full, reject new launches and request acknowledged cleanup/export instead of silently losing pending events.

## 10. Completion delivery

Publish the observed terminal result and stable completion-event ID together. The coordinator treats events as a durable mailbox: assign one connected client, present with event-ID deduplication, then persist its acknowledgement separately.

Isolate subscriber failures and use bounded retry/backoff with visible delivery diagnostics. Disconnect releases an unacknowledged presentation claim; a timeout is not an acknowledgement. All clients can inspect results even when a shared per-user acknowledgement suppresses repeat announcements.

Guarantee recoverability of retained pending events, not exactly-once human-visible delivery. A crash after presentation but before acknowledgement can duplicate a message. Mark-before-notify can lose one. Job success is independent of notification success.

## 11. Command schedules

The coordinator alone evaluates process schedules across connected sessions. Keep the baseline of interactive-only evaluation; jobs already launched continue after all clients exit. Preserve prompt-schedule semantics and backward-compatible records.

Creation validates cron fields/ranges, canonical launch settings and explicit recurring consent. Persist schedule version, timezone, bound grant and occurrence identity. Changing the approved command, interpreter, cadence, access scope or other material terms invalidates consent.

At trigger time, recheck grant validity, credentials, directories, capability and restrictive policy. Any connected deny-writes session suppresses process-schedule launches while attached; combine other restrictions conservatively and display why a trigger was suppressed. Do not silently downgrade isolation or wait for an unattended approval dialog.

Reserve the occurrence durably before dispatch and associate it with a stable launch request. Reconcile crashes against that request. Ambiguous dispatch is recovery-required, not an automatic retry. This prevents routine duplicate scheduling but does not guarantee exactly-once effects.

Specify these scheduling semantics:

- One active/unknown job per schedule; skip overlaps and capacity-blocked occurrences with a reason.
- No unbounded queue, disconnected-time backfill or repeated retries within a blocked/failed slot.
- After reconnect, resume with future eligible slots, not catch-up execution.
- Nonexistent DST local times are skipped; repeated local times run at most once per local occurrence.
- Persisted occurrence identities prevent replay after clock rollback or simultaneous clients.

## 12. Changes to the earlier fix list

| Decision | Rationale |
| --- | --- |
| Keep detached supervisors and durable records | Correct foundation for non-blocking work and reconnection. |
| Keep action-aware consent; unify all launch paths | Schedules and slash commands must not bypass the tool policy gate. |
| Replace raw PID/log-inactivity reconciliation | Prevent PID-reuse mistakes and false failure for quiet jobs. |
| Replace stamp-first notification fix | Durable events with acknowledgement balance replay and deduplication without false exactly-once claims. |
| Replace direct child-file log rotation | Supervisor-owned segmented output works around Unix descriptors and Windows sharing behavior. |
| Replace stdout-only summaries | Both labelled streams preserve results and warnings. |
| Replace env-name regex as primary policy | Minimal environment and explicit inheritance are more predictable across OSes. |
| Remove termination on normal Agav exit | It contradicts the feature's durable lifetime. |
| Remove approval Boolean/blanket force bypass | Neither is a trustworthy authorization boundary. |
| Replace sandbox auto-fallback | Capability detection plus refusal or distinct unrestricted consent avoids misleading protection. |
| Add coordinator, ownership adapters and versioned packaging | Needed for multi-client safety, Windows tree control and reliable upgrades. |
| Defer broad refactors and always-on services | Deliver the portable lifecycle first; avoid unrelated formatting/test changes in feature PRs. |

## 13. Phased delivery plan

### Phase A — contracts, authorization and packaging foundation

Define public actions, lifecycle/uncertainty states, capability reporting, request identities, consent binding and storage ownership. Establish supported OS versions/architectures and filesystems using the project's release matrix. Package the supervisor/runtime and native platform adapters. No advertised platform is supported until its artifacts and required ownership mechanisms are available.

**Exit gate:** all three OSes can establish private coordinator/supervisor identity and state ownership; missing capability errors are explicit; no unrestricted silent fallback exists.

### Phase B — manual jobs behind an opt-in flag

Deliver start/list/poll/log/wait/stop through the common boundary, with bounded logs, durable events and reconnect/recovery. Add user-facing job inspection and capability/status reporting without requiring an LLM turn. Document when to choose background execution versus short commands.

**Exit gate:** ordinary exit/restart works on every supported OS; cancellation is responsive; stop outcomes are truthful; failures do not leak unlimited logs or duplicate execution.

### Phase C — process schedules

Add recurring grants, occurrence reservations, overlap/timezone semantics, shared restrictive-policy enforcement and schedule diagnostics. Preserve existing prompt schedules and unrelated command formatting.

**Exit gate:** simultaneous clients cannot independently dispatch an occurrence; revoked or incompatible grants cannot launch; uncertain dispatch is visible and never automatically repeated.

### Phase D — hardening and staged release

Exercise fault cases, upgrades and packaged installs on Linux, Windows and macOS. Measure defaults and adjust budgets before enabling the feature more broadly. Keep rollback able to disable new starts/schedules without killing active supervisors or deleting pending results. No global default-on release until platform gates pass.

Always-on OS-service scheduling, reboot restart, extra isolation backends and stronger POSIX containment remain separately reviewed extensions with explicit consent and their own acceptance gates.

## 14. Acceptance criteria and verification plan

These are future implementation checks, not tests claimed to have run for this document. Run the shared checks on Linux, Windows and macOS in both npm and standalone packaging modes supported by the release matrix.

| Area | Required observable result |
| --- | --- |
| Launch and observation | A delayed-output job returns a starting/running reference before completing; UI stays usable; list/poll/log identify the same job and real result. |
| CLI exit/reconnect | Exit during execution, restart Agav and observe the original job and retained output; no duplicate launch or automatic stop. |
| Wait cancellation | Cancel a wait and promptly regain control; the job continues and remains inspectable. |
| Stop | Long-running workload and ordinary descendants stop within the configured grace/escalation policy; status changes only on observed evidence. Natural completion races retain truthful outcomes. |
| Crash/PID reuse | Kill supervisors/coordinators, lose responses and simulate identity reuse; no unrelated process is signalled, no automatic replacement command runs, uncertainty is visible. |
| Concurrent clients | Concurrent starts respect capacity; identical request retries refer to one intent; schedule slots are reserved once; no competing lifecycle writers. |
| Notifications | Throwing consumers, disconnects and crash-before-ack leave retrievable events without an uncontrolled storm; acknowledged events are not routinely repeated; ambiguous crash duplicates are documented. |
| Log bounds | Flood both streams, emit a huge single line/binary data and request tails; disk and returned bytes stay bounded and truncation is visible. Metadata poll does not read log bodies. |
| Storage failure | Disk full, read-only directories, sharing denial and corrupt records produce actionable errors; retain last good state, do not acknowledge failed writes or report false success. |
| Authorization | Tool, slash-command, headless and scheduled entry points enforce the same grants; deny-writes, revocation, changed specs and unavailable isolation prevent launches. |
| Input/environment | Spaces/non-ASCII paths, links/junctions, ambiguous IDs, invalid cron/signals, batch shims and env casing behave as documented; credentials never appear in persisted metadata/diagnostics. |
| Schedule timing | Overlap, capacity block, downtime, DST repetition/gaps and clock rollback follow the stated skip/reservation rules; prompt schedules retain prior behavior. |
| Upgrade/cleanup | Active jobs retain compatible assets and controls; cleanup protects active/unknown evidence and pending events; rollback disables new work without terminating existing jobs. |

Additional OS-specific release gates:

- **Linux:** verify group stop and disclosed escape behavior; exercise usable and restricted/unavailable Bubblewrap namespaces; verify delegated cgroup ownership only when advertised.
- **macOS:** verify independent supervisor/workload groups, path canonicalization and escape disclosures; validate actual isolation tooling availability rather than assuming it exists.
- **Windows:** verify suspended launch/Job assignment, nested/inherited Job incompatibility, helper crash, tree accounting, cmd/PowerShell differences, ACLs, runtime architecture and open-handle deletion failures. No POSIX-only fallback qualifies as passing.

Compare deterministic status/event/log outputs against explicit expected fixtures established during implementation. Platform differences must be declared in those fixtures, not hidden by weakening checks. Use real process-boundary integration checks in addition to unit checks; document all observed build/runtime warnings before release.

## 15. Deliverable status

This file is the final ideas/approaches/design plan. It contains no implementation code and makes no claim that the background feature has been compiled, run or certified on any OS. Document-level verification checks rendering, structure and links; executable/platform verification belongs to the delivery phases above.
