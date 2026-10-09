# PR #241 — Knowledge Capture & Gap Analysis

**PR:** [#241 feat: add daemon-backed background process tool](https://github.com/prapaa-ai/agav/pull/241)
**Branch:** `feat/background-process-tool` → `beta`
**Author:** `code-hack-batch`
**Size:** 31 files, +1569 / −127
**State:** CLOSED (never merged) — auto-closed 2026-09-25 after 14 days of inactivity by `agav-bot`
**Verified against:** PR head `c76d36f` (2 commits)

---

## 1. Problem

Agav's only shell execution path was `run_command`, which is deliberately unsuitable for long-running work:

| Constraint in `source/tools/shell.ts` | Consequence for long jobs |
| --- | --- |
| `DEFAULT_TIMEOUT = 30_000` | A dev server, `pnpm test`, or a build is killed at 30s |
| Captures stdout/stderr into buffers | Output only exists in the tool result — nothing survives the turn |
| Process is owned by the CLI turn | Interrupt / exit tears the child down |
| Wrapped in OS sandbox (Seatbelt / Bubblewrap) | Correct for one-shot inspection, wrong for a server that needs to keep listening on a port and stay reachable |

There was also no way to answer *"did the thing I started ten minutes ago finish, and what did it print?"*

The existing `/schedule add "<cron>" <prompt>` only submits **text to the LLM**. Anything recurring that didn't need reasoning (nightly `pnpm test`, a weekly report script) had to pay for a full model turn on every fire, and still went through the 30s timeout.

## 2. Motivation

Two concrete gaps the PR set out to close, stated in its own words:

1. **Non-blocking long commands** — start a command and keep chatting while it runs.
2. **Durable command jobs** — persist job state and logs so a command can complete after Agav exits and be reported when Agav starts again.

And a scheduling gap: recurring *commands* need a trigger path that does not route through the LLM.

Design constraints that shaped the solution:

- Reuse the existing permission model (`SAFE_TOOLS` allowlist, `allowedTools` patterns, `isDestructiveCommand`, `confirmTool`) rather than inventing a second policy engine.
- Persist to the Agav config dir (`~/.agav/…`) so state survives restarts and works with existing session/config conventions.
- Keep the daemon implementation dependency-free — a generated `.mjs` runner, not a new npm package.
- Stay inside the existing `ToolDefinition` contract so `process` is usable by agents, skills, and `allowedTools` rules like any other tool.

## 3. Solution

### 3.1 New `process` tool — `source/tools/process.ts` (452 lines, new)

Six actions:

| Action | Behaviour |
| --- | --- |
| `start` | Write job record → generate `process-runner.mjs` → `spawn` a **detached** Node runner. Returns immediately. |
| `list` | All persisted job records from the active jobs dir. |
| `poll` | One record: status, pid, duration, cwd, command. |
| `log` | Record + stdout/stderr tails (`lines`, default 80, max 1000). |
| `wait` | Poll until terminal state or `timeout_ms` (default 30 000, max 600 000). |
| `kill` | Mark record killed + send `signal` (default `SIGTERM`) to child pid and runner pid. |

Lifecycle: `starting` → `running` → one of `exited` | `failed` | `killed` | `error`.

### 3.2 Daemon architecture

```text
agav (UI)
  └─ spawn(node, [process-runner.mjs, <job>.json], { detached:true, stdio:"ignore" })   ← unref()'d
       └─ spawn(job.command, { shell:true, cwd, env:filtered,
                                stdio:["ignore", open(stdout,"a"), open(stderr,"a")] })
```

The runner re-reads and re-writes the job JSON on every state transition, so the **record is the source of truth**, not any in-memory state. That is what makes reattach work: a restarted Agav only needs the files.

### 3.3 Persistence + reattach

```text
~/.agav/background-processes/
  <job-id>.json         # record
  <job-id>.stdout.log
  <job-id>.stderr.log
  process-runner.mjs    # regenerated on every start
```

- `subscribeToProcessEvents()` starts a 2 s poll of persisted records.
- Terminal records without `notifiedAt` fire a `{type:"completed"}` event and are stamped with `notifiedAt` — **report once**, then never again.
- `use-agent.ts` subscribes and pushes a system message into the main chat with command + last output.
- `AGAV_BACKGROUND_PROCESS_DIR` relocates state (tests, parallel instances).
- `AGAV_NODE` overrides the Node executable used for runners (packaged runtimes).

### 3.4 Permission model integration — `source/agent/loop.ts`

Introduced `isSafeToolCall(toolName, input)` replacing bare `SAFE_TOOLS.has()` at four call sites:

- `list` / `poll` / `log` / `wait` → treated as safe introspection (no confirmation).
- `start` / `kill` → confirmation-gated in `ask` mode.
- `isAllowed()` primary input widened to `command ?? id ?? action` so `process:pnpm test*` allowlist patterns work.

### 3.5 Consent UX — `source/utils/tool-confirmation.ts` (new)

`getToolConfirmationWarning()` renders a yellow `⚠` line in the confirm dialog:

- `start` → *"may keep running after Agav exits… write files, use network, and consume CPU, memory, and disk"*
- `kill` → *"may stop work currently in progress"*

### 3.6 Schedule integration

- `ScheduledTask` gained `kind?: "prompt" | "process"`, `command?`, `cwd?`.
- New `addScheduledProcessTask()`.
- `/schedule background` (aliases `bg`, `process`) → process task; `/schedule add` unchanged.
- `app.tsx` branch: `kind === "process"` → `processTool.execute({action:"start"})` directly, no LLM turn.
- `/schedule list` marks entries `[prompt]` / `[process]`.

### 3.7 Tool registration & docs

- `registry-factory.ts`: registers `process`, adds it to `KNOWN_TOOL_NAMES` (so skills can allowlist it).
- `tool-labels.ts`: `Process` label + summary formatter.
- `skill-creator` bundled skill + manifest: `process` added to the known-tools list.
- Docs: new `/features/background-processes` (265 lines) + `/guides/background-process-manual-test` (260 lines), plus 9 page updates and a regenerated `search-index.json`.

---

## 4. What the PR got right

Worth keeping, because these are the parts a reimplementation would otherwise get wrong:

1. **The record-on-disk is the contract.** Runner and UI share no memory; every transition is a re-read + atomic `write tmp` → `rename`. This is the correct shape for anything that must survive a crash.
2. **`notifiedAt` exactly-once reporting.** The subtle part of reattach, and it was handled.
3. **Permission integration instead of a parallel system.** `isSafeToolCall()` is a minimal, correct generalization of `SAFE_TOOLS` from a `Set` to a predicate — `process:list` is safe, `process:start` is not, and the same set does both jobs.
4. **Confirmation *warning text*, not just a gate.** A gate tells the user a tool is sensitive; the warning tells them *why* this specific one is dangerous.
5. **Scheduled commands skip the LLM.** Right architectural call — cron is a timer, not a reasoning step.
6. **Backward compatibility preserved.** `/schedule add` behaviour is byte-identical; existing configs keep working because `kind` is optional.

---

## 5. Shortcomings

Findings below were **empirically reproduced** by extracting `source/tools/process.ts` from the PR head and executing it standalone (`/tmp/pr241test`). `PASS` in the notes means "the bad behaviour was confirmed to exist".

### 5.1 Correctness / robustness

| # | Issue | Evidence | Severity |
| --- | --- | --- | --- |
| C1 | **Stale `running` records are never reconciled.** No liveness check (`process.kill(pid, 0)`), no heartbeat, no start-time guard. Kill the runner (OOM killer, SIGKILL, reboot) and the record reports `running` forever — poisoning every `list`/`poll`. | PASS: SIGKILL'd both pids; record still `[running]` after 3 s and stays listed | **High** |
| C2 | **A throwing subscriber permanently breaks notification.** `refreshBackgroundProcessNotifications()` calls listeners with no try/catch *before* persisting `notifiedAt`. One throw ⇒ `notifiedAt` never written ⇒ the 2 s poll re-announces the same job indefinitely (notification storm in the main chat). | PASS: throwing listener ⇒ `notifiedAt === undefined`, refresh rejects, repeats forever | **High** |
| C3 | **`wait` blocks the agent turn with no abort path.** `waitForRecord()` is a hard `while` + 100 ms sleep. It ignores the loop's `AbortSignal`, so steering/interrupt during a 10-minute `wait` is impossible. | PASS: `wait` blocked 8032 ms with no way to cancel | Medium |
| C4 | **`cwd` is unvalidated.** `resolve(input.cwd)` accepts any absolute path — `/etc`, `/`, the user's home. `run_command` at least runs sandboxed; this runs raw with the user's full privileges. | PASS: `cwd: "/etc"` accepted | Medium |
| C5 | **Prefix ambiguity silently resolves to one job.** `readRecord()` uses `.find(r => r.id.startsWith(prefix))` — no ambiguity detection. With 3 jobs `aaaa1111/aaaa2222/aaaa3333`, `poll "aaaa"` returns `aaaa1111` and says nothing. `kill`/`wait` do the same. | PASS | Medium |
| C6 | **`terminateAllBackgroundProcesses()` is dead code in production.** Defined and exported, referenced only by tests. There is no shutdown path that reconciles records when Agav exits. | PASS: unreferenced outside tests | Medium |

### 5.2 Resource management

| # | Issue | Evidence | Severity |
| --- | --- | --- | --- |
| R1 | **Logs grow without bound and are never rotated or pruned.** A chatty job fills the disk under `~/.agav`. No TTL, no max size, no max job count, no cleanup action in the tool API. | PASS: 1.2 MB from one job in ~15 s; `readdirSync` shows no pruning | **High** |
| R2 | **Every read slurps the whole log file.** `readLog()` is `readFileSync(path, "utf8")` then `tailLines()`. A 1 GB log is fully loaded into memory on *every* `poll`/`log`/`wait` and on every 2 s notification tick. Should be a bounded tail read (`fs.createReadStream` + last-N-bytes, or `read` with a byte offset). | PASS: 1.2 MB file fully read to return 15 916 chars | **High** |
| R3 | **`filterEnv()` substring-regex over-strips.** `/KEY\|SECRET\|TOKEN\|PASSWORD\|CREDENTIAL\|AUTH/i` is unanchored, so it drops `MONKEY`, `AUTHOR`, `SSH_AUTH_SOCK`, `KEYBOARD`, `GPG_KEY_AGENT`, `npm_config_cache_key`. Silent, undocumented collateral damage to legitimate commands. | PASS | Medium |
| R4 | **`ensureRunnerScript()` rewrites `process-runner.mjs` on every single start** with no version check and no guard against concurrent starts writing the same file. | Source read | Low |

### 5.3 Security

| # | Issue | Detail | Severity |
| --- | --- | --- | --- |
| S1 | **Sandbox bypass, presented as equivalent to `run_command`.** The docs say *"Background process commands are launched by the daemon runner rather than through the normal `run_command` timeout and sandbox path."* That is true — and it is the point. But `process` is registered as a **default built-in tool**, so an agent gets raw unsandboxed shell execution *and* outlives the session. The destructive blocklist is the only guard. | Source + docs | **High** |
| S2 | **The blocklist is bypassable by construction.** `isDestructiveCommand` uses 20 regexes over the raw string. `git reset --hard` is blocked; `git re fs ct --hard`, `$(echo git reset --hard)`, `git reset  --hard`, or `bash -c '…'` are not. Since the *runner* never re-checks, anything that reaches the JSON runs. | Source read | High |
| S3 | **`/schedule background` bypasses the permission gate entirely.** `app.tsx` calls `processTool.execute({action:"start"})` directly — no `permissionMode` check, no `confirmTool`, no `allowedTools` filter at trigger time. A prompt-injected `/schedule` entry becomes a persistent unsandboxed RCE that re-fires on cron. | Source read | **High** |
| S4 | **Schedule commands get no destructive-command validation at creation time.** `/schedule background "0 9 * * *" git reset --hard` is accepted and only fails (silently, at trigger) — and only if the regex matches. | Source read | High |
| S5 | **Env filtering is applied but *undocumented as a security control*, and it strips secrets the child may legitimately need** (e.g. `GITHUB_TOKEN` for a scheduled `pnpm deploy` job). A scheduled deploy silently loses its token with no diagnostic. | Docs + source | Medium |

### 5.4 UX / correctness of reporting

| # | Issue | Evidence | Severity |
| --- | --- | --- | --- |
| U1 | **Completion notification prefers stderr over stdout.** `getBackgroundProcessOutputTail()` returns stderr if non-empty, else stdout. For a successful build that printed warnings, the user sees `npm WARN deprecated` — and **not** `BUILD OK 123 artifacts`. This is backwards. | PASS: stderr shown, stdout hidden | Medium |
| U2 | **Notify-before-persist ordering** (see C2) also means the UI can be told about a job whose stamp write then fails. | | Low |
| U3 | **`exited 0` is hardcoded.** `summarizeStatus()` returns `"exited 0"` for any `exited` regardless of `exitCode`. A record with `status:"exited", exitCode:3` displays as `exited 0`. | Source read | Low |
| U4 | **No `cwd`-relative display.** `formatRecord()` prints absolute `cwd` and raw `command`, unescaped, straight into a terminal-rendered string. Long commands are not truncated (unlike `tool-labels.ts`, which slices at 60 chars). | Source read | Low |

### 5.5 Process / project hygiene

| # | Issue |
| --- | --- |
| P1 | **Never merged, never reviewed.** 0 reviews, 0 review comments, 1 bot comment. Auto-closed after 14 days. The most interesting content in this PR is the *analysis* — which is why it is being written down here. |
| P2 | **Unrelated changes bundled in.** `source/commands/schedule.ts` was fully reformatted (semicolons added, all JSDoc comments deleted) — a 153-line diff where ~30 lines are functional. `source/__tests__/agent-planner-state.test.ts` (`.git` marker for Windows test isolation) has nothing to do with background processes. |
| P3 | **No system-prompt guidance.** `process` is registered but the agent is never told *when* to prefer it over `run_command` (long-running? must outlive the session?). Tool-discovery will be unreliable without a prompt line. |
| P4 | **Test coverage is happy-path only.** 5 tests: start, wait/log, notify-once, notify-twice-doesn't-repeat, destructive-block. **Zero** tests for: `kill`, `list`, prefix matching, `poll`, reattach across a *real* process boundary, `terminateAllBackgroundProcesses`, the `isSafeToolCall` gate for `kill`, or `getBackgroundProcessOutputTail` stderr-vs-stdout preference. |
| P5 | **The manual-test guide is the only real verification.** 260 lines of manual checklist — which is honest about the automation gap, and also evidence of it. |

---

## 6. Additional fixes we can do

Ordered by value/effort. Items 1–4 are small, self-contained, and each closes a *confirmed* defect.

### Tier 1 — small, high impact

**1. Reconcile dead records (closes C1).**
Add liveness checking in `listBackgroundProcesses()` or a `reconcileRecords()` pass called from the 2 s poll:

```ts
function isAlive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; }
}
```
If a record is `running`/`starting`, older than `STALE_AFTER_MS` (say 30 s of no log growth **and** `!isAlive(pid)`), flip it to `error: "runner exited without reporting"` and stamp `finishedAt`. This is the single highest-value fix — it is the difference between "reliable job tracking" and "job tracking that lies forever".

**2. Never let a listener block the notification stamp (closes C2).**
Reorder + isolate in `refreshBackgroundProcessNotifications()`:

```ts
for (const record of listBackgroundProcesses()) {
  if (!isTerminal(record) || record.notifiedAt) continue;
  // stamp FIRST, then notify — at-most-once is guaranteed even if notify throws
  await writeJsonAtomic(jobPath(record.id), { ...record, notifiedAt: new Date().toISOString() });
  for (const listener of listeners) {
    try { listener({ type: "completed", record: { ...record } }); } catch { /* isolate subscribers */ }
  }
}
```
Stamp-first converts the failure mode from *infinite storm* to *at-most-once*, which is the guarantee we actually want.

**3. Log rotation + a retention policy (closes R1).**
- Rotate in the runner when a log exceeds `MAX_LOG_BYTES` (e.g. 10 MB): rename to `<job>.stdout.log.1` and start fresh — keeps the tail cheap.
- Prune on `start`: delete records whose `finishedAt` is older than `RETENTION_DAYS` (e.g. 7) and cap the total at `MAX_RECORDS` (e.g. 200), oldest-first.
- Add a `process clean` action (or `cleanup: true` on `list`) exposed to the user, and surface disk usage in `list`.

**4. Prefer stdout for completion notifications (closes U1).**
`getBackgroundProcessOutputTail()` should prefer **stdout**, fall back to stderr, and label which stream it came from. Warnings matter, but the build result matters more.

### Tier 2 — correctness & safety hardening

**5. Bounded tail reads (closes R2).** Replace `readFileSync` + `slice` with a real tail: stat the file, `read` only the last `~64 KB` (or last N lines via a reverse chunk scan), and slice. Keeps `poll` O(tail) instead of O(file) — matters a lot once rotation lands.

**6. Ambiguity detection (closes C5).** In `readRecord()`, collect *all* prefix matches:

```ts
const matches = listBackgroundProcesses().filter(r => r.id.startsWith(prefix));
if (matches.length > 1) return { ambiguous: matches.map(m => m.id) };  // surface to the agent
```
Return an error for `kill`/`wait`/`log` in that case. `poll` can still show all of them.

**7. Anchor the env regex (closes R3).** Replace the unanchored alternation with segment-boundary matching:
```ts
/(^|_)(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)S?($|_)/i
```
`MONKEY`/`AUTHOR` survive; `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN` are stripped. Then log which variables were removed (`[process] filtered env: GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY`) so a scheduled deploy that loses its token is diagnosable instead of mysterious (closes S5).

**8. Route scheduled starts through the permission gate (closes S3).** Do not call `processTool.execute()` from `app.tsx`. Instead, extract the gate:
```ts
// source/agent/permissions.ts
export function authorizeToolCall(name, input, { permissionMode, allowedTools, confirmTool }): Promise<boolean>
```
and have *both* `runAgentLoop` and the scheduler checker call it. Then `deny-writes` actually blocks a scheduled process task, `allowedTools` filters apply at trigger time, and the trust boundary is a single function.

**9. Validate the schedule at creation time (closes S4).** In `addScheduledProcessTask()`, run `isDestructiveCommand(command)` and refuse. If it must be allowed, require an explicit `/schedule background --force` and record the override in the task. Validate `cwd` exists and is a directory.

**10. Constrain `cwd` (closes C4).** Require the resolved `cwd` to be inside the project root (or `~/.agav`), unless an explicit `--allow-outside-project` is set. At minimum, reject filesystem roots and warn for anything outside the repo.

**11. Make `wait` abortable (closes C3).** Thread the loop's `AbortSignal` (or a per-call one) into `waitForRecord`:
```ts
while (Date.now() <= deadline && !signal?.aborted) { ... }
```
and return `"wait cancelled by user"` when aborted. The 2 s notification path already handles interruption for the UI; the tool path should match.

**12. Re-validate inside the runner (deepens S2).** Pass the resolved command to the runner and have it re-run `isDestructiveCommand` — or better, have the *parent* write an `approved: true` nonce into the record and refuse to run otherwise. Turn the blocklist from a regex gate into a defence-in-depth check rather than the only check.

**13. Expose sandboxing as an explicit opt-in.** Given S1, do not silently pretend `process` is equivalent to `run_command`. Offer `sandbox: "auto" | "off"` on `start`, defaulting to `auto` (Seatbelt/Bubblewrap via the existing `runInSandbox` machinery), and state clearly in the confirm dialog + docs when a job runs unsandboxed.

### Tier 3 — product completeness

**14. System-prompt guidance (closes P3).** One line in the shell-tools section of the system prompt:
> Use `process start` instead of `run_command` for commands that take more than ~30 seconds, must survive this session, or need to be scheduled (`/schedule background`). Use `run_command` for quick, one-shot commands.

**15. Tests for the untested surface (closes P4).** Add cases for: `kill` (live + stale + already-terminal), `list` filtering, prefix ambiguity, `kill` confirmation gating, reattach across a genuine process restart (spawn the runner, exit, resubscribe), `terminateAllBackgroundProcesses`, reconciliation of dead records (fix 1), stdout-preferred notification tails (fix 4), and env-filter allow/deny cases (fix 7). Every one of these maps to a confirmed defect above — the test suite is what let C1/C2/U1/R2 through.

**16. `exited <code>` from the real code (closes U3).** `summarizeStatus()` should read `record.exitCode`, not hardcode `0`.

**17. Signal hygiene.** `process.kill()` inside `kill` sends to the child and then the runner. The runner's own `SIGTERM` handler *also* rewrites the record — so the parent and the runner race on the same JSON. Write the parent-side stamp first (already done) and let the runner's handler be a no-op when the record is already `killed`. Also: signals are cast blindly (`String(input.signal) as NodeJS.Signals`) — validate against a known set so `process.kill` cannot throw an unhandled `ERR_UNKNOWN_SIGNAL`.

**18. Status line + `/process` slash command.** Surface the active jobs in the status line (e.g. `3 bg jobs · 1 running`) and add `/process` to list/kill from the UI without an LLM turn. Right now the only way to see jobs is to ask the model.

**19. Bundle the runner as a real file.** R4: ship `process-runner.mjs` as a build artifact next to the binary instead of writing a string literal to disk on every start. Removes the write race, makes the runner lintable/testable, and lets it be versioned with the CLI.

### Tier 4 — if the PR is revived

**20. Split the diff.** Land C1/C2/R1/R2/U1 fixes + tests as one PR (all confirmed defects, all small). Land the feature behind an opt-in flag (`features.backgroundProcesses`) as a second PR. Drop the `schedule.ts` reformat and the Windows planner-test fix from the feature diff.

**21. Clear the naming.** `source/tools/process.ts` exporting `processTool`, `listBackgroundProcesses`, `subscribeToProcessEvents`, `terminateAllBackgroundProcesses` is a grab-bag of a tool, a store, an event bus, and a supervisor in one file. Split into `tools/process.ts` (the `ToolDefinition`), `services/background-processes/` (store + supervisor + events). Same for `utils/tool-confirmation.ts`, which is a two-branch function with `if (toolName !== "process") return undefined` — that belongs as a `confirmWarning` on the tool schema itself, so any tool can supply one.

---

## 7. One-paragraph summary

PR #241 identified a real and well-scoped gap — `run_command`'s 30 s timeout and in-turn ownership make it unusable for long-running or must-survive-the-session work — and solved it with the right architecture: file-backed job records written atomically by a detached per-job runner, `notifiedAt` exactly-once reporting on restart, and a permission integration (`isSafeToolCall`) that reuses the existing gate rather than inventing a second one. Its weaknesses are not in the design but in the operational edges: dead records are never reconciled (C1), a throwing subscriber permanently breaks notification (C2), logs are unbounded and re-read in full on every poll (R1/R2), and — most importantly — an unsandboxed, session-surviving shell tool is exposed as a default built-in and reachable from `/schedule background` with no permission check at trigger time (S1/S3). Items 1–4 in section 6 are small, independent, and each closes an empirically confirmed defect; they are the minimum bar for reviving this work.