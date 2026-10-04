# Workflow Runtime Review — Checkpoint Architecture

## Step 1 — Current workflow and checkpoint architecture

This review covers the current implementation in `source/workflows/` as of the first workflow runtime slice.

### Files reviewed

| File | Role |
| --- | --- |
| `source/workflows/types.ts` | Defines workflow definitions, node definitions, policies, run state, node checkpoints, approval decisions, and validation result types. |
| `source/workflows/store.ts` | Persists workflow runs and node checkpoints to disk with atomic JSON writes. |
| `source/workflows/runtime.ts` | Creates runs, executes workflow DAG nodes, writes checkpoints, handles approval pause, and resumes from stored runs. |
| `source/workflows/validator.ts` | Validates basic workflow structure, references, node IDs, dependencies, and cycles. |
| `source/workflows/interpolate.ts` | Resolves `${inputs.*}` and `${nodes.*}` expressions from run inputs and node checkpoint outputs. |
| `source/workflows/hash.ts` | Creates stable SHA-256 hashes for workflow and node definitions. |
| `source/__tests__/workflows.runtime.test.ts` | Tests validation, DAG execution, checkpointing, approval pause/resume, interrupted-node rerun, and prompt usage checkpointing. |

### Current checkpoint storage layout

The runtime stores checkpoints through `WorkflowStore`. Default root:

```text
~/.agav/workflow-runs/
```

A run is stored as:

```text
~/.agav/workflow-runs/<run-id>/
  run.json
  nodes/
    <node-id>.json
  logs/
    <node-id>.log
```

The current `WorkflowStore` also supports test/runtime injection of a custom `rootDir`.

### Run checkpoint: `run.json`

`runWorkflow()` creates a `WorkflowRun` before executing any node:

```ts
{
  id,
  workflowName,
  workflowVersion,
  workflowHash,
  status: "pending",
  createdAt,
  updatedAt,
  inputs,
  policies,
  definition,
  currentNodeIds: [],
  completedNodeIds: [],
  failedNodeIds: [],
  waitingApprovalNodeIds: []
}
```

Then `executeWorkflowRun()` updates it to `running` and persists again.

During execution, before each batch of ready nodes, the runtime updates:

- `currentNodeIds`
- `updatedAt`

At terminal states, it writes:

- `status`
- `completedNodeIds`
- `failedNodeIds`
- `waitingApprovalNodeIds`
- `currentNodeIds: []`
- optional `error`

Current run statuses supported in types:

```text
pending | running | waiting_approval | passed | failed | cancelled | timed_out
```

Current implementation actively sets:

```text
pending -> running -> waiting_approval | passed | failed
```

`cancelled` and `timed_out` are defined but not implemented yet.

### Node checkpoint: `nodes/<node-id>.json`

Every node execution writes at least two checkpoint states:

1. before execution:

```ts
status: "running"
```

2. after completion:

```ts
status: "passed" | "failed" | "waiting_approval"
```

A node checkpoint contains:

```ts
{
  id,
  type,
  status,
  attempt,
  nodeHash,
  startedAt,
  endedAt,
  input,
  output,
  summary,
  usage,
  error,
  approval,
  artifacts,
  skippedReason
}
```

Key details:

- `nodeHash` is `hashValue(node)`.
- `startedAt` is set for all node runs.
- `endedAt` is omitted for `running` and `waiting_approval`.
- `input` stores the resolved/interpolated node input.
- `output` stores normalized output when available.
- `summary` stores a short human-readable output preview.
- `usage` is currently populated for `prompt` / `reduce` nodes.
- `approval` is populated when an approval decision is supplied.

### Atomic checkpoint writes

`WorkflowStore.saveRun()` and `WorkflowStore.saveNode()` use `writeJsonAtomic()`:

```ts
write tmp file -> rename tmp to target path
```

This protects `run.json` and node checkpoint files from partial/corrupt writes if AGAV crashes mid-write.

Current implementation:

```ts
const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
await writeFile(tmp, JSON.stringify(value, null, 2));
await rename(tmp, path);
```

### Trace/log checkpointing

For each node, `runtime.ts` appends JSON lines to:

```text
logs/<node-id>.log
```

Current events:

```json
{"type":"node_started","nodeId":"...","nodeType":"...","ts":"..."}
{"type":"node_completed","nodeId":"...","status":"...","ts":"..."}
```

Important limitation: `appendLog()` currently reads the whole existing log file, appends a line in memory, then writes it back. That is simple but not ideal for high-volume logs or concurrent appends. Run/node checkpoint JSON files are atomic; log appends are not currently append-only atomic writes.

