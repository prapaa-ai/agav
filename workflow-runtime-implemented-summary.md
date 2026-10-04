# Workflow Runtime Implemented Summary

## Current implementation state

The workflow runtime now supports:

- workflow YAML/JSON loading;
- workflow validation;
- CLI and slash command execution;
- checkpointed run/node state;
- resume from checkpoints;
- approval checkpoint decisions;
- checkpoint/status visibility;
- pending node visibility;
- pause/cancel state;
- retry/rewind checkpoint invalidation;
- dry-run mode;
- eval fixtures;
- attempt history;
- cooperative cancellation hooks;
- node timeout checkpoints;
- conservative retry approval for interrupted mutating/unknown agent and tool nodes;
- basic `retryPolicy.maxAttempts` enforcement;
- idempotency key propagation to A2A workflow agents.

## Node types implemented

| Node type | Status |
| --- | --- |
| `tool` | Implemented |
| `agent` (native + A2A) | Implemented |
| `test` | Implemented |
| `approval` | Implemented |
| `prompt` / `reduce` | Implemented |
| `skill` | Implemented when an executor is supplied |
| `parallel` | Implemented (fan-out/fan-in, bounded concurrency, child checkpoints) |
| `loop` | Implemented (bounded iterations, per-iteration checkpoints, `stopWhen`) |

## Parallel node

A `parallel` node runs its `children` with a bounded concurrency limit and
aggregates child outputs into a single parent checkpoint.

```yaml
- id: inspect_all
  type: parallel
  maxConcurrency: 3
  dependsOn: [seed]
  children:
    - id: inspect_auth
      type: agent
      agent: reviewer
      task: Inspect auth
    - id: inspect_api
      type: agent
      agent: reviewer
      task: Inspect API
```

### Behavior

| Concern | Behavior |
| --- | --- |
| Concurrency | `node.maxConcurrency` → `policies.maxConcurrency` → `4` |
| Child ordering | Children run in dependency order; siblings without deps run together |
| Output | `{ childOutputs: { <childId>: <output> } }` |
| Child failure | Parent fails with the failing child statuses and errors |
| Approval children | Parent becomes `waiting_approval` and lists awaiting children |
| Cancellation | Signal is checked between child batches |
| Checkpoints | Every child writes its own checkpoint and attempt history |
| Resume | Children already `passed`/`skipped` are not re-executed |

### Scoping rules

- Nested children are owned by their parent `parallel` node and are **not**
  scheduled as independent run-level nodes.
- A child may depend on a sibling child or on a top-level node.
- A child may **not** depend on a node scoped inside another `parallel` or
  `loop` node; the validator rejects this with an explicit issue.

## Loop node

A `loop` node repeats its `body` up to a bounded number of iterations and
stops early when a body node reaches the configured `stopWhen` status.

```yaml
- id: fix_until_green
  type: loop
  maxIterations: 3
  stopOnFailure: false
  stopWhen:
    node: run_tests
    status: passed
  body:
    - id: run_tests
      type: test
      assertions:
        - type: command
          command: pnpm test
    - id: fix
      type: agent
      agent: coding_agent
      task: Fix the failures
```

### Behavior

| Concern | Behavior |
| --- | --- |
| Iteration bound | `node.maxIterations` → `policies.maxIterations` → `3` |
| Early exit | Stops when `stopWhen.node` reaches `stopWhen.status` (default `passed`) |
| Exhaustion | Fails when the bound is reached without satisfying `stopWhen` |
| Failure policy | `stopOnFailure: true` (default) fails fast; `false` continues to the next iteration |
| Output | `{ iterations, completedIterations, stoppedEarly, exhausted }` |
| Cancellation | Signal checked before each iteration |

### Per-iteration checkpoint identity

Each body node runs under an iteration-scoped id (`<nodeId>#<iteration>`), so
every iteration gets its own checkpoint and attempt history:

```text
nodes/check#1.json
nodes/check#2.json
nodes/check#1.attempts/1.json
```

This is what makes loop resume correct: on resume the loop replays from
iteration 1 but reuses any existing terminal checkpoint for that exact
iteration, so completed iterations are never re-executed.

A `failed` body checkpoint from an earlier pass is still a real result and is
reused. Only a `running` (interrupted) checkpoint is re-executed.

### Scoping rules

- Body nodes are owned by the loop and are not scheduled as run-level nodes.
- A body node may depend on another body node or a top-level node.
- `stopWhen.node` must name a body node; the validator rejects it otherwise.
- `maxIterations` must be a positive integer.

## Retry hardening

Retry policy is centralized in `source/workflows/retry.ts`.

