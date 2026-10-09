# Background jobs: coding-subagent delegation plan

Based on [solution.md](solution.md). This is a work breakdown, not an implementation or a claim of passing platform tests. Task IDs are stable so agents can reference dependencies in their reports.

## 1. How to delegate safely

- Give every agent `solution.md`, its task brief below, the frozen contracts from T01, and the exact files it may edit.
- Use a separate branch/worktree per agent. Merge dependency tasks before integration work; do not run several agents editing one checkout's shared files.
- Paths below are **proposed ownership boundaries**, not assertions about existing files. Inspect the repository and confirm exact paths during T01.
- Each coding task owns its component checks inside `__tests__/` or `test/`. Do not modify production code merely to accommodate a test. T17 owns shared integration checks, not other agents' unit files.
- One integration owner approves contract changes and merges work. Agents must request a versioned contract change rather than inventing a competing interface.
- “Can start early” means build against frozen interfaces/fakes. It does **not** mean the task can be accepted as integrated before its hard dependencies pass.
- Existing source areas, package manifests, release workflows and central exports each have one assigned owner. Request another owner's change instead of editing their files.
- Each handoff reports changed files, public behavior, checks actually run and full results, platform limitations, unresolved issues, and required follow-up. Mocks do not establish OS compatibility.

## 2. Task graph and parallel work

**T01 is the initial synchronization barrier.** Do not start production implementations until ownership, contracts, supported architectures and native-helper/runtime choices are agreed.

| Task | Assignment | Hard prerequisites for completion | Parallel opportunities |
| --- | --- | --- | --- |
| T01 | Contracts, ownership and release matrix | None | First task; one owner |
| T02 | Linux platform adapter | T01 | T03, T04, T07, T09, T17 scaffolding, T18 drafts |
| T03 | macOS platform adapter | T01 | T02, T04, T07, T09, T17 scaffolding, T18 drafts |
| T04 | Windows platform adapter/native helper | T01 | T02, T03, T07, T09, T17 scaffolding, T18 drafts |
| T05 | Durable storage and record repositories | T01, T02, T03, T04 | T06, T08, T09, T10; may start with adapter fakes |
| T06 | Local IPC and client/session transport | T01, T02, T03, T04 | T05, T07, T08, T09, T10; may start with adapter fakes |
| T07 | Launch-spec/environment normalization | T01, T02, T03, T04 | T05, T06, T09; begin pure validation after T01 |
| T08 | Authorization and recurring grants | T01, T05, T07 | T06, T09, T10; begin evaluator with repository fakes |
| T09 | Runtime/assets and release packaging | T01, T02, T03, T04 | T05–T08, T10; layout/pipelines start after T01 |
| T10 | Bounded segmented logging | T01, T05 | T06–T09; begin stream logic after T01 |
| T11 | Per-job supervisor | T05, T06, T07, T09, T10 | T12/T13/T14 scaffolding and T15 scheduling logic |
| T12 | Recovery and identity reconciliation | T05, T06, T11 | T13; begin decision engine with identity fixtures earlier |
| T13 | Completion mailbox and acknowledgements | T05, T06, T11 | T12; begin event/claim logic earlier |
| T14 | Coordinator admission/control integration | T08, T11, T12, T13 | T15 logic, T16 presentation; skeleton starts after T01 |
| T15 | Process schedule engine | T05, T08, T14 | T16; pure cron/occurrence logic starts after T01 |
| T16 | Agent/tool/slash-command/UI integration | T14, T15 | T17, T18; manual-only integration can land after T14 |
| T17 | Cross-platform integration verification | T09, T12, T13, T14, T15, T16 | T18; harness/matrix scaffolding starts after T01 |
| T18 | User docs and staged-release controls | T09, T16, T17 | Docs drafts start after T01; final claims wait for T17 |

**Practical waves:**

1. **Wave 0:** T01 alone.
2. **Wave 1:** T02 + T03 + T04; simultaneously scaffold T07, T09, T17 and documentation for T18.
3. **Wave 2:** T05 + T06 + T07 + T09. Pure T08/T10 logic can start against agreed interfaces.
4. **Wave 3:** finish T08 + T10; then T11. In parallel scaffold T12/T13, T14 orchestration and T15/T16 consumers.
5. **Wave 4:** T12 + T13; then integrate T14. Finish manual-job UI slice of T16.
6. **Wave 5:** finish T15 and schedule-facing slice of T16. Run T17 against delivered slices throughout, then finish the full matrix.
7. **Wave 6:** T18 finalization and release sign-off only after T17 passes.

