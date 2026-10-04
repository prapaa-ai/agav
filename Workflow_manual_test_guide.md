# Manual Test Guides

## PR #409 — daemon-backed background process tool

**What it does**
Runs long-lived background processes detached from the terminal, with notifications on completion.

**Manual test — criteria**
1. Start a background process via the CLI / TUI.
2. Close the terminal.
3. Process continues and a notification is shown on completion.

**Example**
```bash
# In an interactive session
agav process start --name "keep-alive" --cmd "node -e \"setInterval(()=>{}, 1000)\""

# Close the terminal, wait a minute, then check
agav process list
# Expect: keep-alive is running, detached: true
```

**Pass criteria**
- Process remains alive after terminal close.
- `agav process list` shows `detached: true`.
- Completion notification appears once.

---

## PR #411 — workflow runtime with resumable execution

**What it does**
Adds a workflow runtime that can pause, resume, and checkpoint nodes.

**Manual test — criteria**
1. Run a workflow with at least two nodes.
2. Stop the run mid-way.
3. Resume and verify it continues from checkpoint.

**Example**
```bash
# Create wf.yaml with two agents
agav workflows run wf.yaml --resume
# Interrupt with Ctrl+C during node 2
# Then:
agav workflows resume <run-id>
```

**Pass criteria**
- Run status becomes `paused` on interrupt.
- Resume picks up at the last completed node, not from start.
- History shows `paused` → `running` transition.

---

## PR #412 — workflow hardening: retry, budgets, deadlines, shutdown, branching

**What it does**
Retries with approval, token budget enforcement, run-level max runtime, clean shutdown, and `when` branching.

**Manual test — criteria**
1. Retry policy requires approval for agent/tool nodes.
2. Token budget stops a run.
3. Run-level deadline caps total runtime.
4. Clean shutdown preserves resume point.
5. `when` skips nodes with reason recorded.

**Examples**

Retry approval:
```yaml
# wf.yaml
- id: noisy
  type: agent
  agent: flaky
  task: "Do something"
  retryPolicy:
    maxAttempts: 3
```
Start run, force failure → expect prompt for retry approval.

Token budget:
```yaml
policies:
  tokenBudget: 500
```
Run a long agent → expect run to stop with `exceeded tokenBudget`.

Run deadline:
```yaml
maxRuntimeSeconds: 5
```
Run a slow tool → expect run to stop with `runtimeExceeded: true`.

Branching:
```yaml
- id: triage
  type: agent
  task: "Classify severity"
- id: page
  type: agent
  task: "Page on-call"
  dependsOn: [triage]
  when: '${nodes.triage.output.severity} == "high"'
```
Set severity low → page node is `skipped` with reason recorded.

**Pass criteria**
- Retry requires approval unless `retrySafe: true`.
- Token budget stops run, metrics show budget hit.
- Run deadline caps wall-clock time, in-flight node checkpointed.
- Clean shutdown leaves run `paused` and resumable.
- Skipped nodes recorded with reason, dependents still unblocked.

---

## PR #413 — workflow scheduling with headless daemon

**What it does**
Cron scheduling for workflows, overlap guard, orphan reconciliation, and a headless scheduler daemon.

**Manual test — criteria**
1. Add a scheduled task, verify it fires.
2. Overlap guard prevents concurrent runs.
3. Orphan reconciliation unblocks a stale job.
4. Daemon starts/stops cleanly and evaluates immediately.

**Examples**

Add and list:
```bash
agav scheduler add "*/1 * * * *" wf.yaml
agav scheduler list
# Expect: task listed, next run time shown
```

Overlap guard:
- Set cron `* * * * *` on a workflow that sleeps 120s.
- Wait two minutes → only one run should be active at a time.
- `agav scheduler list` shows `previous run still in flight` skip reason.

Daemon:
```bash
agav scheduler daemon start
agav scheduler daemon status
# Expect: daemon running, pid shown
agav scheduler daemon stop
```

**Pass criteria**
- Scheduled run fires at the correct minute.
- Overlap guard skips new run if previous is still in flight.
- Orphaned job record is reconciled and task fires next tick.
- Daemon starts, evaluates immediately, logs ticks, clears record on stop.
- No duplicate notifications for the same run.