```ts
resolveRetryDecision(ctx): RetryDecision   // execute | wait_approval | exhausted | reuse
effectiveMaxAttempts(node): number
effectiveCrashAttempts(node): number
backoffDelayMs(policy, attempt): number
shouldRetryNode(node): boolean
```

### Two independent budgets

| Budget | Governs | Default |
| --- | --- | --- |
| `effectiveMaxAttempts` | retry-on-error | `1` (no automatic retry) |
| `effectiveCrashAttempts` | recovery of an interrupted (`running`) node | `2` |

Crash recovery stays possible even when failure retries are disabled, so work
in progress when the process died can still finish on resume. A failed external
call is never silently re-executed.

### Policy fields

```ts
retryPolicy: {
  maxAttempts,                 // total attempts, default 1
  retryOnFailure,              // opt-in automatic retry on error
  retryRunningAfterCrash,      // may an interrupted node retry
  requireApprovalBeforeRetry,  // force approval before retry
  initialDelayMs,              // backoff base
  backoffMultiplier,           // growth factor, default 2
  maxDelayMs,                  // backoff cap, default 60000
  nonRetryableStatuses,        // never retry these statuses
}
retrySafe: boolean             // permits crash retry without approval
```

### Runtime behavior

- The scheduler re-admits failed/timed-out nodes that still have retry budget.
- Backoff is applied between scheduler passes and is abort-aware.
- `stopOnFailure` only trips on failures that are actually terminal.
- `pending` (an operator reset via retry/rewind) always executes, regardless of
  the automatic retry budget.
- Approval nodes are exempt from the retry policy so a pending decision is always
  re-surfaced.
- A progress guard fails the run after 3 consecutive no-progress scheduler
  passes instead of spinning.

### Idempotency

`ToolContext.idempotencyKey` is now populated for tools invoked by native
agents, and A2A agents receive the key in their invocation context. The default
key is `${run.id}:${node.id}` and can be overridden per node via `idempotencyKey`.

## Token usage accounting

Token usage is now captured for **every** node type that can call a model, not
just `prompt`/`reduce`.

### Executor APIs

```ts
// source/agents/executor.ts
executeNativeAgentDetailed(agent, task, deps): Promise<AgentRunResult>
executeNativeAgent(agent, task, deps): Promise<string>          // unchanged
executeA2AAgentDetailed(agent, task, opts): Promise<AgentRunResult>
executeA2AAgent(agent, task, opts): Promise<string>             // unchanged

// source/agents/a2a-client.ts
readA2AUsage(metadata): A2AUsage                               // zeroed when absent
```

`AgentRunResult` is `{ output, usage }`. The original string-returning functions
are kept as thin wrappers, so existing callers are unaffected.

### Where usage comes from

| Node type | Source |
| --- | --- |
| `agent` (native) | `usage` events from `runAgentLoop`, accumulated in `executeNativeAgentDetailed` |
| `agent` (A2A) | `usage` / `tokenUsage` in the response metadata, via `readA2AUsage` |
| `skill` | `tokenUsage` already returned by `executeSkill` |
| `prompt` / `reduce` | `usage` events from `runAgentLoop` |
| `tool`, `test`, `approval` | no model calls, so no usage |

Usage lands on the node checkpoint and folds into `computeRunMetrics`, so
`/workflows metrics` now reports the true token cost of a run.

### Backward compatibility

`WorkflowRuntimeDeps.executeAgent` and `executeSkill` accept either a plain
string or a `{ output, usage }` result, so custom executors written against the
old contract keep working.

### External (A2A) agent budgets

External agents run out of process, so their token consumption **cannot be
measured** from here. Rather than invent a number, the runtime distinguishes
three states:

| State | Meaning |
| --- | --- |
| Budget reported | The agent returned a `tokenBudget`; it is displayed |
| Usage reported | The agent returned `usage`; counts are included |
| Nothing returned | Flagged explicitly as "no token budget returned" |

An external agent opts in by returning either field in its response metadata:

```json
{
  "output": "done",
  "isError": false,
  "metadata": {
    "usage": { "inputTokens": 120, "outputTokens": 40 },
    "tokenBudget": { "limit": 5000, "used": 160, "period": "run" }
  }
}
```

Alternative field names are accepted (`tokenUsage`, `maxTokens`, `consumed`,
`left`). Malformed values are ignored rather than reported as real figures.

### APIs

```ts
hasA2AUsage(metadata): boolean            // false = no report, not zero usage
readA2ATokenBudget(metadata): A2ATokenBudget | undefined
formatA2ATokenBudget(budget): string      // "No token budget returned" when absent
```

Checkpoints record `usageReported` and `tokenBudget`.

### Display

```ts
formatNodeBudget(node): string   // per-node status
NO_TOKEN_BUDGET                  // "no token budget returned"
```