Do not wait until Wave 5 to discover that the Windows helper or standalone packaging cannot run. Test platform primitives and packaged launch assets as soon as they exist.

## 3. Copy-ready task briefs

### T01 — Freeze contracts and decide native packaging

**Agent profile:** senior architecture/integration owner.

**Own:** shared contracts, protocol/schema versions, feature configuration contract, module boundaries and supported platform/architecture matrix.

**Deliver:** lifecycle and stop-control states; launch spec; request/event IDs; capabilities; storage ownership; platform primitives; supervisor/coordinator/client protocols; grant and budget interfaces; error/uncertainty semantics. Choose the native implementation language/build tooling and supported runtime strategy, so OS agents and packaging do not independently select incompatible stacks.

**Acceptance:** other tasks can implement interfaces without mutual imports; every authoritative record has one writer; dependency directions are documented; same-user threat limitations and unsupported capabilities are explicit. Avoid implementing the feature in this task.

### T02 — Linux adapter

**Own:** Linux-only adapter/native primitive files.

**Deliver:** detached supervisor startup, private storage/socket access, OS-held locks, process/boot identity, canonical paths, separate workload process-group ownership and safe stop primitives. Detect usable sandbox capabilities. Delegated cgroups are optional: either implement and verify them separately or explicitly report unavailable.

**Acceptance:** ordinary CLI exit does not end the job; unsupported required ownership/isolation fails closed; quiet logs are not death evidence; process-group escape limits are disclosed. Never signal an unverified historical PID.

### T03 — macOS adapter

**Own:** macOS-only adapter/native primitive files. Coordinate shared POSIX primitives through T01's owner rather than editing T02's files.

**Deliver:** separate supervisor/workload groups, identity evidence, locks, private sockets/permissions, canonical path behavior and termination. Detect actual supported isolation tooling/policy rather than assuming Seatbelt is usable.

**Acceptance:** surviving ordinary CLI exit and group-stop behavior are verified on macOS; unsupported stronger ownership is refused; escaping descendants and unavailable/deprecated isolation tooling have truthful capability results.

### T04 — Windows adapter and Job Object helper

**Own:** Windows-only adapter and native helper source. T09 owns build/release orchestration.

**Deliver:** detached lifetime, private named-pipe/ACL primitives, OS-held locks, process creation identity, canonical drive/UNC/junction handling, and workload ownership using a long-lived helper. Launch suspended, assign to Job Object, then resume; keep the sole non-inheritable Job handle, disallow breakaway and account for tree completion.

**Acceptance:** failed assignment never executes workload; helper failure invokes intended Job cleanup; inherited/nested Job incompatibility refuses launch. Graceful application shutdown is distinguished from force. No POSIX-signal or PID-walk fallback masquerades as tree ownership.

### T05 — Durable storage and repositories

**Own:** storage/repository modules; no coordinator or supervisor business logic.

**Deliver:** versioned immutable specs, lifecycle records, control intents, schedule reservations and acknowledgements; single-writer locking; atomic publication/flush policy; bounded sharing retries; ID/prefix validation; corruption quarantine; private local-root validation.

**Acceptance:** concurrent ownership is excluded without lease stealing; readers see old or new valid publications; failed writes are not acknowledged; ambiguous prefixes are errors; metadata failure is not silently an empty list. Repository APIs keep UI acknowledgements separate from lifecycle state.

### T06 — Authenticated IPC and connection lifecycle

**Own:** IPC server/client transport modules and session primitives.

**Deliver:** Unix sockets/Windows named pipes via adapters, restricted access, version negotiation, supervisor handshakes/nonces, bounded message framing, cancellation/disconnect behavior and session identity. Provide transport rather than launch policy.

**Acceptance:** unauthorized/wrong-version peers and oversized/malformed messages are rejected; reconnect is bounded and diagnosable; supervisor connectivity is independent of CLI pipes. Transport authentication is not treated as user consent.

### T07 — Launch-spec resolution, environment and invocation

**Own:** normalization/environment modules.

**Deliver:** canonical approved directory/executable resolution; direct arguments versus explicit interpreter modes; platform shell distinctions and batch-shim routing; minimal environment plus explicit named inheritance; case normalization on Windows; credential references without persisted values.

