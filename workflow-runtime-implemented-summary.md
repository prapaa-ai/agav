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

## Verification

Clean verification commands:

```bash
pnpm exec tsc --noEmit
```

```bash
pnpm vitest run source/__tests__/workflows.attempts-cancellation.test.ts source/__tests__/workflows.dry-run-evals.test.ts source/__tests__/workflows.runtime.test.ts source/__tests__/workflows.control.test.ts source/__tests__/workflows.loader.test.ts source/__tests__/commands.workflows.test.ts
```

## Recommended next two enhancements

### 1. Workflow scheduling

```bash
agav workflows schedule add <workflow> "0 9 * * 1-5"
```

Triggers a versioned workflow run rather than a raw prompt, with run history
visible through the existing observability surface. Safe to build now that
retry and crash recovery are hardened.

### 2. Token and cost budget enforcement

`WorkflowPolicies.tokenBudget` and `costBudgetUsd` are declared but never
checked. Enforce them against the usage metrics the observability layer
already computes, so a runaway agent node stops the run instead of silently
overspending.

## Known gaps,,- `tokenBudget` / `costBudgetUsd` policies are declared but still not enforced. All,  in-process model-calling node types report usage, and runs are bounded by,  `maxRuntimeSeconds`, so both the accounting and a wall-clock ceiling are in place.,  External (A2A) agents are reported but cannot be enforced, because their consumption,  is not observable from here;,- cost estimation requires a per-model price table; only raw token counts are available,,  so `costBudgetUsd` cannot be enforced without one;,- a tool that ignores its `AbortSignal` still runs to completion in the background. The,  grace period bounds how long the run waits and the run exits cleanly, but the process,  does not kill the work. Background-process execution should terminate child processes,  rather than abandoning their promises;,- native agent tools do not receive an idempotency key. Workflow `tool` nodes and A2A,  agents do, but `source/agent/loop.ts` invokes tools without a context, so a retried,  native agent tool call is not deduplicated;,- metrics are computed on demand, not persisted or aggregated across runs;,- no scheduling. `agav workflows schedule add` is not implemented;