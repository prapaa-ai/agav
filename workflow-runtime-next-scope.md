# Workflow Runtime Next Scope: Dry Run, Evals, Cancellation, Attempt History

## Objective

Implement the next workflow runtime slice after checkpoint/run-control support:

1. dry-run mode;
2. eval fixture support;
3. attempt history;
4. stronger cooperative cancellation;
5. recommended next two enhancements after this slice.

This scope builds on the current runtime branch, which already has workflow loading, CLI/slash command surfaces, checkpoint inspection, approval decisions, pause/cancel state, retry/rewind groundwork, and basic cooperative signal checks.

## Current baseline

Already available:

- `runWorkflow(definition, inputs, deps)`
- `resumeWorkflow(runId, deps, options?)`
- `WorkflowStore.saveRun/loadRun/listRuns/getRunSummary`
- node-level checkpoint files
- append-only node logs
- `/workflows` slash command
- `agav workflows` CLI command
- workflow loader from `.agav/workflows` and `~/.agav/workflows`
- approval-node pause/resume
- basic retry/rewind invalidation
- basic `AbortSignal` handling before execution and between scheduler loops

Implemented in this slice:

- dry-run semantics;
- eval fixture schema/runner;
- attempt history directory and APIs;
- signal propagation to agent execution options;
- node timeout wrapper;
- CLI/slash commands for `dry-run`, `test`, and `attempts`.

Still partial:

- retry/idempotency metadata exists but is not enforced;
- timeout can mark the workflow node as timed out, but underlying non-cooperative tools may keep running until their own execution returns;
- native/A2A agent executors receive `signal` in workflow execution options, but deeper cancellation inside those executors is still future work.

## Feature 1: Dry-run mode

### User-facing behavior

Dry run should validate a workflow and execute only safe/deterministic parts while preventing external side effects.

CLI:

```bash
agav workflows dry-run <workflow> [--input inputs.json]
```

Slash command:

```text
/workflows dry-run <workflow>
```

Programmatic API:

```ts
runWorkflow(definition, inputs, deps, { dryRun: true })
```

or:

```ts
dryRunWorkflow(definition, inputs, deps)
```

### Dry-run node behavior

| Node type | Dry-run behavior |
| --- | --- |
| `approval` | Write `passed` with synthetic approval output, unless policy says approvals must still pause. |
| `test` | Execute safe assertions; command assertions execute only if `allowCommands` is true. |
| `tool` safe/read-only | Execute when known safe. |
| `tool` mutating/unknown | Skip and write synthetic output describing intended call. |
| `agent` | Skip by default; optionally use mock output if provided. |
| `prompt` / `reduce` | Execute if model calls are allowed; otherwise synthesize skipped output. |
| `skill` | Skip by default unless explicitly marked dry-run-safe. |
| `parallel` / `loop` | Use existing implementation when available; for this slice, preserve current reserved behavior unless implemented separately. |

### Dry-run policies

Add runtime options rather than top-level workflow schema first:

```ts
export interface WorkflowRunOptions {
  dryRun?: boolean;
  force?: boolean;
  mocks?: WorkflowMocks;
  allowModelCalls?: boolean;
  allowCommands?: boolean;
}
```

Defaults:

```ts
{
  dryRun: false,
  allowModelCalls: false,
  allowCommands: false
}
```

### Dry-run checkpoint output

Skipped nodes should still produce checkpoints:

```json
{
  "id": "send_reminders",
  "type": "agent",
  "status": "skipped",
  "summary": "Dry run: skipped agent ezisign_agent",
  "input": "Send reminders...",
  "output": {
    "dryRun": true,
    "skipped": true,
    "reason": "agent node skipped in dry-run mode",
    "plannedAction": "..."
  }
}
```

Run status should be `passed` if all non-skipped required checks pass and skipped nodes were intentionally skipped by dry-run policy.

## Feature 2: Eval fixture support

### Eval directory layout

Support eval fixtures beside workflow definitions:

```text
.agav/workflows/my-flow.yaml
.agav/workflows/my-flow.evals/
  happy-path.json
  approval-required.json
  failure-case.json
```

Also support user-level workflows:

```text
~/.agav/workflows/my-flow.yaml
~/.agav/workflows/my-flow.evals/
```

### Eval fixture schema

```ts
export interface WorkflowEvalFixture {
  name: string;
  description?: string;
  inputs?: Record<string, unknown>;
  options?: {
    dryRun?: boolean;
    allowModelCalls?: boolean;
    allowCommands?: boolean;
  };
  mocks?: WorkflowMocks;
  expect: WorkflowEvalExpectations;
}

export interface WorkflowMocks {
  nodes?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  skills?: Record<string, unknown>;
}

export interface WorkflowEvalExpectations {
  status?: WorkflowRunStatus;
  nodes?: Record<string, WorkflowNodeStatus>;
  outputContains?: Record<string, string>;
  outputMatches?: Record<string, string>;
}
```

Example:

```json
{
  "name": "approval-required",
  "inputs": { "daysPending": 3 },
  "options": { "dryRun": true },
  "mocks": {
    "agents": {
      "ezisign_agent": {
        "envelopes": [{ "id": "env_1", "recipient": "a@example.com" }]
      }
    }
  },
  "expect": {
    "status": "passed",
    "nodes": {
      "list_pending": "passed",
      "send_reminders": "skipped"
    }
  }
}
```

### Eval commands

CLI:

```bash
agav workflows test <workflow>
agav workflows test <workflow> --eval approval-required
```

Slash command:

```text
/workflows test <workflow>
```

Programmatic API:

```ts
loadWorkflowEvals(workflowPath): Promise<WorkflowEvalFixture[]>
runWorkflowEval(workflow, fixture, deps): Promise<WorkflowEvalResult>
runWorkflowEvals(workflow, fixtures, deps): Promise<WorkflowEvalSummary>
```

