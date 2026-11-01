# Background jobs

Opt-in subsystem (`backgroundJobsEnabled`) for long-running shell commands and cron-style schedules
that outlive a single agent turn. Product wiring lives outside this directory
(`source/tools/background-job.ts`, `source/commands/job.ts`, `source/cli/job-cli.ts`,
`source/background-jobs-integration.ts`) and talks only to the coordinator.

```
source/background-jobs/
  types.ts         shared contracts; others import it, never the reverse
  platform/        per-OS PlatformAdapter (linux, macos, windows) and selector
  storage/         root resolution, atomic files, single-writer lock, repositories
  ipc/             Unix socket / named pipe transport
  launch-spec/     LaunchSpec normalization, environment, shell interpreters
  authorization/   grants, policy, spec hashing
  packaging/       locator for the supervisor entry and internal flags
  logging/         segmented stdout/stderr logs and readers
  supervisor/      per-job supervisor process
  recovery/        reconcile of orphaned jobs, PID-reuse and reboot handling
  mailbox/         completion events
  coordinator/     only module that combines authorization, launch, recovery and mailbox
  schedule/        cron parsing and the schedule engine
  host/            foreground daemon and OS scheduler entries for `agav job tick`
```

## Rules

1. Dependencies point downward in the order documented at the top of `types.ts`:
   - `platform/*` never imports `storage/*`, `ipc/*`, `supervisor/*`, etc.
   - `logging/*` never imports `supervisor/*` or `coordinator/*`.
   - `recovery/*` and `mailbox/*` never import UI code.
   - `host/*` never imports the coordinator; the tick function is injected.
2. Each authoritative record kind in `types.ts` (`JobRecord`, `ControlIntent`,
   `CompletionEventRecord`, `AcknowledgementRecord`, `ScheduleRecord`,
   `ScheduleOccurrenceRecord`) has exactly one writer: `storage/repositories.ts`.
3. `platform/macos.ts` and `platform/windows.ts` are written to the `PlatformAdapter` contract from
   documented OS APIs but have not been verified on real macOS/Windows hosts. Limitations are
   reported in `detectCapabilities().limitations` rather than assumed away.

## Platforms

- linux: x64, arm64 (glibc); Bubblewrap optional, detected at runtime.
- darwin: x64, arm64; Seatbelt (`sandbox-exec`) optional, detected at runtime.
- win32: x64; Job Object ownership needs a native helper, which is not available yet
  (`nativeHelperAvailable: false`). The fallback reports ownership scope `unverified`; requests
  requiring isolation or stronger ownership are refused. Windows workflows may use this unsandboxed
  fallback with a warning, but process-tree ownership and descendant cleanup are not guaranteed.

## Packaging

The supervisor ships as plain `.js` from the normal `tsc` build
(`build/background-jobs/supervisor/entry.js`) and runs on the current Node binary
(`process.execPath`), like `agents/sandbox-exec.mjs`. No separate runtime is bundled.

## Not covered

Hardening and staged release are not done.

## Operator recovery

For uncertain jobs that block capacity, see the [recovery guide](../../docs/docs/reference/job-recovery.md). Explicit abandonment retains evidence and does not prove stopped or authorize retry.
