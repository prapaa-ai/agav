# Background jobs subsystem — ownership map (T01)

This directory implements the design in `/solution.md` and the work breakdown
in `/subtasks.md`. **Do not implement the whole feature in one file** — each
subdirectory below has exactly one owning task; see "Shared-file ownership"
in subtasks.md §4.

```
source/background-jobs/
  types.ts              T01  — frozen contracts (this barrier). Others import, never edit.
  platform/
    linux.ts             T02 — Linux PlatformAdapter implementation
    macos.ts              T03 — macOS PlatformAdapter implementation
    windows.ts            T04 — Windows PlatformAdapter + native helper IPC glue
    index.ts              T01 — platform selector (`getPlatformAdapter()`), no business logic
  storage/
    paths.ts                     — root resolution, canonicalization, collision-resistant IDs
    lock.ts                      — OS-held lock wrapper (uses PlatformAdapter.acquireLock)
    repositories.ts              — Repositories implementation (T05)
  ipc/
    server.ts, client.ts, framing.ts   (T06) — Unix socket / named pipe transport
  launch-spec/
    normalize.ts, environment.ts, shell.ts   (T07)
  authorization/
    service.ts, grants.ts                    (T08)
  packaging/
    manifest.ts, locator.ts                  (T09) — coordinated with top-level package.json/scripts
  logging/
    segmented-log.ts, reader.ts              (T10)
  supervisor/
    entry.ts, lifecycle.ts                   (T11)
  recovery/
    reconcile.ts                             (T12)
  mailbox/
    events.ts                                (T13)
  coordinator/
    service.ts, admission.ts                 (T14)
  schedule/
    engine.ts, cron.ts                       (T15)
  (T16 integration lives OUTSIDE this directory: source/tools/, source/commands/, source/agent/)
```

## Rules

1. Only `types.ts` and `platform/index.ts` are owned by the integration lead (T01).
   Any other change to those two files must be requested, not made directly.
2. No module above may import a module listed *below* it in the dependency
   order documented at the top of `types.ts`. In particular:
   - `platform/*` never imports `storage/*`, `ipc/*`, `supervisor/*`, etc.
   - `logging/*` never imports `supervisor/*` or `coordinator/*`.
   - `recovery/*` and `mailbox/*` never import UI code.
   - `coordinator/*` is the only module allowed to import authorization,
     supervisor-launch, recovery and mailbox together.
3. Every authoritative record kind in `types.ts` (`JobRecord`, `ControlIntent`,
   `CompletionEventRecord`, `AcknowledgementRecord`, `ScheduleRecord`,
   `ScheduleOccurrenceRecord`) has exactly one writer module — see
   `storage/repositories.ts` (T05) for the single implementation.
4. This is a Linux-first development environment. `platform/macos.ts` and
   `platform/windows.ts` are implemented to the `PlatformAdapter` contract on
   a best-effort basis using documented OS APIs/CLI tools, but cannot be
   executed or verified on real macOS/Windows hosts here. Every limitation
   must be reported in `detectCapabilities().limitations` rather than
   assumed away, per solution.md §5 and §14.
5. Supported platform/architecture matrix (frozen for Phase A):
   - linux: x64, arm64 (glibc); Bubblewrap optional, detected at runtime.
   - darwin: x64, arm64; Seatbelt (`sandbox-exec`) optional, detected at runtime.
   - win32: x64; native helper required for Job Object ownership — see
     `platform/windows.ts` for the documented helper-unavailable fallback
     (refusal, not raw PID fallback).
6. Native packaging/runtime strategy (decided here so T04/T09 do not diverge):
   supervisor entry ships as plain `.js` compiled by the existing `tsc` build
   (`build/background-jobs/supervisor/entry.js`), invoked via the current
   Node runtime (`process.execPath`) — matching this repo's existing
   `agents/sandbox-exec.mjs` precedent of shipping a plain script invoked by
   the active Node binary. No bundling a separate runtime in Phase A/B. The
   Windows native helper (T04) is out of scope for a C/C++ binary in this
   environment; it is implemented as a Node-based helper using
   `node:child_process` Job Object bindings where available, with explicit
   capability-reporting fallback to refusal (`nativeHelperAvailable: false`)
   when the binding is missing, per solution.md §5/§7 "fail closed, do not
   raw-PID-walk".

## Status

This is a from-scratch implementation effort, matching the plan's framing:
"Proposed design and delivery plan; not an implemented feature." Phase
boundaries from solution.md §13 apply: Phase A (contracts/packaging) is this
file + `types.ts`; Phase B is manual jobs (T02-T14 + manual slice of T16);
Phase C is schedules (T15 + schedule slice of T16); Phase D (hardening,
staged release) is out of scope for this delivery pass and left documented
as follow-up in each task's handoff report.
