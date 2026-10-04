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

- native agent tools do not yet receive idempotency metadata directly;
- no exponential backoff policy yet;
- no per-tool mutability inference beyond tool schema and node type defaults;
- no CLI command yet for `resume --approve-retry` in slash help text beyond supported option handling.

## Tests added

| Test file | Coverage |
| --- | --- |
| `source/__tests__/workflows.parallel.test.ts` | Parallel fan-out, ordering, aggregation, failure, approval, resume, scoping validation, attempts. |
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

### 1. Configurable retry/backoff/idempotency enforcement

Next safety-critical enhancement before EziSign or scheduled mutating workflows.
Attempt history and observability now make retry behaviour measurable.

Enforce:

- `retryPolicy.maxAttempts` (already enforced);
- exponential backoff between attempts;
- `retryPolicy.retryRunningAfterCrash`;
- `retryPolicy.requireApprovalBeforeRetry`;
- `retrySafe`;
- idempotency key reaching native agent tools;
- retry metrics surfaced in evals.

### 2. Workflow scheduling

```bash
agav workflows schedule add <workflow> "0 9 * * 1-5"
```

Triggers a versioned workflow run rather than a raw prompt, with run history
visible through the existing observability surface.

## Known gaps

- run-level `tokenBudget` / `costBudgetUsd` policies are declared but not enforced;
- agent-node token usage is not captured (only `prompt`/`reduce` nodes report it);
- metrics are computed on demand, not persisted or aggregated across runs.
