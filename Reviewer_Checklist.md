## Reviewer Checklist

### General
- [ ] CI green: Type Check, Build Check, Tests all SUCCESS
- [ ] No new failures vs beta baseline
- [ ] No untracked files, no scratch scripts left in the branch
- [ ] Commit messages are descriptive
- [ ] PR description is accurate and up to date

### PR #409 — daemon-backed background process tool
- [ ] Background process starts detached and survives terminal close
- [ ] `agav process list` shows `detached: true`
- [ ] Completion notification is shown once
- [ ] Stop command terminates the child cleanly
- [ ] No state leakage into real `~/.agav` from tests

### PR #411 — workflow runtime with resumable execution
- [ ] Workflow can be paused and resumed from last completed node
- [ ] Checkpoint file is written on pause and read on resume
- [ ] History shows `paused` → `running` transition
- [ ] Resumed run does not re-execute completed nodes
- [ ] No duplicate side effects on resume

### PR #412 — workflow hardening
- [ ] Retry requires approval for agent/tool nodes unless `retrySafe: true`
- [ ] Token budget stops run and metrics reflect budget hit
- [ ] Run-level `maxRuntimeSeconds` caps wall-clock time
- [ ] Clean shutdown leaves run `paused` and resumable
- [ ] `when` branching skips nodes with reason recorded and unblocks dependents
- [ ] Idempotency key is scoped per tool

### PR #413 — workflow scheduling + headless daemon
- [ ] `agav scheduler add/list/tick/remove/enable/disable` work end-to-end
- [ ] Cron matching is correct, day anchoring and midnight wrap work
- [ ] Overlap guard prevents concurrent runs for the same task
- [ ] Orphan reconciliation unblocks a task whose job record is stale
- [ ] Daemon `start/status/stop` works, evaluates immediately on start
- [ ] Daemon refuses to start if a live daemon already owns the schedule
- [ ] Daemon logs tick failures instead of crashing
- [ ] Daemon record is removed on clean stop
- [ ] Desktop notifications are delivered once per run
- [ ] Tests are isolated: no writes to real `~/.agav`
- [ ] Manual test guide `Workflow_manual_test_guide.md` is present and accurate