**Acceptance:** spaces/non-ASCII paths and command whitespace survive; symlink/junction/outside-project decisions are explicit; runtime injection variables are controlled; no automatic shell translation. Missing credentials are diagnosable without leaking values.

### T08 — Shared authorization and recurring consent

**Own:** new authorization/grant service; existing agent-loop wiring belongs to T16.

**Deliver:** action-specific policy evaluation, full-spec approval binding, grant persistence/revocation, recurring consent, headless rules, dispatch-time revalidation, restrictive-session policy aggregation and capability-aware isolation resolution.

**Acceptance:** changed specs require new consent; start/stop/cleanup permissions cannot be widened by irrelevant fields; deny-writes suppresses launches including schedules; absent isolation never silently falls back. Stop has a separately authorized emergency path, not a blanket read-only exemption.

### T09 — Runtime and immutable asset packaging

**Own:** package manifests, native build/release workflow changes, asset manifests and runtime locator. One agent owns these shared build files.

**Deliver:** npm and standalone supervisor entry assets, Windows helper artifacts for supported architectures, version pinning/cache retention, validated runtime overrides and capability checks for missing assets.

**Acceptance:** installed artifacts—not only source checkout—can launch the supervisor on all supported platforms; no runtime download at launch, executable rewrite on each start or assumption that the CLI binary interprets JavaScript. Active versions survive upgrades. Final upgrade exercise is shared with T17.

### T10 — Segmented logs and bounded reads

**Own:** log writer/reader/retention modules. Do not independently signal processes.

**Deliver:** supervisor-consumed stdout/stderr, fixed-size segments, bounded bytes and buffers, tail/cursor access, labelled excerpts, terminal sanitization, truncation/retention diagnostics and logging-failure events. Accept budget allocations from the coordinator contract.

**Acceptance:** huge lines/binary data cannot bypass bounds; rotation closes owned handles; Windows deletion retry is bounded; failures cannot create unlimited segments or permanently block pipes. Metadata reads do not read logs. Supervisor applies stop policy when logging reports failure.

### T11 — Per-job supervisor lifecycle

**Own:** supervisor orchestration/entry modules.

**Deliver:** independent startup and handshake, single lifecycle ownership, workload launch through adapters, heartbeat, idempotent stop requests, cancellation-independent execution, output draining and observed terminal result plus stable completion event in one publication.

**Acceptance:** ordinary CLI/coordinator exit leaves work running; stop request is distinct from termination; real exit codes are preserved; supervisor remains outside POSIX workload group. Launch/stop races produce truthful outcomes and do not publish success on missing evidence.

### T12 — Recovery and reconciliation

**Own:** recovery decision/service modules.

**Deliver:** reconnect, boot/creation-identity checks, safe lock takeover only after owner disappearance, uncertain launch reconciliation, missing-supervisor diagnostics and protected unknown-job state.

**Acceptance:** reused PIDs are never signalled, ambiguous execution is never rerun, missing heartbeat/quiet logs do not falsely mean death, and unknown descendants are disclosed. Return decisions to the coordinator rather than importing its orchestration.

### T13 — Durable completion delivery

**Own:** event mailbox/claim/ack service modules; UI rendering belongs to T16.

**Deliver:** discovery of terminal events, one-live-client presentation claims, stable-ID deduplication, independently persisted acknowledgements, disconnect reassignment, isolated subscriber failures and bounded backoff/diagnostics.

**Acceptance:** notification failures cannot change job outcome or trigger uncontrolled storms; crash-before-ack leaves a recoverable event. Document the possible duplicate presentation window instead of claiming exactly-once delivery.

### T14 — Coordinator and admission/control integration

**Agent profile:** experienced backend integrator; do not split this task between competing owners.

**Own:** coordinator orchestration, client service API and capacity reservations.

**Deliver:** singleton boot/reconnect, session policies, shared authorized launch/stop/cleanup paths, durable request IDs, per-user job/log/metadata capacity, cancellation-aware observations, safe shutdown and integration of recovery/mailbox services.

**Acceptance:** all starts pass T08; identical retries return the original intent; conflicting retries fail; capacity reservations reconcile before new admission; unknown jobs remain protected. Disconnecting all clients can end coordinator activity but never invokes blanket job termination.

### T15 — Recurring process-schedule engine

**Own:** process-schedule service/storage usage and occurrence logic; existing slash commands/app scheduling wiring belongs to T16.