### Eval result schema

```ts
export interface WorkflowEvalResult {
  name: string;
  passed: boolean;
  runId: string;
  failures: string[];
}

export interface WorkflowEvalSummary {
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  results: WorkflowEvalResult[];
}
```

## Feature 3: Attempt history

### Current problem

Current node checkpoint path is overwritten:

```text
nodes/<node-id>.json
```

This loses retry history.

### Desired storage

```text
nodes/<node-id>.json              # latest checkpoint
nodes/<node-id>.attempts/
  1.json
  2.json
  3.json
```

### Store API additions

```ts
saveNodeAttempt(runId: string, node: WorkflowNodeRun): Promise<void>
listNodeAttempts(runId: string, nodeId: string): Promise<WorkflowNodeRun[]>
```

`saveNode(runId, node)` should:

1. write latest checkpoint to `nodes/<node-id>.json`;
2. when node is terminal (`passed`, `failed`, `skipped`, `cancelled`, `timed_out`, `waiting_approval`), also persist attempt snapshot under attempts directory.

### Attempt numbering

Attempt should increment from previous attempts:

- if no attempts exist: `attempt = 1`;
- if retry/rewind resets node: next execution becomes `max(previousAttempts) + 1`;
- if interrupted `running` node reruns: next execution should also increment attempt.

For this slice, implementation can calculate next attempt by reading the existing latest checkpoint and attempts for that node before writing the new `running` checkpoint.

## Feature 4: Cooperative cancellation

### Current state

Current runtime accepts `signal?: AbortSignal` and checks:

- before execution;
- between scheduler loops;
- prompt nodes pass signal to `runAgentLoop()`.

### Required improvements

Add signal and timeout handling in more places:

| Area | Required behavior |
| --- | --- |
| Before each node batch | If aborted, mark run `paused`. |
| Before each node execution | If aborted, skip execution and mark node `cancelled` or leave pending. |
| Prompt/reduce nodes | Already pass signal; keep this. |
| Agent nodes | Add `signal?: AbortSignal` to `AgentExecutionOptions`; pass from runtime. Native agent executor can use later. |
| Tool/test nodes | Check signal before direct tool execution and between test assertions. |
| CLI cancellation | Initial implementation can rely on process signal/AbortController later; API should be ready. |
| Node timeout | Wrap node execution in timeout signal where `timeoutSeconds` or `maxNodeRuntimeSeconds` exists. |

### Node timeout behavior

If timeout fires:

```json
{
  "status": "timed_out",
  "error": "Node timed out after 600 seconds"
}
```

Run status becomes `timed_out` if `stopOnFailure` is true.

### Runtime option surface

```ts
export interface WorkflowRunOptions {
  dryRun?: boolean;
  force?: boolean;
  mocks?: WorkflowMocks;
  allowModelCalls?: boolean;
  allowCommands?: boolean;
  signal?: AbortSignal;
}
```

Keep `deps.signal` temporarily for compatibility, but prefer `options.signal` for new call sites.

## Interfaces to add/update

### `types.ts`

Add:

```ts
WorkflowRunOptions
WorkflowMocks
WorkflowEvalFixture
WorkflowEvalExpectations
WorkflowEvalResult
WorkflowEvalSummary
```

Update:

```ts
AgentExecutionOptions.signal?: AbortSignal
WorkflowNodeRun.dryRun?: boolean
WorkflowNodeRun.mocked?: boolean
```

### `runtime.ts`

Update APIs:

```ts
runWorkflow(definition, inputs, deps, options?)
resumeWorkflow(runId, deps, options?)
```

Add behavior:

- dry-run routing;
- mock lookup;
- timeout wrapper;
- signal checks;
- attempt number allocation.

### `store.ts`

Add:

```ts
saveNodeAttempt()
listNodeAttempts()
nextNodeAttempt()
```

Update `getRunSummary()` later to optionally include attempt counts.

### `evals.ts`

New file:

```text
source/workflows/evals.ts
```

Responsibilities:

- find eval directory for workflow path;
- load JSON fixtures;
- run eval fixtures;
- compare expectations;
- return result summaries.

### CLI/slash updates

Add commands:

```bash
agav workflows dry-run <workflow> [--input inputs.json]
agav workflows test <workflow> [--eval name]
agav workflows attempts <run-id> <node-id>
```

Slash:

```text
/workflows dry-run <workflow>
/workflows test <workflow>
/workflows attempts <run-id> <node-id>
```

## Acceptance criteria for this implementation slice

1. Dry-run mode can run a workflow and checkpoint skipped side-effect nodes.
2. Dry-run does not execute agent nodes by default unless mocked.
3. Eval fixtures can load from `<workflow>.evals/*.json`.
4. Eval runner can assert run status and node statuses.
5. Node terminal checkpoints are saved into attempt history.
6. Retried nodes increment attempt numbers.
7. Prompt nodes continue to receive cancellation signals.
8. Tool/test nodes check cancellation before execution.
9. Timed-out nodes become `timed_out`.
10. CLI/slash commands expose dry-run, test, and attempts.

## Recommended next two enhancements after this slice

1. **Observability/metrics dashboard**
   - Add richer `/ops` or `/workflows status` with durations, token usage, attempt counts, dry-run/mocked flags, and logs.
   - This should come next because dry-runs/evals/attempts create operational data that needs to be visible.

2. **Configurable retry/backoff/idempotency enforcement**
   - Enforce `retryPolicy`, `retrySafe`, and `idempotencyKey` for mutating tool/agent nodes.
   - This should follow because attempt history and evals make retry behavior measurable, and EziSign-style integrations require safe retries before real-world scheduling.