Per-node budget status appears in the checkpoint list on both `agav workflows
checkpoints` and `/workflows checkpoints`, in the same meta column as duration
and attempts:

| Node state | Displayed |
| --- | --- |
| Reported budget | `limit 5000, used 160, remaining 4840 (run)` |
| Usage reported, no budget | `60 tok` |
| Nothing reported (agent) | `! no token budget returned` |
| Not a model-calling node | *(nothing)* |

`status` additionally prints a warning line when any external agent reported
nothing:

```text
Warning: no token budget returned by external agent(s): remote_call
```

and the metrics rollup ends with either an `External agent budgets:` section or
a `No token budget returned by external agents:` section.

## Run-level runtime ceiling

`policies.maxRuntimeSeconds` bounds the whole run. Previously the field was
declared but never read, so a long `loop` or slow chain could run indefinitely.

### Behavior

- The clock starts when the run begins executing, so a **resumed run gets a
  fresh budget** rather than inheriting time already spent in a prior process.
- A node's effective timeout is `min(node timeout, remaining run budget)`, so a
  single slow node or one loop iteration cannot push the run past its ceiling.
- The run terminates as **`timed_out`**, distinct from `failed`.
- Any node still `running` when the ceiling hits is checkpointed as
  `timed_out` with an `endedAt`, leaving partial state inspectable and resumable.
- A node cut short by the run budget is tagged `timedOutBy: "run"`, so it is
  not miscounted as a genuine failure. A node that hit its own timeout is
  tagged `timedOutBy: "node"` and still fails the run normally.
- `0` or negative values are ignored, leaving the run unbounded.

```yaml
policies:
  maxRuntimeSeconds: 300
  maxNodeRuntimeSeconds: 60
```

Metrics surface `maxRuntimeSeconds` and `runtimeExceeded`, and the report prints
`Run exceeded its maxRuntimeSeconds ceiling.`

## Clean shutdown and restart

Cancellation was previously checked at scattered call sites, so a tool that ignored its
signal was abandoned mid-flight: its node was checkpointed `cancelled` while the promise
kept running, and the process had no way to exit cleanly.

### RunController

```ts
createRunController(parent?: AbortSignal): RunController
```

| Member | Purpose |
| --- | --- |
| `signal` | Passed to every tool, agent, and skill so they can stop early |
| `abort(reason)` | Aborts once; the first reason wins |
| `track(work)` | Registers in-flight node work |
| `settle(graceMs)` | Waits for that work, bounded; reports what was abandoned |

### Shutdown sequence

1. Abort the run controller, signalling every in-flight node.
2. `settle()` waits up to `options.shutdownGraceMs` (default 5000ms).
3. Nodes still `running` are checkpointed `cancelled`.
4. The run is saved as `paused` (or `cancelled`), leaving it resumable.
5. If work outlived the grace period, `onShutdownWarning` reports it rather than exiting silently.

The scheduler no longer blocks on a batch that ignores its signal, so the grace period can
actually bound a stuck tool instead of hanging indefinitely.

### Cancelled is not failed

A node stopped by shutdown is interrupted, not failed. It is deliberately excluded from:

- `stopOnFailure`, so a stopped run is never reported as `failed`;
- `summarizeTerminalState().failed`, which reports it separately as `cancelled`;
- retry policy and attempt budgets, so it always re-runs on resume;

`nonRetryableStatuses` still wins, so an explicit policy opt-out is honoured.

A resumed run clears the previous stop reason and starts with a fresh `maxRuntimeSeconds` budget.

### Tool context

```ts
ToolContext { env?, idempotencyKey?, signal? }
ToolRegistry.execute(name, input, context?)
```

Tools invoked by a workflow node receive the run signal and an idempotency key, so they can
stop promptly and deduplicate side effects across retries. The agent loop still invokes tools
without a context, so `execute` only forwards a second argument when one is supplied.

## Token and cost budget enforcement

`policies.tokenBudget` was declared but never checked, so a runaway agent node could
overspend without the run noticing. It is now enforced against the usage the
observability layer already records.

### Behavior

- Cumulative input + output tokens are summed from the run's node checkpoints, so the
  figure stays correct across a resume, where earlier nodes ran in a prior process;
- the budget is checked **between nodes**, alongside the `maxRuntimeSeconds` ceiling. A
  model call cannot be interrupted once issued, so the earliest correct place to act is
  where the spend has just become known and no further work has started;
- exceeding it fails the run with `Workflow exceeded its tokenBudget (used/limit tokens)`,
  naming the actual spend so an overshoot is visible;
- `0`, negative, and missing values leave the run unbounded;
- nodes that reported no usage contribute nothing.