**Deliver:** cron validation, timezone/DST rules, recurring grant binding, durable occurrence reservation tied to a launch request, active-session evaluation, overlap/capacity skip behavior and visible suppression diagnostics.

**Acceptance:** simultaneous clients do not dispatch independently; ambiguous dispatch never retries automatically; no downtime backfill/unbounded queue; clock rollback and repeated local time cannot replay a recorded occurrence. Preserve command text and old prompt-task schemas. Trigger launch uses T14/T08, not direct supervisor/tool execution.

### T16 — Product integration: tools, commands and UI

**Own:** all edits to existing agent permission wiring, tool registries, commands, app/hooks, confirmation UI, bundled tool lists and prompt guidance. Coordinate narrowly required shared configuration exports with T01.

**Deliver:** opt-in process tool, manual `/process` inspection/control, consent/capability warnings, cancellable wait, bounded sanitized output, notification presentation/ack and schedule command/UI wiring. Keep adapters thin.

**Acceptance:** no entry point launches directly; disabling new starts does not hide existing jobs or kill them; headless/deny-writes behavior matches policy; short commands and prompt schedules retain existing behavior. Manual subset can merge after T14, with schedule subset after T15.

### T17 — Cross-OS integration and fault verification

**Own:** shared integration harness, fixtures and cross-platform verification reports inside allowed test directories. T09 applies needed CI workflow changes from this task's requirements.

**Deliver:** real-process checks for Linux/macOS/Windows and npm/standalone installs; restart/stop/crash/PID-reuse/concurrency/log-flood/sharing-denial/disk-failure/event-ack/schedule-time/upgrade scenarios from solution.md. Establish explicit deterministic expected fixtures with documented platform differences.

**Acceptance:** each advertised OS/artifact is actually exercised; expected outputs and observed results are recorded; warnings/failures are diagnosed, not suppressed. Missing native runners are a blocked platform gate, not a passing mock. Genuine source defects go back to their module owner.

### T18 — Documentation, opt-in rollout and release sign-off

**Own:** feature/user/troubleshooting docs and release checklist. T16 owns product feature wiring; T09 owns release workflow/config edits.

**Deliver:** support/capability matrix, consent and lifetime explanation, operating limits, job/schedule workflows, recovery instructions, measured default-budget recommendations and staged enablement/rollback plan.

**Acceptance:** claims match T17 evidence; sandbox/ownership/exactly-once limits are clear; rollback prevents new launches while retaining active supervisors/assets and pending events. No global default-on launch before all declared platform gates pass.

## 4. Shared-file ownership and dependency rules

| Shared area | Owner |
| --- | --- |
| Protocol, schemas, capability types, configuration contract | T01 |
| OS-specific primitives/helper source | T02/T03/T04, partitioned by OS |
| Native tooling choice | T01 decides; T04 implements Windows helper; T09 packages |
| Package manifests, release/CI workflows, central asset manifest | T09 |
| Existing agent/tool/command/app wiring | T16 |
| Component tests | Component task, in separately named files |
| Cross-component fixtures and integration harness | T17 |
| User/release documentation | T18 |

No reverse dependencies: storage consumes platform primitives; authorization consumes policy/session snapshots rather than the coordinator instance; logging reports failure rather than importing supervisor/coordinator; supervisors do not depend on coordinator lifetime; recovery and delivery do not import UI. These boundaries keep the graph acyclic.

## 5. Suggested assignments and critical path

With **six agents**, use three platform agents initially, one foundation/storage agent, one authorization/integration agent, and one packaging/verification agent. Once adapters land, reassign platform agents to IPC, logging and supervisor work. Reuse the coordinator owner for T14 to maintain a coherent admission/control model. Assign Windows-specific verification to an agent with access to a real Windows runner.

Likely critical path: **T01 → slowest platform adapter → T05/T06/T07/T09 → T10 → T11 → T12/T13 → T14 → T15 → T16 → T17 → T18**. T08 must be ready before T14. This is a dependency path, not an effort estimate; Windows helper/package feasibility can dominate it.

If you want the quickest useful milestone, prioritize **manual jobs** through T14 plus the manual slice of T16, then run the corresponding T17 gates. Schedules may be developed in parallel but must not be enabled before their authorization/recovery prerequisites work.

Do not delegate “fix everything in process.ts,” “add Windows support later,” or “write tests until they pass.” Those scopes either create shared-file conflicts or defer a fundamental architecture dependency.