### Supported node executors in current slice

| Node type | Implemented? | Checkpoint behavior |
| --- | --- | --- |
| `agent` | Yes | Stores resolved task as input, agent output as output/summary, validates optional output schema. |
| `tool` | Yes | Stores resolved tool input, normalized tool result output, failed status when tool returns `isError`. |
| `test` | Yes | Stores assertions as input, `{ passed: true }` or failure list as output. Command assertions call `run_command` through `ToolRegistry`. |
| `approval` | Yes | Without `deps.confirm`, stores `waiting_approval`. With confirm, stores approval result and passes/fails. |
| `prompt` | Yes | Runs isolated `ConversationState`, stores prompt input, response output, token usage. |
| `reduce` | Yes, same as `prompt` | Same as prompt. |
| `skill` | Partial | Works only if caller injects `deps.executeSkill`; otherwise fails. |
| `parallel` | Reserved, not implemented | Currently fails with explicit error. |
| `loop` | Reserved, not implemented | Currently fails with explicit error. |

### Current execution model

The runtime flattens all workflow nodes using `flattenNodes()` and repeatedly:

1. loads all node checkpoints from disk;
2. identifies ready nodes whose dependencies have passed;
3. runs up to `maxConcurrency` ready nodes with `Promise.all()`;
4. writes node checkpoints before/after each execution;
5. stops if a node waits for approval;
6. stops on failure if `stopOnFailure` is true;
7. otherwise continues until no nodes are ready.

### Dependency readiness rule

A node is ready when:

- it has no existing passed checkpoint for the same node hash;
- it is not already completed/failed/skipped in the current process loop;
- all `dependsOn` node checkpoints have `status: "passed"`;
- dependency checkpoint hashes still match the current dependency definitions.

This means checkpointing is node-level and dependency-aware.

### Current strengths

- Checkpoints exist before and after every implemented node execution.
- Run and node checkpoint JSON writes are atomic.
- Node output is persisted and available for downstream interpolation.
- Approval pause is represented explicitly as `waiting_approval`.
- `resumeWorkflow(runId)` loads the persisted run and continues execution.
- Completed nodes with unchanged node definitions are skipped on resume.
- Nodes left in `running` status are eligible to rerun on resume.
- Per-node static `model`, `effort`, `maxTokens`, and `sandbox` fields are represented and partly applied.
- Tool/test command execution goes through the existing tool registry, so `run_command` uses the existing sandbox implementation.

### Current limitations visible from architecture

- There is no public CLI/slash command yet to list runs, inspect checkpoints, stop a run, or resume by ID.
- There is no explicit user-initiated pause/stop checkpoint operation yet.
- `cancelled` status exists in types but is not implemented.
- `timed_out` status exists in types but max runtime/node timeout enforcement is not implemented.
- Approval resume exists programmatically via `deps.confirm`, but there is no UI command yet to approve/deny a waiting node.
- `parallel` node and `loop` node are defined but not implemented.
- There is no dry-run or eval harness yet.
- There is no checkpoint listing API; tests inspect checkpoints directly through `store.loadNode()`.
- `appendLog()` is not atomic append and reads the whole log file each time.
- Resume currently uses the persisted workflow definition embedded in `run.json`; it does not yet accept an updated workflow definition and invalidate changed downstream nodes beyond checking already stored node hashes in readiness.

## Step 2 — Resume-from-checkpoint behavior

### Resume entrypoint

The only current resume entrypoint is programmatic:

```ts
resumeWorkflow(runId, deps)
```

It requires:

| Required input | Source |
| --- | --- |
| `runId` | Existing persisted run directory under the `WorkflowStore` root. |
| `deps.provider` | Current LLM provider for prompt/reduce nodes. |
| `deps.config` | Current AGAV config for model/effort/max token/permission defaults. |
| `deps.toolRegistry` | Current tool registry for tool/test command nodes. |
| `deps.loadAgent` | Agent lookup function for agent nodes. |
| `deps.executeAgent` | Common native/A2A agent execution function. |
| `deps.store` | Optional store override; if omitted, defaults to `~/.agav/workflow-runs/`. |
| `deps.confirm` | Optional approval callback. Required only to continue a `waiting_approval` node. |
| `deps.executeSkill` | Optional skill executor. Required only if resuming into a `skill` node. |

Current implementation does **not** require the original workflow file path or original input payload during resume because `run.json` stores both:

- `definition`
- resolved `inputs`
- `policies`
- `workflowHash`

### Resume loading sequence