**Enforcement boundary:** nodes already admitted in the current scheduler pass still
complete. The budget prevents *subsequent* work, not work in flight. That is a deliberate
consequence of not being able to interrupt a model call, and it is covered by a test so the
boundary cannot drift silently.

### Conditional branching (`when`)

The runtime had no branching primitive: every node in a definition always ran, so a
workflow could not route on what an agent decided. That is the one control-flow feature
a multi-agent workflow cannot be built without.

### Usage

```yaml
nodes:
  - id: triage
    type: agent
    agent: classifier
    task: Classify this issue
    outputSchema:
      type: object
      required: [severity]
      properties:
        severity: { type: string }

  - id: page_oncall
    type: agent
    agent: notifier
    task: Page the on-call engineer
    dependsOn: [triage]
    when: '${nodes.triage.output.severity} == "high"'

  - id: file_ticket
    type: agent
    agent: tracker
    task: File a low-priority ticket
    dependsOn: [triage]
    when: '${nodes.triage.output.severity} != "high"'
```

### Supported expressions

| Form | Example |
| --- | --- |
| Truthiness | `${nodes.gate.output.flag}` |
| Equality / inequality | `${nodes.t.output.severity} == "high"` |
| Ordering | `${nodes.scan.output.count} > 0`, `>=`, `<`, `<=` |
| Run inputs | `${inputs.mode} == "prod"` |

Deliberately not a general expression language. A dark factory routes on decisions, so
the useful surface is small; anything more invites YAML that is hard to reason about when
a run misbehaves. Numeric strings compare numerically, so `output.count` of `"3"` satisfies
`> 0`. A non-numeric operand in an ordered comparison is not satisfied rather than silently
comparing `NaN`.

### Behavior

- A node whose condition is false is checkpointed `skipped`, with `skippedReason` naming the
  condition. The run records *why* work did not happen instead of leaving a gap;
- the skip is durable, so a resume does not re-evaluate the branch;
- a skipped dependency still unblocks its dependents. Otherwise a conditional branch would
  deadlock the run;
- a dependent with its own `when` is evaluated rather than auto-satisfied, so it can still
  decide to run against a skipped upstream result;
- conditions are validated before execution: a malformed condition such as `== "high"`,
  which would interpolate to an empty left-hand side, fails the run up front instead of
  silently skipping work.
## Completion reporting for detached runs

A scheduled run executes with no terminal attached, so its result has nowhere to appear
unless something reports it. Mirrors the background-process record: a run carries
`notifiedAt`, and delivery happens exactly once — on this poll if a session is live, or on a
later session if it was not.

### APIs

```ts
// runtime hook — fires once per terminal transition
WorkflowRuntimeDeps.onComplete?: (run: WorkflowRun) => void

// delivery — safe to call often; already-reported runs are skipped
refreshWorkflowRunNotifications(store?, extraSinks?): Promise<WorkflowRunEvent[]>
subscribeToWorkflowRunEvents(listener, { store?, extraSinks? }): () => void
appendNotificationLog(event): Promise<void>
readNotifications(limit?): Promise<string[]>
clearNotifications(): Promise<void>
stopWorkflowRunNotificationPolling(): void
```

| Concern | Behavior |
| --- | --- |
| Fires on | `passed`, `failed`, `cancelled`, `timed_out` |
| Not fired on | `waiting_approval` — a paused run is not finished |
| Delivery | Stamped `notifiedAt` *after* sinks run, so a throwing sink is retried rather than silently dropped |
| Broken sink | Isolated: other sinks and the log still receive the event |
| Broken hook | `onComplete` throwing cannot turn a successful run into a failed one |
| Headless sink | `~/.agav/notifications.log`, always written, so a run on a machine with no UI still leaves a trail |

Dependency-free by design: sinks are plain functions, so OS-level notification can be added
without this module taking a dependency on it.

## Headless execution

`agav workflows run <workflow>` is fully self-contained — no TUI import — so it works as the
body of a detached child process.

The provider is resolved **lazily**. It was previously created eagerly, which made every
headless run require credentials even when no node called a model; a tool-only, test-only, or
approval-only workflow aborted on a missing API key. Resolution now happens on first `stream`,
so the failure lands on the node that actually needs a model and carries that node's error.

Covered by a CLI smoke test that runs a credential-free workflow with every provider key
blanked.
### Desktop and terminal notification

`agav workflows notifications` reports runs that finished while nothing was watching, and
picks up anything a session missed. It signals through two sinks:

| Sink | When | Behaviour |
| --- | --- | --- |
| Terminal bell | Always | `BEL` on a TTY. The one signal that needs no daemon and no desktop session. |
| Desktop banner | `desktopNotifications: true` | The OS notification centre. |

