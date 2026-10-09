# Background Jobs — Manual Test Scenarios

| | |
|---|---|
| **Status** | Draft — ready for manual execution |
| **Scope** | `run_background_job` tool, `/process` command, recurring process-schedules |
| **Scenario count** | 60 numbered scenarios (§0–§10) + 3 detailed step-by-step walkthroughs |
| **Companion automated coverage** | 207 background-jobs vitest tests + 47 tool/command integration tests (unit/integration level only — does not replace this document) |
| **Not covered automatically** | Real app close/reopen timing, real OS process survival (macOS/Windows), real wall-clock schedule firing, real crash/kill recovery |

This document lists real-world scenarios to manually verify for the
background-jobs feature. This is for exercising the feature as a real user
would, especially across app restarts, timing windows, and platforms the
automated suite can't fully verify (macOS, Windows).

## Table of contents

- [Scenario categories](#scenario-categories) — which sections to run for a given change, and suggested priority order
- [§0 Opt-in gating](#0-opt-in-gating)
- [§1 Basic manual job lifecycle](#1-basic-manual-job-lifecycle)
- [§2 Stop / cancellation](#2-stop-cancellation)
- [§3 Recurring schedules — creation, listing, revocation](#3-recurring-schedules-creation-listing-revocation)
- [§4 The core "close and reopen" scenario](#4-the-core-close-and-reopen-scenario-you-asked-about)
- [§5 Idle supervisor self-exit](#5-idle-supervisor-self-exit-resource-leak-fix-verification)
- [§6 Concurrency and capacity](#6-concurrency-and-capacity)
- [§7 Authorization / permission modes](#7-authorization-permission-modes)
- [§8 Output and log handling](#8-output-and-log-handling)
- [§9 Platform-specific (macOS / Windows)](#9-platform-specific-run-these-manually-on-each-os-per-your-note)
- [§10 Crash / unexpected termination](#10-crash-unexpected-termination-harder-to-script-worth-at-least-spot-checking)
- [Detailed step-by-step walkthroughs (W1–W3)](#detailed-step-by-step-walkthroughs)
- [Notes for whoever runs these](#notes-for-whoever-runs-these)

**Prerequisites for every scenario below:**
- Set `"backgroundJobsEnabled": true` in your agav config (global
  `~/.agav/config.json` or project `.agav/config.json`), otherwise every
  action refuses with a clear "not enabled" message (verify that refusal
  too — see Scenario 0).
- Build/run the actual installed CLI, not just source — `pnpm build` then
  run the built `agav` binary, since the supervisor is resolved from
  `build/background-jobs/supervisor/entry.js`.
- Set `"permissionMode"` to `"auto-accept"` for most scenarios below unless
  a scenario specifically exercises `"ask"`/`"deny-writes"`.

Record for each scenario: pass/fail, OS, agav version/commit, and any
deviation from "expected result."

---

## Scenario categories

The numbered sections below are organized into these logical groups. Use
this table to decide how much of the suite you need for a given change —
e.g. a change to the schedule engine only needs categories B and D; a
change to the IPC/supervisor layer needs A, C and F.

| Category | Sections | What it covers | Why it matters |
|---|---|---|---|
| **A. Basic job lifecycle** | §0 (opt-in gating), §1 (manual job lifecycle), §8 (output/log handling) | Starting, polling, listing, and reading logs for a single job from launch to a terminal state (`completed`/`failed`), plus the opt-in flag gate. | The foundational path every other category builds on — if this is broken, nothing else can be trusted. |
| **B. Scheduling (creation & recurrence)** | §3 (schedule CRUD + firing) | Creating/listing/revoking cron-based schedules, confirming they actually fire on the correct cadence/timezone, and that firing doesn't double-dispatch or overlap. | This is the feature's most timing-sensitive, easiest-to-silently-break surface (cron math, dedup/reservation, overlap skip). |
| **C. App lifecycle interruptions** | §4 (close/reopen), §10.3 (machine sleep/suspend) | What happens to in-flight jobs and pending schedule occurrences when the interactive agav process exits, restarts, or the host machine sleeps — this is the category your "schedule 2m then close agav" example belongs to. | Background jobs/schedules exist specifically to survive the CLI's own lifetime; this category is the whole point of the feature and the easiest place for state to get corrupted or duplicated. |
| **D. Stop / cancellation control** | §2 (stop/cancel), §7.3/§7.5 (deny-writes interaction with stop and schedule-suppression) | Explicit termination of a running job, idempotency of repeated stop calls, cancelling a `wait` without killing the job, and races between natural completion and a stop request. | Lifecycle state and stop-control state are deliberately separate in the design; this category is where that separation is most likely to leak a wrong/stuck status. |
| **E. Concurrency & capacity** | §6 (concurrent job limits, idempotent retries) | Behavior at and beyond the configured concurrent-job ceiling, and correct handling of a duplicate/retried start request. | Protects against resource exhaustion and duplicate-launch bugs under real multi-job usage. |
| **F. Resource lifecycle (supervisor processes)** | §5 (idle self-exit, cleanup reaping) | Whether supervisor OS processes are reaped appropriately — neither disappearing too early (while still useful for `poll`/`log`) nor leaking forever. | Directly verifies the fix for the "immortal untracked supervisor" issue; regressions here are invisible until `ps aux` shows hundreds of leaked processes. |
| **G. Authorization & permission modes** | §7.1/§7.2/§7.4 (ask / deny-writes gating) | How `permissionMode` (`ask`, `auto-accept`, `deny-writes`) gates starting jobs and creating schedules. | Security/consent boundary — a regression here means jobs launch without the approval the user's settings require. |
| **H. Platform-specific behavior** | §9 (macOS, Windows) | OS-reported capabilities, stop/termination semantics, path/shell quirks specific to each platform. | The automated suite runs on Linux only; this is the only coverage for macOS/Windows-specific code paths. |
| **I. Crash & failure recovery** | §10.1/§10.2 (forced kill of the CLI or the supervisor) | Truthful state reporting (`unknown`/`recovery-required`/`interrupted`) after an abnormal termination, with no silent false-success and no automatic duplicate relaunch. | The hardest correctness property to get right in a durable-job system — most bugs that matter in production show up here first. |

Priority order for a time-boxed test pass: **A → C → B → F → D → E → G → H → I**
(lifecycle and app-restart behavior first, since those are the feature's
core promise; platform-specific and crash-recovery checks last, since they
are the most expensive to execute and the least likely to regress from a
typical code change).

---
---

## 0. Opt-in gating

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 0.1 | Feature disabled by default | Fresh config with no `backgroundJobsEnabled` key (or `false`). Run `/process list` and ask the agent to use `run_background_job`. | Both refuse with a clear message mentioning `backgroundJobsEnabled`; no job is created; no supervisor process spawns. |
| 0.2 | Feature enabled | Set `"backgroundJobsEnabled": true`, restart agav. Run `/process list`. | Returns "No background jobs found." (not an error). |
| 0.3 | Toggle while running | Start agav with the flag enabled, create a schedule (see §3), then use `/config` (or edit the config file and whatever reload mechanism exists) to flip it to `false` without restarting. | The schedule ticker should stop on the next tick (per the `useEffect` dependency on `config.backgroundJobsEnabled`); `/process` commands should start refusing again without a restart. |

---

## 1. Basic manual job lifecycle

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 1.1 | Quick successful job | `/process` is not used for starting — ask the agent (or use the tool directly) to run `run_background_job action=start command="echo hello && sleep 2 && echo done"`. | Tool returns immediately with a `jobId` and state `accepted`/`starting`/`running` (not blocked for 2s). |
| 1.2 | Poll to completion | Immediately after 1.1, run `/process poll <jobId>` repeatedly (or wait a few seconds). | State progresses `accepted` → `starting` → `running` → `completed`, `exitCode: 0`. |
| 1.3 | Log retrieval | After 1.2 completes, run `/process log <jobId>`. | Output contains `hello` and `done`, in order. |
| 1.4 | Failing command | Start `command="exit 7"`. Poll until terminal. | State `failed`, `exitCode: 7`. |
| 1.5 | List shows all jobs | Run `/process list` after creating 2-3 jobs above. | All jobs appear with correct state/exit code columns. |
| 1.6 | Prefix lookup | Use just the first 8 characters of a `jobId` for `/process poll`. | Resolves correctly as long as it's unambiguous. |
| 1.7 | Unknown job id | `/process poll doesnotexist123`. | Clear "not found" message, not a crash/stack trace. |
| 1.8 | Missing required args | `/process poll` with no id; `run_background_job action=start` with no command. | Clear usage/validation error, `isError: true`, no throw. |

---

## 2. Stop / cancellation

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 2.1 | Stop a long-running job | Start `command="sleep 60"`. Once state is `running`, run `/process stop <jobId>`. | Within a few seconds, state becomes `interrupted` (not `completed`/`failed`). The `sleep` process is actually gone from `ps aux`. |
| 2.2 | Stop an already-finished job | Start a quick job, let it complete, then call stop on it. | No crash; returns the current (already terminal) state gracefully, does not flip a completed job to interrupted. |
| 2.3 | Double stop | Call stop twice in quick succession on the same running job. | Idempotent — no error on the second call, job still ends up `interrupted` exactly once. |
| 2.4 | Wait + cancel | Ask the agent to `run_background_job action=wait jobId=<id>` on a `sleep 30` job, then interrupt/cancel the agent turn (Ctrl+C or equivalent) partway through. | The wait returns promptly noting it may not have reached terminal state; **the job itself keeps running** (verify via a fresh `/process poll` afterward — state should still be `running`, not interrupted). |
| 2.5 | Natural completion races stop | Start `command="sleep 1"`, immediately call stop. | Should end up either `completed` or `interrupted` — a truthful outcome either way, never stuck/`unknown`. |

---

## 3. Recurring schedules — creation, listing, revocation

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 3.1 | Create a schedule | `/process schedule create "* * * * *" UTC echo scheduled-tick-check` (every minute, for fast feedback during testing). | Returns a `scheduleId`; appears in `/process schedule list` as `[enabled]`. |
| 3.2 | Schedule actually fires | After creating 3.1's schedule, wait at least 90 seconds (covering 1+ tick of the 30s evaluation interval and 1+ minute boundary) while agav stays open. Run `/process list`. | A NEW background job should have appeared, launched by the schedule, with output containing `scheduled-tick-check` once polled/logged. |
| 3.3 | Schedule does not double-fire within one minute | After 3.2, check `/process list` again after another 30-60s. | Only ONE job should exist per minute boundary that has passed — not multiple jobs for the same minute (the overlap/reservation logic should prevent duplicate dispatch for the same occurrence). |
| 3.4 | One-active-job-per-schedule overlap skip | Create a schedule with a command that takes longer than 1 minute, e.g. `"* * * * *" UTC "sleep 90"`. Let it fire once, then wait for the next minute boundary while the first job is still running. | The second minute's occurrence should be SKIPPED (no second concurrent job from the same schedule) until the first finishes. |
| 3.5 | Invalid cron rejected | `/process schedule create "not a cron" UTC echo hi`. | Clear error, no schedule created. |
| 3.6 | Revoke a schedule | Revoke the schedule from 3.1 via `/process schedule revoke <scheduleId>`. Wait another full minute. | `/process schedule list` shows it `[disabled]`; NO new job appears after revocation, even though the cron would otherwise have matched. |
| 3.7 | Revoke does not stop already-running job | While a schedule-launched job is still running, revoke the schedule. | The currently-running job is unaffected (still running/completes normally) — only *future* launches are blocked. |
| 3.8 | Timezone correctness | Create a schedule for a specific wall-clock time in a non-UTC zone, e.g. `"MM HH * * *" America/New_York` set a couple minutes in the future from your actual wall-clock time, converted correctly. | The job fires at the correct UTC-equivalent instant, not at that literal hour/minute in your machine's local timezone (unless your machine's TZ happens to be the same). |

---

## Detailed step-by-step walkthroughs

The tables above are intentionally compact for scanning during a test pass.
The walkthroughs below spell out the same highest-priority scenarios as
explicit Setup / Action / Wait / Verify steps — this is the exact shape of
your own example ("schedule 2m some prompt then close agav then after 2
min open agav and check the status of job"). Use these when running the
scenario for the first time or training someone else to run it; use the
tables above for a fast repeat pass.

### Walkthrough W1 (= Scenario 4.1–4.2): schedule something 2 minutes out, close agav, reopen, check status

1. **Setup.** Note the current wall-clock time and your machine's IANA
   timezone (e.g. run `date` to confirm `TZ`, or just use `UTC` to avoid
   ambiguity). Pick a target 2 minutes from now, e.g. if it is `10:03:00`,
   the target is `10:05`.
2. **Action — create the schedule.** Run:
   ```
   /process schedule create "05 10 * * *" UTC echo scheduled-after-2min
   ```
   (substitute `05 10` with your own computed minute/hour in 24-hour UTC).
   Confirm the command returns a `scheduleId` and that
   `/process schedule list` shows it as `[enabled]`.
3. **Action — fully close agav.** Exit the CLI completely (not Ctrl+Z /
   backgrounding the shell — the actual process must terminate). Confirm
   with `ps aux | grep -i agav` (or Task Manager on Windows) that no agav
   process remains.
4. **Wait.** Wait until at least 1 minute past the target time (so ~3
   minutes total from step 1), while agav remains fully closed.
5. **Action — reopen agav.** Start agav again normally.
6. **Verify (part A — closed-window occurrence is skipped, not queued).**
   Run `/process list`. **Expected:** no job exists for the occurrence that
   would have fired while agav was closed — the schedule ticker only runs
   while an interactive session is attached, and missed occurrences are
   deliberately NOT backfilled. If you instead see a job that just launched
   immediately upon reopening (a "catch-up" job), that is a bug — report it.
7. **Verify (part B — schedule is intact and still enabled).** Run
   `/process schedule list`. **Expected:** the schedule still shows
   `[enabled]` with the same `scheduleId`, cron, and timezone as step 2 —
   closing/reopening agav must not have corrupted or silently disabled it.
8. **Wait again.** Stay in agav past the *next* minute boundary (e.g. if
   the schedule is daily, you may need to temporarily edit it to `* * * *
   *` for a faster re-check, then revoke/recreate the real one afterward).
9. **Verify (part C — resumes firing normally).** Run `/process list`
   again. **Expected:** a new job now appears for the next eligible
   occurrence, with output containing `scheduled-after-2min` once polled
   via `/process log <jobId>` — confirming the schedule wasn't permanently
   broken by the close/reopen cycle, only its one missed window.

### Walkthrough W2 (= Scenario 4.3–4.6): start a long manual job, close agav mid-run, reopen, check status and output

1. **Setup.** Decide on a command that runs long enough to survive a
   close/reopen cycle and proves completion, e.g.:
   ```
   sleep 180 && echo survived-restart > /tmp/agav-test-survive.txt
   ```
2. **Action — start the job.** Ask the agent to run it via
   `run_background_job action=start command="sleep 180 && echo survived-restart > /tmp/agav-test-survive.txt"`.
   Record the returned `jobId`.
3. **Verify — running before close.** Run `/process poll <jobId>`.
   **Expected:** `state: running`.
4. **Action — fully close agav.** Exit the CLI completely.
5. **Verify — supervisor survives the close.** Run
   `ps aux | grep entry.js` (macOS/Linux) or check Task Manager (Windows).
   **Expected:** a node process referencing
   `background-jobs/supervisor/entry.js <jobId> ...` is still present and
   running, even though agav itself has exited.
6. **Wait.** Wait less than 180 seconds if you want to catch it mid-run on
   reopen (to test the "running" case), or more than 180 seconds if you
   want to test the "already completed while closed" case — do both across
   two separate runs of this walkthrough.
7. **Action — reopen agav.** Start agav again.
8. **Verify — same job, correct state, no duplicate.**
   - Run `/process poll <jobId>` with the SAME id from step 2. **Expected:**
     found (not "not found"), and its `state` truthfully reflects whichever
     case you tested in step 6 (`running` or `completed`) — never reset to
     `accepted`/`starting`.
   - Run `/process list`. **Expected:** exactly ONE job for this launch —
     reopening agav must never auto-relaunch or duplicate it.
9. **Wait for completion** (if not already complete) by polling every 15-30
   seconds until `state: completed`, `exitCode: 0`.
10. **Verify — output recoverable.**
    - Run `/process log <jobId>`. **Expected:** full captured stdout is
      readable.
    - Run `cat /tmp/agav-test-survive.txt` directly in the shell.
      **Expected:** the file exists and confirms the command actually ran
      to completion independent of agav's own process lifetime.

### Walkthrough W3 (= Scenario 5.1–5.3): confirm the idle supervisor self-exit timing (no leaked processes)

1. **Setup.** Confirm the current idle-exit default by checking
   `SUPERVISOR_IDLE_EXIT_MS` in `source/background-jobs/supervisor/lifecycle.ts`
   (5 minutes as of this writing) — if it has changed, adjust the wait
   times below accordingly.
2. **Action.** Start a quick job: `command="echo quick-job-for-idle-test"`.
   Wait for it to reach `state: completed` via `/process poll`.
3. **Verify — supervisor alive immediately after completion.** Run
   `ps aux | grep entry.js` and confirm the supervisor for this `jobId` is
   present.
4. **Wait — do nothing idle-timer-relevant for 5+ minutes.** Do not call
   `/process poll`, `log`, or `wait` on this specific `jobId` during this
   window (other unrelated agav activity is fine).
5. **Verify — self-exit occurred.** After 5+ minutes, run
   `ps aux | grep entry.js` again. **Expected:** the supervisor for this
   `jobId` is now gone. (Budget ~6 minutes real wall-clock time for this
   step; do not rush it.)
6. **Repeat with activity (negative control).** Start a second quick job,
   let it complete, then run `/process poll <jobId>` once every ~2 minutes
   for 10+ minutes. **Expected:** the supervisor remains alive throughout,
   since each poll resets the idle clock — then stop polling and confirm it
   exits ~5 minutes after your LAST poll, not 5 minutes after completion.

---

## 4. **The core "close and reopen" scenario you asked about**

This is the most important end-to-end scenario and deserves its own
section. It exercises: schedule persistence, job persistence across CLI
exit, the coordinator's on-demand restart, and recovery/reconciliation.

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 4.1 | **Schedule survives app close before firing** | Create a schedule for ~2 minutes in the future (e.g. if it's 10:03 now, schedule `"05 10 * * *" <your local IANA tz>`). **Fully quit agav** (not just background it — actually exit the process). Wait until 1 minute past the scheduled time. **Reopen agav.** | Since the schedule ticker only runs while an interactive agav session is attached (documented baseline: "interactive-only evaluation"), the occurrence that would have fired while agav was closed is **correctly skipped, not caught up** — confirm no job was retroactively launched for that missed minute. This is expected/correct behavior per the design ("no unbounded queue, disconnected-time backfill"), not a bug — but it's worth explicitly confirming this is what actually happens, rather than either (a) silently losing the schedule entirely or (b) incorrectly backfilling a burst of missed jobs. |
| 4.2 | **Schedule resumes firing after reopen** | Continuing from 4.1, leave agav open past the *next* minute boundary. | The schedule fires normally on the next eligible occurrence after reopening — it wasn't accidentally disabled or corrupted by being closed mid-cycle. |
| 4.3 | **Manually started job survives app close while running** | Start `command="sleep 180 && echo survived-restart > /tmp/agav-test-survive.txt"`. Confirm state is `running` via `/process poll`. **Fully quit agav.** | The job's supervisor is a separate detached OS process — verify via `ps aux \| grep entry.js` (or Task Manager/Activity Monitor on Windows/macOS) that it is STILL RUNNING after agav exits. |
| 4.4 | **Reopen and observe the same job** | While the job from 4.3 is still running (quit agav again if more than 3 minutes passed), reopen agav and run `/process poll <same jobId>`. | The SAME job is found with its correct current state (`running`, or `completed` if enough time passed) — not "not found," not a duplicate, not reset to `accepted`. |
| 4.5 | **Confirm no duplicate launch on reopen** | After 4.4, run `/process list`. | Exactly ONE job exists for that original start — reopening agav must never auto-relaunch anything. |
| 4.6 | **Output recoverable after restart** | After the job from 4.3 completes (wait the full 180s, reopening agav if needed), run `/process log <jobId>`. | Full captured stdout is still readable (logs are supervisor-owned files on disk, independent of the CLI process) and `cat /tmp/agav-test-survive.txt` confirms the command genuinely finished. |
| 4.7 | **Close during the schedule's job dispatch window** | Create a schedule for ~30 seconds in the future. Quit agav at the exact moment it should fire (best-effort timing). Reopen a few seconds later. | No duplicate job for that occurrence; either it fired once before you closed, or it's correctly treated as missed (per 4.1's reasoning) — never ambiguous/stuck in a bad state. Check `/process schedule list` and `/process list` for consistency (no "recovery-required" schedule occurrences without a clear reason, no orphaned partial state). |

---

## 5. Idle supervisor self-exit (resource-leak fix verification)

The supervisor process intentionally stays alive for a while after a job
completes (to serve `poll`/`log` requests), then self-exits if idle. Default
is 5 minutes.

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 5.1 | Supervisor stays alive right after completion | Start a quick job, let it complete. Immediately check `ps aux \| grep entry.js` for that job's pid/argv. | The supervisor process for that job is still present. |
| 5.2 | Supervisor self-exits after idle timeout | Let a completed job's supervisor sit untouched (no `/process poll`/`log`/`wait` calls referencing it) for just over 5 minutes. | Check `ps aux \| grep entry.js` again — that supervisor process should be gone. (This is a real-time wait; budget ~6 minutes for this test.) |
| 5.3 | Polling resets the idle clock | Start a quick job, let it complete, then poll/log it once every ~2 minutes for 10+ minutes. | The supervisor should NOT self-exit as long as it keeps receiving activity — confirm it's still present at the 10-minute mark, then stop polling and confirm it exits ~5 minutes after your LAST poll. |
| 5.4 | `cleanup()` terminates the supervisor immediately | **Verified gap, not just a maybe:** as of this writing, `cleanup()` exists on the coordinator API but is NOT exposed by either `run_background_job` (its `Action` type has no `cleanup` case) or `/process` (no `cleanup` sub-command). There is currently no user-facing way to trigger this path at all — treat this row as a documented backlog item (surface `cleanup` in the tool/command) rather than something to test today. If/when it is exposed, the expected result is: the supervisor process for that job is gone right away, without waiting for the 5-minute idle window. |
| 5.5 | No accumulation under normal use | Over a longer working session (e.g. a full day), start/complete 10-20 background jobs naturally through normal use. Periodically check `ps aux \| grep entry.js \| wc -l`. | The count should rise with active jobs but NOT grow unbounded — old completed jobs' supervisors should disappear over time (within ~5 min of your last interaction with each), not accumulate indefinitely. |

---

## 6. Concurrency and capacity

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 6.1 | Concurrent job limit | Start more jobs than `DEFAULT_RESOURCE_LIMITS.maxConcurrentJobs` (4) simultaneously, all long-running (e.g. `sleep 120`). | The 5th+ start attempt is refused with a clear "capacity exceeded" / "limit reached" message — not silently queued, not crashed. |
| 6.2 | Capacity frees up | After one of the 4 jobs from 6.1 completes/is stopped, try starting a new one. | Succeeds now that a slot is free. |
| 6.3 | Idempotent retry | If your tooling/agent ever retries a `start` with the exact same request (this is mostly an internal mechanism, but worth spot-checking if you can trigger it, e.g. by double-submitting a prompt that results in the same tool call) | Returns the SAME job, does not spawn a second supervisor for the same logical request. |

---

## 7. Authorization / permission modes

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 7.1 | `ask` mode refuses start (no confirmation UI yet) | Set `permissionMode: "ask"`. Ask the agent to start a background job (with no prior grant for that exact spec). | **Verified against source:** `ask` mode has no confirmation-UI wiring for this tool yet (`authorization/service.ts`'s `authorize()` just returns `allowed: false` with "Requires interactive confirmation; no existing grant" when there's no pre-existing grant) — so the correct, current behavior is a clean REFUSAL with that message, not a confirmation prompt and not silent auto-approval. If you instead see it silently launch without any confirmation, that IS a real bug — flag it. |
| 7.2 | `deny-writes` blocks start | Set `permissionMode: "deny-writes"`. Try to start a job. | Refused. |
| 7.3 | `deny-writes` still allows stop | With `deny-writes` active, try to stop an existing running job (started earlier under a different mode). | Stop should still be allowed (per design: stop is a separately-authorized emergency action, not blocked by deny-writes) — confirm this is actually true in practice, not just in the authorization unit tests. |
| 7.4 | `deny-writes` blocks schedule creation | With `deny-writes` active, try `/process schedule create`. | Refused. |
| 7.5 | `deny-writes` suppresses schedule firing while connected | Create a schedule under `auto-accept`, then switch the live session to `deny-writes` before the next occurrence, and stay connected. | The schedule should NOT fire while a deny-writes session is connected (per solution.md §11), even though the schedule itself still exists/is enabled. Switch back to `auto-accept` and confirm it resumes firing on the next eligible occurrence. |

---

## 8. Output and log handling

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 8.1 | Large output | Start a command that produces a lot of output, e.g. `command="yes line \| head -n 200000"`. | Does not hang, does not consume unbounded memory; log retrieval shows a bounded/truncated result with a truncation indicator, not the full 200k lines. |
| 8.2 | Binary/garbage output | Start a command producing non-UTF8 bytes, e.g. `command="head -c 1000 /dev/urandom"`. | Log retrieval doesn't crash; output is sanitized/escaped for display rather than corrupting your terminal. |
| 8.3 | Long-running output streaming | Start `command="for i in $(seq 1 20); do echo tick-$i; sleep 5; done"`. Poll log output mid-way through (after ~30s). | Partial output so far (several `tick-N` lines) is visible before the job finishes — logs aren't buffered until completion. |
| 8.4 | stderr capture | Start `command="echo to-stdout && echo to-stderr 1>&2"`. | Both streams are captured and visible in the log output. |

---

## 9. Platform-specific (run these manually on each OS per your note)

### macOS
| # | Scenario | Expected result |
|---|---|---|
| 9.1 | `/process capabilities` on macOS | Reports `platform: darwin`; Seatbelt (`sandbox-exec`) reported available only if actually present, with a deprecation/version-variance note in `limitations`. |
| 9.2 | Stop behavior | A `sleep 60` job stopped via `/process stop` actually terminates (verify via Activity Monitor) within the grace period. |
| 9.3 | App quit via Cmd+Q / terminal close | Background jobs and supervisors survive a terminal window close (not just Ctrl+C) — this is worth testing since some terminal apps send SIGHUP to the foreground process group on window close. |
| 9.4 | Case-insensitive filesystem paths | Should resolve/canonicalize sensibly without creating a duplicate storage location when started with a `cwd` that differs only in case from the canonical path. |

### Windows
| # | Scenario | Expected result |
|---|---|---|
| 9.5 | `/process capabilities` on Windows | Reports `platform: win32`, `nativeHelperAvailable: false`, `strongestOwnershipScope: unverified`, and clear `limitations` explaining no Job Object tree ownership exists in this delivery — confirm this is stated plainly, not silently omitted. |
| 9.6 | Stop behavior and child processes | Start a command that itself spawns a child process (e.g. a batch script invoking another process), then stop it. Per the documented Windows limitation, only the single top-level process is guaranteed to be terminated — verify whether child processes are left running (expected/documented gap) and confirm this matches what `/process capabilities`'s limitations text led you to expect. |
| 9.7 | cmd.exe invocation quirks | Start a command with special cmd.exe characters (e.g. `&`, `\|`, quotes) in the command text. Confirm it's passed through to `cmd.exe /d /s /c` correctly without unexpected translation/escaping bugs. |
| 9.8 | Paths with spaces | Use a `cwd` containing spaces (e.g. `C:\Users\Your Name\project`). Should resolve correctly. |
| 9.9 | Supervisor survives terminal/console close | Close the terminal window (not just Ctrl+C) running agav. Supervisor process(es) for active jobs should still appear in Task Manager afterward. |

---

## 10. Crash / unexpected termination (harder to script, worth at least spot-checking)

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 10.1 | Kill agav forcefully mid-start | Start a job, and within ~1 second (before it likely reaches `running`), force-kill the agav process itself (`kill -9` the CLI's own pid, not the job). Reopen agav and poll that job. | Should resolve to either a legitimate state or `recovery-required`/`unknown` with a clear reason — never silently report `completed`/success without evidence, and never auto-relaunch a duplicate. |
| 10.2 | Kill the supervisor process directly | Start a long job, find its supervisor's pid via `ps aux \| grep entry.js`, and `kill -9` that pid directly (simulating a supervisor crash, distinct from killing the workload). Poll the job from agav afterward. | Should eventually report `unknown` or `interrupted` with a clear uncertainty reason — must never claim the job succeeded, and must disclose that the workload's own descendants may still be running untracked. |
| 10.3 | Machine sleep/suspend during a long job | Start a `sleep 600` job, put the machine to sleep for a few minutes, wake it, then poll. | The job should still be correctly tracked as running (or completed, if it finished) afterward — system sleep should not be misinterpreted as job death. |

---

## Notes for whoever runs these

- Scenarios in §4 and §5 require real wall-clock waiting (minutes, not
  seconds) — budget time accordingly; they can't be meaningfully rushed.
- For every scenario that claims "no orphaned process," actually check
  `ps aux | grep entry.js` (macOS/Linux) or Task Manager (Windows) rather
  than trusting the CLI's own self-report.
- If anything in §9 (Windows/macOS) or §10 (crash handling) surfaces a
  behavior that contradicts what `/process capabilities`'s `limitations`
  field says, that's a documentation bug at minimum, and possibly a real
  defect — report both the actual observed behavior and what was claimed.

---

## Results log template

Copy this table per test pass and fill in a row per scenario run (not
necessarily all 60 every time — see [Scenario categories](#scenario-categories)
for a prioritized subset).

| # | OS | agav version/commit | Pass/Fail | Notes / deviation from expected |
|---|---|---|---|---|
| e.g. 4.1 | macOS 14.5 | `0ffc72de` | ✅ Pass | — |
| e.g. 9.6 | Windows 11 | `0ffc72de` | ❌ Fail | Child process left running after stop; matches documented limitation, not a new bug |
| | | | | |