The resume path is:

```text
resumeWorkflow(runId, deps)
  -> store.loadRun(runId)
  -> executeWorkflowRun(run, deps, store)
```

If `run.json` is missing or unreadable, `resumeWorkflow()` throws:

```text
Workflow run <runId> not found
```

If the run exists, the runtime does not create a new run ID. It continues writing into the same run directory:

```text
~/.agav/workflow-runs/<same-run-id>/
```

### Resume validation

Before continuing, `executeWorkflowRun()` validates the embedded workflow definition from `run.json`:

```ts
validateWorkflow(run.definition, {
  hasTool: ...current toolRegistry...,
  hasAgent: ...current loadAgent...
})
```

This means a previously valid run can fail on resume if the current runtime environment no longer has a referenced tool or agent installed/enabled.

Current validation does not check skills because `validateWorkflow()` supports a skill check, but `runtime.ts` does not currently pass `hasSkill`.

### How prior state is loaded

On each runtime loop, the runtime reloads node checkpoints from disk:

```ts
const checkpoints = await store.loadNodes(run.id);
```

`loadNodes()` reads every `nodes/*.json` file and returns:

```ts
Record<string, WorkflowNodeRun>
```

Downstream interpolation also uses these persisted checkpoints:

```ts
${nodes.<id>.output...}
```

So resume state is not held in memory from the previous process. It is reconstructed from:

```text
run.json + nodes/*.json
```

### How the next node is chosen

The runtime flattens the embedded workflow definition:

```ts
const allNodes = flattenNodes(run.definition.nodes);
```

Then each loop computes ready nodes:

```ts
const ready = allNodes.filter((node) => isReady(...));
```

A node is skipped/not ready on resume when:

| Existing checkpoint state | Current behavior |
| --- | --- |
| `passed` with same `nodeHash` | Skipped. This is the main checkpoint resume behavior. |
| `waiting_approval` and no `deps.confirm` | Not ready; run remains `waiting_approval`. |
| `waiting_approval` and `deps.confirm` exists | Ready again if the node is an `approval` node. It is re-executed to collect the approval decision. |
| `failed` with same `nodeHash` | Not ready; run remains failed unless manually modified. |
| `running` | Ready. It is retried because it may have been interrupted mid-execution. |
| Missing checkpoint | Ready if dependencies passed. |
| Changed node hash | Ready, because the previous checkpoint is not considered valid for the current node definition. |

Dependency readiness requires every dependency to have a `passed` checkpoint:

```ts
if (depCheckpoint?.status !== "passed") return false;
```

It also requires dependency hashes to match current dependency definitions:

```ts
if (dep && depCheckpoint.nodeHash !== hashValue(dep)) return false;
```

### Example: approval checkpoint resume

Test coverage: `source/__tests__/workflows.runtime.test.ts`, test name:

```text
resumes by skipping passed checkpoints
```

Workflow:

```text
first(tool) -> approve(approval) -> final(agent)
```

Initial run has no `deps.confirm` callback.

Observed initial behavior:

1. `first` executes and stores `nodes/first.json` with `status: "passed"`.
2. `approve` executes and stores `nodes/approve.json` with `status: "waiting_approval"`.
3. Runtime returns run status `waiting_approval`.
4. `final` is not executed.

Resume call supplies `deps.confirm` returning approved.

Observed resume behavior:

1. Runtime loads the same `run.json`.
2. Runtime loads existing checkpoints.
3. `first` is skipped because it has `status: "passed"` and matching `nodeHash`.
4. `approve` is ready because it is `waiting_approval` and `deps.confirm` exists.
5. `approve` re-executes, records the approval, and becomes `passed`.
6. `final` becomes ready and executes.
7. Run finishes with `status: "passed"`.

This verifies that the runtime can continue from a persisted approval checkpoint without rerunning completed upstream work.

### Example: interrupted running node resume

Test coverage: `source/__tests__/workflows.runtime.test.ts`, test name:

```text
reruns interrupted running nodes on resume
```

The test simulates an interrupted process by manually editing a failed node checkpoint back to:

```ts
status: "running"
endedAt: undefined
error: undefined
```

On resume:

1. Runtime loads the node checkpoint.
2. `isReady()` does not skip `running` nodes.
3. The node executes again.
4. New output overwrites the running checkpoint with `status: "passed"`.
5. Run completes with `status: "passed"`.

This verifies the intended crash-recovery behavior for nodes that were mid-flight when AGAV stopped.

### Does resume continue from the correct node?