The durable `notifications.log` is written regardless, so a failed banner never loses the
result.

Desktop notifications are **dependency-free**. The project ships as a single `bun --compile`
binary and has no native-binding dependencies, so a notifier package would break that. Each
platform's own mechanism is invoked instead:

| Platform | Primary | Fallback |
| --- | --- | --- |
| macOS | `osascript` (`display notification`) | — |
| Windows | WinRT toast via PowerShell | `NotifyIcon` balloon tip |
| Linux | `notify-send` | `zenity --notification` |

Every path is best-effort and never throws: a machine with no notification daemon resolves to
`delivered: false` rather than failing the command. Notification bodies are escaped for the
target shell, so a workflow name or error containing `;`, `$(…)`, or quotes is data, never a
command line.

### Exactly one notification per run

Each platform script prints a sentinel once it has actually shown something, and that
sentinel is the **sole** authority on success. The exit code is not: a Windows toast can
appear and still leave a non-zero exit, and treating that as failure ran the fallback too,
producing two banners for one run. A fallback now runs only when the previous mechanism
reported nothing at all.

At the run level, a finished run carries `notifiedAt`, so repeated polls — a background
session plus a manual `agav workflows notifications` — still deliver exactly one message
per run. Both properties are covered by tests.

```json
{
  "desktopNotifications": true
}
```

Off by default, because a banner is noise on a shared or remote screen.
## Detached workflow jobs

A scheduled run must outlive whatever started it: the terminal that launched it, and
eventually the daemon that triggered it. `source/workflows/jobs.ts` gives a run that lifetime.

```ts
startWorkflowJob({ target, runId, input?, cwd? }): Promise<WorkflowJobRecord>
stopWorkflowJob(jobId): Promise<WorkflowJobRecord | null>
listWorkflowJobs(): Promise<WorkflowJobRecord[]>
listOrphanedWorkflowJobs(): Promise<WorkflowJobRecord[]>
isWorkflowJobAlive(record): boolean
markWorkflowJobFinished(jobId, outcome?): Promise<WorkflowJobRecord | null>
pruneWorkflowJobs(maxAgeMs?, now?): Promise<number>
requestStop(runId): Promise<boolean>
watchForStopRequest(runId, onStop, intervalMs?): () => void
formatWorkflowJob(record): string
```

State lives in `~/.agav/workflow-jobs/<job-id>.json`, overridable with
`AGAV_WORKFLOW_JOB_DIR`. It is deliberately a **separate namespace** from
`~/.agav/background-processes`: a workflow run already owns rich state in `run.json`, and
folding shell jobs and workflow runs into one list would make `list` ambiguous about what is
actually running. The record exists only to answer *is it alive, what started it, how do I
stop it*.

```bash
agav workflows jobs                # list, with running / orphaned / exit-code state
agav workflows jobs-stop <job-id>  # request a clean stop
agav workflows notifications      # report runs finished while no session was watching
```

### Detachment

`detached: true` plus `unref()`, so closing the terminal does not abort work already in flight.
The child's pid is recorded immediately, which keeps the run stoppable and lets a listing
distinguish a live child from one that died with its parent.

### Stopping, and why it is not a signal

**Windows cannot deliver `SIGTERM` to another process.** `child.kill('SIGTERM')` maps to
`TerminateProcess`, so no Node handler ever runs and the run dies mid-node with its checkpoint
still `running`. A stop request therefore travels through a file the child polls:

```text
jobs-stop <job-id>  ->  writes <run-id>.stop  ->  child polls  ->  aborts cleanly
```

An IPC pipe was tried first and is wrong here: it dies with the spawning process, and the
entire point is that the parent exits. The file is the only channel that outlives it.

`SIGTERM`/`SIGINT` handlers remain for POSIX and local Ctrl+C.

### Stop attribution

A node torn down by a stop reports an error, because the work was interrupted rather than
completed. Recording that as `failed` would misrepresent a deliberate stop as a genuine failure
and make the run look broken rather than resumable, so it is attributed to the stop and
recorded as `cancelled`. The run ends `paused` and resumes cleanly.

### Credentials

The child environment strips `*KEY|*SECRET|*TOKEN|*PASSWORD|*CREDENTIAL|*AUTH`, matching the
background-process runner. That is safe here because provider credentials are encrypted at rest
and decrypted by `loadConfig()` in the child; the CLI does not read them from the environment.

### New CLI flags

```text
agav workflows run <workflow> --input-json '<json>' --run-id <id>
```

`--run-id` lets a detached caller pre-assign the run id, so its job record and the run directory
agree. `--input-json` avoids a temp file the spawning side would have to keep in sync.
## Observability

`computeRunMetrics` reports `tokenBudget` and `tokenBudgetExceeded`, and `formatMetrics`
prints remaining headroom:

```text
Token budget: 620 / 500
Run exceeded its tokenBudget.
```

### Not enforced

`policies.costBudgetUsd` is still a no-op: converting tokens to money needs a per-model
price table that does not exist yet. External (A2A) agents cannot be enforced either,
because their consumption is not observable from here.
## Observability

Added `source/workflows/metrics.ts`, which derives a metrics rollup from a run summary.

### APIs

```ts
computeRunMetrics(summary): WorkflowRunMetrics
nodeDurationMs(node, now?): number
formatDuration(ms): string
formatMetrics(metrics): string

getWorkflowRunMetrics(runId, store?)  // via source/workflows/control.ts
store.readLog(runId, nodeId, limit?)
store.readRunLogs(runId, limit?)
```

### What is measured

| Metric | Source |
| --- | --- |
| Node counts by status | Checkpoint statuses, including `pending` nodes with no checkpoint |
| Duration per node | `startedAt` → `endedAt` (live nodes measured against now) |
| Duration per node type | Aggregated, sorted slowest-first |
| Slowest nodes | Top 5 |
| Token usage | Sum of `inputTokens`, `outputTokens`, cache read/write |
| Attempts | Total attempts, max attempts, retried node list |
| Dry-run / mocked / skipped | Node flags |
| Timed out / cancelled | Node statuses |

### Commands

```bash
agav workflows metrics <run-id>
agav workflows logs <run-id> [node-id]
agav workflows status <run-id>      # now appends the metrics rollup
```

```text
/workflows metrics <run-id>
/workflows logs <run-id> [node-id]
/workflows status <run-id>          # now appends the metrics rollup
```

`runs` output gained per-run progress (`completed/total`) and duration.
`checkpoints` output gained per-node duration, attempt count, token usage, and
dry-run/mock markers.

### Node timing fix

`makeNodeRun` previously stamped `startedAt` and `endedAt` from the same clock
reading, so every completed node reported a `0ms` duration. `executeNode` now
carries the pre-execution `startedAt` from the `running` checkpoint onto the
final result, so durations reflect real elapsed time.

## Dry-run mode

### Commands

```bash
agav workflows dry-run <workflow> [--input inputs.json]
```

```text
/workflows dry-run <workflow>
```

### Runtime API

```ts
runWorkflow(definition, inputs, deps, { dryRun: true })
```

### Behavior

| Node type | Dry-run behavior |
| --- | --- |
| `agent` | Skipped by default unless mocked. |
| `tool` | Runs only for known safe/read-only tools; mutating/unknown tools are skipped. |
| `approval` | Uses synthetic approval and passes. |
| `prompt` / `reduce` | Skipped unless `allowModelCalls` is true. |
| `skill` | Skipped by default unless mocked. |
| `test` | Runs structural assertions; command assertions are skipped unless `allowCommands` is true. |

Skipped nodes are checkpointed as:

```json
{
  "status": "skipped",
  "dryRun": true,
  "output": {
    "dryRun": true,
    "skipped": true,
    "reason": "...",
    "plannedAction": "..."
  }
}
```

## Eval support

### Eval directory layout

```text
.agav/workflows/my-flow.yaml
.agav/workflows/my-flow.evals/
  happy-path.json
  approval-required.json
```

### Commands

```bash
agav workflows test <workflow>
agav workflows test <workflow> --eval happy-path
```

```text
/workflows test <workflow>
```

### APIs

```ts
loadWorkflowEvals(workflowPath)
runWorkflowEval(workflow, fixture, deps)
runWorkflowEvals(workflow, fixtures, deps)
```

### Expectations supported

- final run status;
- node statuses;
- node output contains text;
- node output matches regex.

## Attempt history

Each terminal node checkpoint is stored both as latest state and as immutable attempt history.

```text
~/.agav/workflow-runs/<run-id>/
  nodes/<node-id>.json
  nodes/<node-id>.attempts/
    1.json
    2.json
```

### APIs

```ts
store.saveNodeAttempt(runId, node)
store.listNodeAttempts(runId, nodeId)
store.nextNodeAttempt(runId, nodeId)
```

### Commands

```bash
agav workflows attempts <run-id> <node-id>
```

```text
/workflows attempts <run-id> <node-id>
```

Retries increment attempts instead of overwriting the only historical record.

## Cooperative cancellation and timeouts

### Runtime options

```ts
runWorkflow(definition, inputs, deps, { signal })
resumeWorkflow(runId, deps, { signal })
```

### Current behavior