For simple DAGs with `tool`, `agent`, `test`, `approval`, `prompt`, `reduce`, and `skill` nodes, yes, with important caveats.

It continues from the correct next node when:

- upstream completed nodes have `status: "passed"`;
- upstream node hashes still match current embedded definitions;
- downstream nodes are missing, `running`, or `waiting_approval` with approval callback;
- required agents/tools still exist in the current runtime.

It does not yet support:

- selecting an arbitrary checkpoint to resume from;
- manually rewinding a specific node;
- invalidating a node and all downstream nodes through a public API;
- resuming with an updated workflow file;
- resolving changed workflow definitions outside `run.json`;
- resuming `failed` nodes without manual checkpoint modification;
- resuming `parallel` or `loop` semantics because those node types are not implemented yet.

### Hash behavior during resume

The current code stores:

- `workflowHash` on the run;
- `nodeHash` on every node checkpoint.

Current skip rule:

```ts
if (existing?.status === "passed" && existing.nodeHash === hashValue(node)) return false;
```

This prevents stale successful output from being reused if the node definition embedded in the run has changed.

However, because `resumeWorkflow()` currently reloads the workflow definition from `run.json`, not from the source workflow file, normal resume will use the same embedded node definitions. The changed-node hash path only matters if something has updated the embedded `run.definition` before resume or if future APIs allow relaunching/resuming with an updated definition.

### Input behavior during resume

Inputs are resolved once at `runWorkflow()` time and stored in `run.json`.

On resume:

- the caller does not provide inputs;
- defaults are not recomputed;
- external workflow file changes do not affect inputs;
- downstream interpolation uses stored `run.inputs`.

This is good for deterministic replay, but future APIs may need explicit `resume --with-input` or `rerun` semantics if users want to modify inputs.

### Current resume visibility

Resume is currently tested and available only as code. There is no user-facing command yet for:

```bash
agav workflows resume <run-id>
agav workflows status <run-id>
agav workflows checkpoints <run-id>
agav workflows logs <run-id>
```

The checkpoint state is visible only by reading files directly or through tests using:

```ts
store.loadRun(runId)
store.loadNode(runId, nodeId)
store.loadNodes(runId)
```

### Risks in current resume implementation

| Risk | Why it matters |
| --- | --- |
| Failed nodes are sticky | A failed node with matching hash is never retried unless checkpoint is manually changed or future API supports retry. |
| Running nodes always retry | Good for crash recovery, but unsafe for non-idempotent side effects if the operation actually completed externally before the checkpoint wrote success. |
| No idempotency key model | Service-agent operations such as EziSign `send_envelope` need idempotency keys to make retry safe. |
| No explicit pause/cancel state | User cannot intentionally stop a run and later resume through a supported API. |
| No timeout enforcement | Long nodes can hang unless underlying executor/tool has its own timeout. |
| No checkpoint listing command | Users cannot easily see where a run stopped. |
| No updated-definition resume | Cannot naturally apply workflow edits and resume from the earliest changed node. |
| Approval resume re-executes approval node | This is fine for current approval nodes, but approval state should eventually be updated through a dedicated approval decision API rather than re-running the node. |

### Step 2 conclusion

The current implementation has a real node-level checkpoint/resume foundation: it persists run/node state to disk, skips passed nodes on resume, reruns interrupted `running` nodes, and can continue after an approval checkpoint when a confirmation callback is supplied. It does **not** yet have user-facing checkpoint inspection, intentional stop/pause, retry/rewind, idempotency safeguards for side-effecting nodes, or CLI/slash commands for resume.

## Step 3 — Explicit HITL interruption support

### What “explicit HITL interruption” means for this review

The desired behavior is broader than approval nodes. It includes the ability for a human/operator to:

1. intentionally stop or pause a workflow midway;
2. persist a clean checkpoint at the stop point;
3. inspect all run and node checkpoints;
4. understand which nodes passed, failed, are running, or are waiting;
5. resume the workflow from where it left off;
6. approve or deny a waiting HITL checkpoint;
7. optionally retry/rewind a selected node and downstream nodes.

### Current HITL support in implementation

The runtime currently supports one kind of explicit HITL checkpoint: the `approval` node.

Implementation path:

```ts
case "approval":
  result = await executeApprovalNode(run, node, deps, store);
```

If the workflow reaches an approval node and no `deps.confirm` callback is available, the node checkpoint is written as:

```ts
status: "waiting_approval"
input: <interpolated prompt>
summary: <interpolated prompt>
endedAt: undefined
```

Then the run is finalized as:

```ts
status: "waiting_approval"
waitingApprovalNodeIds: [<approval-node-id>]
currentNodeIds: []
```

This is the only currently implemented durable pause state.

### Current approval resume behavior

If `resumeWorkflow(runId, deps)` is called later with `deps.confirm`, then `isReady()` allows the waiting approval node to run again:

```ts
if (existing?.status === "waiting_approval") {
  return canResumeApproval && node.type === "approval";
}
```

`executeApprovalNode()` then calls:

```ts
deps.confirm({ run, node, prompt })
```

If approved, the approval node becomes `passed`; if denied, it becomes `failed`.

This works programmatically and is covered by the existing test:

```text
resumes by skipping passed checkpoints
```

### What current HITL approval already does well

| Capability | Current status |
| --- | --- |
| Durable approval checkpoint | Supported through `waiting_approval` node checkpoint. |
| Run-level paused status | Supported through run `status: "waiting_approval"`. |
| Resume after approval | Supported programmatically via `resumeWorkflow(..., { confirm })`. |
| Skip completed upstream nodes | Supported. Passed upstream checkpoints are not rerun. |
| Prevent downstream execution before approval | Supported through dependency readiness; downstream node waits until approval node passes. |
| Store approval result | Supported when callback returns a decision; stored in `node.approval` and `node.output`. |

### What is not implemented yet

#### 1. No user-facing pause/stop command

There is no current API or command equivalent to:

```bash
agav workflows pause <run-id>
agav workflows stop <run-id>
agav workflows cancel <run-id>
```

The types define `cancelled`, but `runtime.ts` never sets it. The runtime also does not accept an `AbortSignal`, cancellation token, or externally mutable run-control flag.

Current implication:

- A user cannot intentionally stop a running workflow through the workflow runtime.
- If AGAV exits or crashes, the last running node checkpoint remains `running` and will be retried on resume.
- That is crash recovery, not explicit HITL stop/pause.

#### 2. No clean mid-node interruption checkpoint

A node checkpoint is written before node execution as `running`, and after execution as terminal. There is no cooperative mid-node pause protocol.

For long-running nodes:

- `agent` node: no workflow-level signal is passed into `executeAgent`.
- `prompt` node: `runAgentLoop()` supports `signal`, but workflow runtime does not expose/pass one.
- `tool` node: direct `ToolRegistry.execute()` has no workflow cancellation wrapper.
- `test` command assertion: relies on `run_command` timeout/sandbox behavior, but no workflow-level cancellation.

Current implication:

- A human cannot say “stop after the current tool call” or “pause after this node.”
- An abrupt process stop leaves `currentNodeIds` in `run.json` until final status is later recomputed on resume.
- A resumed `running` node reruns from the start.

#### 3. No checkpoint listing API

`WorkflowStore` supports:

```ts
loadRun(runId)
loadNode(runId, nodeId)
loadNodes(runId)
```

But there is no higher-level API or CLI/TUI command to display:

```bash
agav workflows checkpoints <run-id>
agav workflows status <run-id>
agav workflows logs <run-id> [node-id]
```

Current implication:

- Tests can inspect checkpoints directly.
- Users cannot easily see all checkpoint files, node statuses, node inputs/outputs, summaries, or pending approvals.

#### 4. No paused-runs listing

`WorkflowStore` has no `listRuns()` method. It can load a known `runId`, but cannot enumerate:

- all runs;
- running runs;
- waiting approval runs;
- failed runs;
- resumable runs.

Current implication:

- A user needs to already know the `runId`.
- There is no operational dashboard foundation yet for workflow runs.

#### 5. No explicit approve/deny API

Approving a waiting workflow currently means re-calling `resumeWorkflow()` with a `confirm` callback. There is no explicit API like:

```ts
approveWorkflowNode(runId, nodeId, decision)
```

or CLI:

```bash
agav workflows approve <run-id> <node-id>
agav workflows deny <run-id> <node-id>
```

Current implication:

- Approval is coupled to runtime execution.
- There is no way to record a decision first and resume later.
- Approval nodes are re-executed to collect decisions, instead of updating the existing waiting checkpoint.

#### 6. No manual retry/rewind API

There is no API to change checkpoint state intentionally, such as:

```bash
agav workflows retry <run-id> <node-id>
agav workflows rewind <run-id> <node-id>
```

Current behavior:

- `passed` nodes are skipped if hashes match.
- `failed` nodes are sticky if hashes match.
- `running` nodes are retried.

Current implication:

- To retry a failed node, someone must manually edit/delete checkpoint JSON.
- To rerun a passed node, someone must manually edit/delete checkpoint JSON or change the embedded run definition.
- There is no supported “start from checkpoint X” user flow yet.

#### 7. No planned pause point

There is no workflow policy or node field like:

```yaml
pauseAfter: true
pauseBefore: true
```

or command behavior like:

```bash
agav workflows run my-flow --until node-id
agav workflows run my-flow --pause-after node-id
```

Current implication:

- HITL pause is possible only by adding an `approval` node to the workflow definition ahead of time.
- Operators cannot inject a pause into a running workflow without stopping the whole process externally.

### Current scenarios and outcomes

| Scenario | Current behavior | Is it explicit HITL? |
| --- | --- | --- |
| Workflow reaches approval node with no `confirm` callback | Node and run become `waiting_approval`; downstream nodes do not run. | Yes, partially. |
| Workflow reaches approval node with `confirm` callback | Callback decides immediately; node passes/fails. | Yes, but callback-driven. |
| User wants to stop workflow midway from UI/CLI | Not supported; no command/API/signal. | No. |
| User kills AGAV process midway | Current node may remain `running`; resume retries it. | Crash recovery, not HITL. |
| User wants to see all checkpoints | Only possible by reading JSON files or using store APIs in code. | No user-facing support. |
| User wants to resume from checkpoint | Programmatic `resumeWorkflow(runId)` only; resumes based on checkpoint states. | Partial. |
| User wants to retry failed node | Not supported except manual checkpoint editing. | No. |
| User wants to approve waiting node then resume later | Not supported as separate decision-recording step. | No. |

### Important safety concern: side effects and retries

The current “rerun `running` nodes on resume” behavior is correct for crash recovery, but unsafe for non-idempotent side effects unless each mutating node has idempotency protection.

Example risk:

```text
send_reminders node starts
EziSign API sends reminders successfully
AGAV crashes before writing passed checkpoint
resumeWorkflow() sees node status running
send_reminders runs again
recipients get duplicate reminders
```

For HITL and checkpointing to be production-safe with EziSign or other external systems, mutating `agent`/`tool` nodes need one or more of:

- idempotency keys per run/node/attempt;
- side-effect preflight checks;
- “confirm before retrying running mutating node” policy;
- explicit `retrySafe: true | false` node metadata;
- post-crash reconciliation before retry.

### Current implementation judgment

The current implementation has **approval-node HITL**, but not **operator-driven workflow interruption**.

More precisely:

| Capability | Current status |
| --- | --- |
| HITL approval checkpoint | Partial/working. |
| Stop workflow midway intentionally | Missing. |
| Pause workflow after current node | Missing. |
| Pause workflow before selected node | Missing. |
| List all checkpoints | Missing. |
| List paused/waiting runs | Missing. |
| Resume from known run ID | Programmatic only. |
| Resume from selected checkpoint | Missing. |
| Approve/deny waiting checkpoint directly | Missing. |
| Retry/rewind selected node | Missing. |
| Safe retry for external side effects | Missing. |

### Step 3 conclusion

The current runtime can pause durably at an explicit `approval` node and can resume programmatically after approval. It cannot yet support the operator workflow you described: “stop workflow midway, see all checkpoints, and start where it left.” To support that, the next implementation needs run-control APIs, checkpoint listing, explicit pause/cancel statuses, CLI/slash commands, approval decision APIs, and idempotency/retry policy for mutating external-agent nodes.

## Step 4 — Gaps and next implementation options

### Executive summary

The current workflow runtime has a solid **checkpoint substrate** but not yet a complete **operator control plane**.

What works now:

- run records are persisted;
- node checkpoints are persisted atomically;
- completed nodes are skipped on resume;
- interrupted `running` nodes rerun on resume;
- approval nodes can pause a run as `waiting_approval`;
- programmatic resume can continue after approval;
- simple DAG execution across `tool`, `agent`, `test`, `approval`, `prompt`, `reduce`, and injected `skill` nodes works.

What is missing for the requested workflow:

```text
stop workflow midway
→ inspect all checkpoints
→ decide/approve/retry if needed
→ resume from where it left
```

The missing layer is not the checkpoint files themselves; it is the user/API surface and run-control semantics around them.

### Gap matrix