- If aborted before workflow execution, run is marked `paused`.
- If aborted between scheduling loops, run is marked `paused`.
- If aborted before a node starts, node is marked `cancelled`.
- Test nodes check cancellation between assertions.
- Prompt/reduce nodes pass the signal into `runAgentLoop()`.
- Agent nodes pass signal through `AgentExecutionOptions` for future executor-level support.
- Node timeout creates a `timed_out` checkpoint.

### Remaining cancellation limitation

Cancellation is cooperative. If an underlying tool or external agent ignores cancellation, the runtime can checkpoint timeout/cancel state but cannot forcibly stop that underlying operation yet.

## Retry and idempotency safeguards

Implemented safeguards:

- interrupted `agent` and `tool` nodes require retry approval by default;
- `retrySafe: true` or `retryPolicy.retryRunningAfterCrash: true` allows automatic retry;
- `retryPolicy.retryRunningAfterCrash: false` and `retryPolicy.requireApprovalBeforeRetry: true` force approval;
- `retryPolicy.maxAttempts` is enforced before execution;
- workflow-generated idempotency key defaults to `${run.id}:${node.id}`;
- explicit `idempotencyKey` on the node overrides the default;
- idempotency key is passed to A2A agents in the invocation context.

Remaining retry/idempotency work:

- native agent tools do not yet receive idempotency metadata directly (see Known gaps);
- no per-tool mutability inference beyond tool schema and node type defaults;
- no CLI command yet for `resume --approve-retry` in slash help text beyond supported option handling.

## Tests added

| Test file | Coverage |
| --- | --- |
| `source/__tests__/workflows.parallel.test.ts` | Parallel fan-out, ordering, aggregation, failure, approval, resume, scoping validation, attempts. |
| `source/__tests__/utils.desktop-notify.test.ts` | Notification formatting (title, urgency, error inclusion); **single-shot delivery**: no fallback after a mechanism already showed one, fallback only when nothing was shown, undelivered when every mechanism fails, no throw when the launcher itself breaks; escaping passthrough. Uses an injected launcher, so no banner is popped during a test run. `AGAV_TEST_REAL_NOTIFY=1` runs one real-platform case. | Notification formatting (title, urgency, error inclusion) and real platform delivery: definite result rather than throwing, empty notification, shell metacharacters, embedded quotes and newlines. |
| `source/__tests__/workflows.jobs.test.ts` | Job record round-trip, listing order, live/dead pid detection, orphan detection, finish marking, stop-request write/detect/clear, watcher single-fire and disposal, pruning policy, CLI formatting. |
| `source/__tests__/workflows.notifications.test.ts` | `onComplete` firing once per terminal status, exclusion of `waiting_approval`, broken-hook and broken-sink isolation, once-only delivery, `notifiedAt` stamping, notification log, subscriber lifecycle. |
| `source/__tests__/workflows.condition.test.ts` | Condition evaluation: truthiness, equality, ordering, input references, NaN rejection, and validator rejection of malformed conditions. |
| `source/__tests__/workflows.when.test.ts` | Conditional branching end to end: run/skip, skip recording, no deadlock on a skipped dependency, dependent re-evaluation, input conditions, durability across resume. |
| `source/__tests__/workflows.shutdown.test.ts` | Run controller abort/reason/parent semantics, work tracking and grace-period drain, stop checkpointing, abandonment warning, resume with a fresh signal, refusal to resume a dead signal, fresh budget on resume. |
| `source/__tests__/workflows.run-deadline.test.ts` | Run ceiling enforcement, in-flight node checkpointing, node-vs-run timeout attribution, loop bounding, resumability, unbounded/zero-limit behavior, metrics reporting. |
| `source/__tests__/workflows.budget-display.test.ts` | Per-node budget rendering: reported budget, partial budget, no-budget highlight, measured counts, budget precedence, non-model nodes left blank. |
| `source/__tests__/workflows.budget-reporting.test.ts` | A2A budget parsing, alternative field names, malformed-value handling, reported vs unreported usage, metrics display and no-budget highlighting. |
| `source/__tests__/workflows.agent-usage.test.ts` | Agent/skill usage recording, string-result backward compatibility, metrics folding, usage normalization, A2A metadata parsing. |
| `source/__tests__/workflows.retry-hardening.test.ts` | Retry decision table, attempt budgets, backoff math, automatic retry-until-success, exhaustion, operator reset after exhaustion, timeout retry, dry-run safety. |
| `source/__tests__/workflows.observability.test.ts` | Node status counts, token aggregation, attempt/retried tracking, dry-run/mock flags, per-type and slowest-node timing, duration formatting, log reading, node timing regression. |
| `source/__tests__/workflows.loop.test.ts` | Loop early exit, ordering, per-iteration aggregation, exhaustion, fail-fast, scoped checkpoints, resume, validation. |
| `source/__tests__/workflows.dry-run-evals.test.ts` | Dry-run skipping, safe tool behavior, mocks, eval fixture loading/running. |
| `source/__tests__/workflows.attempts-cancellation.test.ts` | Attempt history, retry attempt increments, timeout checkpoint, pre-abort pause. |
| `source/__tests__/workflows.loader.test.ts` | Workflow YAML/JSON loading/listing. |
| `source/__tests__/workflows.control.test.ts` | Run control, approval decisions, pending nodes, retry invalidation. |
| `source/__tests__/commands.workflows.test.ts` | Slash command checkpoint formatting. |
| `source/__tests__/workflows.runtime.test.ts` | Core runtime execution/resume. |
| `source/__tests__/workflows.schedule-plan.test.ts` | Pure tick planning: cron matching, midnight wrap-around, day-anchored already-fired, catch-up window, skip recording, decision application. |
| `source/__tests__/workflows.schedule-regressions.test.ts` | Bugs found in review: day boundary distinguishing two days at the same time-of-day, daily task due again the next day, malformed cron throwing instead of silently never firing, day stamped alongside the minute. |
| `source/__tests__/workflows.jobs-finish.test.ts` | Child-side finish marker: marks this run id finished, refuses a foreign pid, marks a pid-less launch failure, no double-finish, leaves other runs untouched. |
| `source/__tests__/workflows.schedule-orphan.test.ts` | Tick reconciles orphans before acting: fires a task whose only blocker was a stale record, still skips a genuinely live run, several orphans in one pass. |
| `source/__tests__/config-theme-scheduler.test.ts` | Cron field parsing, malformed-expression rejection, task CRUD, enable/disable. |