| Gap | Current behavior | Needed behavior | Priority |
| --- | --- | --- | --- |
| Run listing | Only load known `runId`. | List all runs with status, workflow, updated time, current/waiting nodes. | P0 |
| Checkpoint listing | Only `store.loadNodes()` programmatically. | Display all node checkpoints, status, summaries, errors, outputs, approval prompts. | P0 |
| Resume command | Only `resumeWorkflow(runId, deps)` in code. | CLI/slash command to resume a known run. | P0 |
| Pause/stop command | Not supported. | Mark run as `cancelled` or `paused`, stop future scheduling, preserve completed checkpoints. | P0 |
| Cooperative cancellation | No workflow-level `AbortSignal`. | Runtime should accept signal/control flag and stop between nodes, ideally abort prompt/agent nodes too. | P1 |
| Approval decision API | Approval collected only by rerunning approval node with callback. | `approveWorkflowNode()` / `denyWorkflowNode()` updates waiting checkpoint then resume can proceed. | P0 |
| Failed-node retry | Failed nodes are sticky. | Retry selected failed node and downstream dependents without manual JSON edits. | P1 |
| Rewind from checkpoint | Not supported. | Invalidate selected node and downstream nodes. | P1 |
| Safe external side-effect retry | Running nodes retry blindly. | Retry policy/idempotency key/reconciliation for mutating tool/agent nodes. | P0 for EziSign/business agents |
| Timeout state | `timed_out` type exists but not used. | Enforce run/node timeouts and checkpoint `timed_out`. | P1 |
| Log append safety | Logs read/overwrite whole file. | Append-only log writes. | P2 |
| Parallel/loop nodes | Defined but fail explicitly. | Implement once checkpoint/controls are reliable. | P2 |

### Minimal next implementation option — recommended

The next PR should focus on **workflow checkpoint visibility and run control**, not new node types.

Recommended scope:

1. `WorkflowStore.listRuns()`
2. `WorkflowStore.loadRunSummary(runId)` or helper to combine run + nodes
3. `pauseWorkflow(runId)` / `cancelWorkflow(runId)`
4. `approveWorkflowNode(runId, nodeId, decision)`
5. `resumeWorkflow(runId, deps)` behavior updated to respect approved waiting checkpoints
6. CLI/slash command skeleton for `status`, `checkpoints`, `resume`, `approve`, `deny`, `cancel`
7. Tests for listing, cancelling, approving, and resuming

This directly supports the operator scenario before adding more complex workflow execution.

### Recommended user flow after next PR

Target CLI flow:

```bash
agav workflows run ezisign-followup --input inputs.json
```

If the run pauses:

```text
Workflow run_abc123 waiting for approval at node approve_reminders.
```

User inspects state:

```bash
agav workflows status run_abc123
agav workflows checkpoints run_abc123
agav workflows logs run_abc123 approve_reminders
```

User approves:

```bash
agav workflows approve run_abc123 approve_reminders --note "OK to send reminders"
```

User resumes:

```bash
agav workflows resume run_abc123
```

Expected behavior:

- already passed nodes are skipped;
- approved node is treated as passed;
- downstream nodes continue;
- run history remains in the same run directory.

### Recommended APIs

#### `listRuns()`

Add to `WorkflowStore`:

```ts
async listRuns(): Promise<WorkflowRun[]>
```

Behavior:

- read subdirectories under `workflow-runs`;
- load each `run.json`;
- ignore unreadable/corrupt entries;
- sort by `updatedAt` descending.

#### `getRunSummary()`

Add helper:

```ts
async getWorkflowRunSummary(runId: string, store?: WorkflowStore): Promise<{
  run: WorkflowRun;
  nodes: WorkflowNodeRun[];
}>
```

This powers CLI/TUI status and operational dashboard.

#### `approveWorkflowNode()` / `denyWorkflowNode()`

Add APIs:

```ts
async decideWorkflowApproval(
  runId: string,
  nodeId: string,
  decision: WorkflowApprovalDecision,
  store?: WorkflowStore,
): Promise<WorkflowNodeRun>
```

Rules:

- run must exist;
- node checkpoint must exist;
- node must be `waiting_approval`;
- node type must be `approval`;
- `approved` changes node to `passed` and stores decision;
- `denied` changes node to `failed` and stores decision;
- update `run.waitingApprovalNodeIds`, `run.completedNodeIds`, `run.failedNodeIds`, and `run.status` accordingly.

This decouples approval recording from runtime execution.

#### `cancelWorkflow()` / `pauseWorkflow()`

Add API:

```ts
async cancelWorkflow(runId: string, reason?: string, store?: WorkflowStore): Promise<WorkflowRun>
```

Initial semantics:

- mark run `cancelled`;
- clear `currentNodeIds`;
- preserve passed/failed/waiting node checkpoints;
- write cancellation reason into `run.error` or future `run.cancelReason`.