## Verification

Clean verification commands:

```bash
pnpm exec tsc --noEmit
```

```bash
pnpm vitest run source/__tests__/workflows.attempts-cancellation.test.ts source/__tests__/workflows.dry-run-evals.test.ts source/__tests__/workflows.runtime.test.ts source/__tests__/workflows.control.test.ts source/__tests__/workflows.loader.test.ts source/__tests__/commands.workflows.test.ts
```

## Workflow scheduling

A scheduled task fires a **workflow run** rather than a raw prompt, so a scheduled
job gets the same checkpoints, retries, budgets, and observability as any other run.

```bash
agav scheduler list                           # tasks and their last outcome
agav scheduler add "0 9 * * 1-5" <workflow>   # schedule a workflow
agav scheduler tick                           # evaluate once, start anything due
agav scheduler remove <id>
agav scheduler enable <id> | disable <id>
```

### Pure tick planning

`planTick` is pure: it takes the tasks, a clock reading, and two predicates, and
returns decisions. No I/O, so every rule below is unit-tested directly.

| Rule | Behavior |
| --- | --- |
| Cron matching | A malformed expression throws at `add` time rather than silently never firing. |
| Day anchoring | A fire is recorded per local day, so a daily task is due again the next day instead of comparing a bare minute-of-day. |
| Midnight wrap | A task last fired at 23:59 is due at 00:00 the next day. |
| Catch-up | A fire missed while nothing was running is recovered inside the catch-up window, or recorded outside it. Never silent. |
| Overlap guard | A task whose previous run is still in flight is skipped unless `skipIfRunning: false`. |

### Overlapping runs

A five-minute cron against a twenty-minute workflow would otherwise start four
concurrent runs against the same external systems. The guard is checked again inside
the fire path, not only during planning, so two ticks in the same minute cannot both
start a run.

### Orphan reconciliation

A job record whose child died without closing it out stays `running` forever, and the
overlap guard trusts that record — which wedges a task into reporting
"previous run still in flight" every tick. The tick reconciles orphaned records
before acting, and re-plans against the corrected state, so a task blocked only by a
stale record fires that tick rather than waiting a full minute.
## Recommended next enhancements

### 1. Standalone scheduler daemon

The tick logic is complete and pure (`planTick`), but it only fires while a
session is open, driven by the TUI's render loop. A daemon would fire schedules
with no session attached. The pieces it needs already exist: detached jobs,
orphan reconciliation, and notification reporting all work headlessly.

### 2. Cost budget enforcement

`policies.costBudgetUsd` is still a no-op: converting tokens to money needs a
per-model price table that does not exist yet. `tokenBudget` **is** enforced;
this is the last declared policy with no effect.

### 3. Idempotency for native agent tools

`source/agent/loop.ts` invokes tools without a context, so a retried native agent
tool call is not deduplicated. Workflow `tool` nodes and A2A agents already
receive an idempotency key.