A full cooperative in-process cancellation loop can come after this. First value is persisted state and CLI control.

#### Resume behavior update

After adding approval-decision API, `resumeWorkflow()` should treat an approval node checkpoint that is already `passed` as completed, not re-prompt.

That mostly works already because passed nodes are skipped. The needed change is user flow, not core ready logic.

### Safe retry/idempotency option

Before using this runtime for EziSign-like mutating operations, add node metadata:

```yaml
retryPolicy:
  maxAttempts: 1
  retryRunningAfterCrash: false
  requireApprovalBeforeRetry: true
idempotencyKey: ${run.id}:${node.id}
```

For MVP, default policy should be conservative:

| Node kind | Default retry for `running` after crash |
| --- | --- |
| read-only `tool` | Retry allowed. |
| `test` | Retry allowed. |
| `prompt` / `reduce` | Retry allowed. |
| `agent` with unknown side effects | Require approval before retry or mark `waiting_approval`. |
| tool with `schema.destructive: true` | Require approval before retry. |
| explicit `retrySafe: true` | Retry allowed. |

This prevents duplicate external side effects.

### Implementation order by value

Do these before adding loop/parallel complexity:

1. **Run/checkpoint visibility**
   - `listRuns()`
   - `getRunSummary()`
   - status/checkpoint formatting

2. **Approval decision API**
   - approve/deny waiting node
   - update run state
   - resume after recorded approval

3. **Cancel/pause persisted state**
   - mark run `cancelled`
   - skip cancelled runs on resume unless `--force`

4. **CLI/slash command surface**
   - `workflows status <run-id>`
   - `workflows checkpoints <run-id>`
   - `workflows approve <run-id> <node-id>`
   - `workflows deny <run-id> <node-id>`
   - `workflows resume <run-id>`
   - `workflows cancel <run-id>`

5. **Retry/rewind API**
   - retry failed node
   - invalidate selected node/downstream checkpoints

6. **Safe side-effect retry policy**
   - conservative retry behavior for `running` mutating nodes
   - idempotency key support

7. **Cooperative cancellation**
   - add `AbortSignal` to `WorkflowRuntimeDeps`
   - pass signal to prompt nodes and agent execution options
   - stop between batches/nodes

8. **Then implement `parallel` and `loop` nodes**
   - once run control and checkpoint visibility are reliable.

### Tests needed next

| Test | Expected behavior |
| --- | --- |
| `listRuns` returns runs sorted by `updatedAt` | Store can enumerate operational state. |
| `getRunSummary` includes run and node checkpoints | Status/checkpoint views can be built. |
| `approveWorkflowNode` marks waiting approval as passed | Approval can be recorded without rerunning the node. |
| `denyWorkflowNode` marks waiting approval as failed | Denial is durable and auditable. |
| `resumeWorkflow` continues after pre-recorded approval | Run skips approved checkpoint and executes downstream nodes. |
| `cancelWorkflow` marks run cancelled | Operator can stop a run intentionally. |
| `resumeWorkflow` refuses cancelled run unless forced | Cancelled state is respected. |
| `checkpoint formatting` includes status/summary/error/current nodes | User can inspect where the workflow stopped. |
| `running destructive node resume` pauses before retry | Prevent duplicate side effects. |
| `retry failed node` clears failed checkpoint and downstream nodes | Failed work can be retried without JSON edits. |

### CLI output shape recommendation

#### `workflows status run_abc123`

```text
Workflow run_abc123 — ezisign-followup
Status: waiting_approval
Created: 2026-09-04 10:00
Updated: 2026-09-04 10:03

Completed: list_pending, summarize
Waiting approval: approve_reminders
Failed: none
Current: none
```

#### `workflows checkpoints run_abc123`

```text
Node checkpoints:
  ✓ list_pending       tool      passed             List found 3 envelopes
  ✓ summarize          prompt    passed             3 pending signatures require review
  ? approve_reminders  approval  waiting_approval   Approve sending reminders?
  - send_reminders     agent     pending            depends on approve_reminders
```

#### `workflows approve run_abc123 approve_reminders`

```text
Approved approve_reminders for run_abc123.
Run is ready to resume.
```

### Final recommendation

The workflow runtime should not proceed directly to `parallel`, `loop`, scheduling, or EziSign execution until checkpoint visibility and operator control are implemented. The next highest-value implementation is:

```text
list runs + inspect checkpoints + approve/deny checkpoint + cancel run + resume command
```

That closes the immediate HITL gap and makes the current checkpoint system usable by humans, not just tests.
