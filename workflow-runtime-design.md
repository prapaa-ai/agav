# AGAV Workflow Runtime Design

## Purpose

Build a first-class workflow runtime for AGAV that can compose internal agents, external agents, tools, skills, MCP-backed capabilities, approvals, tests, and bounded loops into resumable, checkpointed runs.

This design focuses on the **runtime first**. Dynamic routing and intelligent model/agent selection should be handled in a later PR. The runtime should still allow each node to statically declare which agent/model/provider/effort profile it wants, so workflows can use cheaper/local models where appropriate and reserve expensive models for hard nodes.

## Goals

1. **Reusable workflows**: users can define workflows as source-controlled files.
2. **Checkpoint/resume**: runs persist after every node and can continue where they left off.
3. **Sandboxed execution**: tool/process/shell execution uses AGAV's existing sandbox and permission model where applicable.
4. **Internal + external agents**: workflows can call native AGAV agents, A2A agents, subagents, skills, MCP tools, and built-in tools.
5. **Fast execution**: run independent nodes in parallel, avoid repeated context loading, and skip completed nodes on resume.
6. **Lower token usage**: isolate context per node, pass only structured summaries/artifacts, and allow cheap/local models per node.
7. **Easy to use**: YAML workflow files, simple CLI/slash commands, clear status, good errors.
8. **Testable before scheduling**: validation, dry-run, mocks, assertions, and fixture-based evals.
9. **Traceable and operable**: every run has node-level logs, status, inputs, outputs, approvals, errors, and artifacts.
10. **Safe loops**: loops are bounded and checkpointed; no arbitrary unbounded graph cycles in MVP.

## Non-goals for the first workflow runtime PR

- No dynamic routing planner. Per-node runtime choice is static config only.
- No visual graph editor.
- No cloud control plane.
- No marketplace workflow certification yet.
- No arbitrary cyclic graph support.
- No remote A2A hardening beyond using the existing A2A agent abstraction.
- No ACP server/client implementation.

## Design summary

AGAV should add a workflow runtime with four core concepts:

```text
WorkflowDefinition  -> source-controlled desired graph
WorkflowRun         -> persisted execution instance
WorkflowNodeRun     -> persisted node checkpoint/status/output
WorkflowRuntime     -> executor that validates, schedules, resumes, and records traces
```

Recommended storage:

```text
Project workflow definitions:
  .agav/workflows/<workflow-name>.yaml

User workflow definitions:
  ~/.agav/workflows/<workflow-name>.yaml

Workflow run records:
  ~/.agav/workflow-runs/<run-id>/
    run.json
    nodes/<node-id>.json
    logs/<node-id>.log
    artifacts/
```

## High-level architecture

```text
CLI / Slash command
      |
      v
Workflow loader
      |
      v
Workflow validator  ---> missing agents/tools/skills/MCP/errors
      |
      v
Workflow planner    ---> DAG order, parallel groups, loop expansion
      |
      v
Workflow runtime
      |
      +--> Node executor: prompt
      +--> Node executor: agent
      +--> Node executor: tool
      +--> Node executor: skill
      +--> Node executor: approval
      +--> Node executor: test
      +--> Node executor: loop
      +--> Node executor: reduce
      |
      v
Checkpoint store + trace log
      |
      v
Resume / dashboard / tests / schedules
```

## Workflow definition format

Use YAML for authoring and normalize internally to JSON.

Example:

```yaml
version: 1
name: ezisign-followup
description: Check pending signatures and send reminders after approval

inputs:
  daysPending:
    type: number
    default: 3

policies:
  maxRuntimeSeconds: 1800
  maxIterations: 5
  maxConcurrency: 4
  permissionMode: ask
  sandbox: auto
  stopOnFailure: true
  resume: true

nodes:
  - id: list_pending
    type: agent
    agent: ezisign_agent
    model: local-small
    effort: low
    task: List envelopes pending for more than ${inputs.daysPending} days.
    outputSchema:
      type: object
      required: [envelopes]
      properties:
        envelopes:
          type: array

  - id: summarize
    type: prompt
    model: cheap
    effort: low
    dependsOn: [list_pending]
    prompt: Summarize these pending envelopes for approval: ${nodes.list_pending.output.envelopes}

  - id: approve_reminders
    type: approval
    dependsOn: [summarize]
    prompt: Approve sending EziSign reminders for the summarized envelopes?

  - id: send_reminders
    type: agent
    agent: ezisign_agent
    model: cheap
    effort: low
    dependsOn: [approve_reminders]
    task: Send reminders only to the approved envelopes from ${nodes.list_pending.output.envelopes}.

  - id: verify_status
    type: test
    dependsOn: [send_reminders]
    assertions:
      - type: output_contains
        node: send_reminders
        value: reminder
```

## Workflow schema fields

### Top-level fields

| Field | Required | Purpose |
| --- | --- | --- |
| `version` | yes | Workflow schema version. Start with `1`. |
| `name` | yes | Stable workflow name. Used by CLI/slash commands. |
| `description` | yes | Human-readable summary. |
| `inputs` | no | Typed inputs with defaults. |
| `policies` | no | Runtime limits and safety controls. |
| `nodes` | yes | DAG nodes. |
| `evals` | no | Optional eval fixtures for later certification. |

### Policy fields

| Field | Default | Purpose |
| --- | --- | --- |
| `maxRuntimeSeconds` | `3600` | Stop whole run after wall-clock limit. |
| `maxNodeRuntimeSeconds` | `600` | Stop any single node after timeout. |
| `maxIterations` | `3` | Default loop iteration cap. |
| `maxConcurrency` | `4` | Default parallel node cap. |
| `permissionMode` | session value | `ask`, `auto`, `deny-writes`, etc. Reuse AGAV permission vocabulary. |
| `sandbox` | `auto` | `auto`, `seatbelt`, `bubblewrap`, `docker`, `none`. |
| `stopOnFailure` | `true` | Stop downstream nodes after failure. |
| `resume` | `true` | Allow checkpoint resume. |
| `allowNetwork` | session policy | Optional future network policy. |
| `tokenBudget` | unset | Optional max token budget when usage is available. |
| `costBudgetUsd` | unset | Optional estimated cost cap. |

## Node types

### `agent` node

Calls an installed AGAV agent.

Supports:

- native agents;
- A2A agents through existing AGAV A2A abstraction;
- per-node model/effort/provider override;
- output schema validation;
- checkpointed output.

Example:

```yaml
- id: jira_lookup
  type: agent
  agent: jira_agent
  model: cheap
  effort: low
  task: Find issues related to ${inputs.issueKey}
```

### `prompt` node

Runs an AGAV agent loop with a prompt and a configured tool set.

Useful for lightweight reasoning, transformation, summarization, or reducer steps.

```yaml
- id: synthesize
  type: prompt
  model: claude-sonnet-4-5
  effort: medium
  prompt: Merge these findings into one prioritized report: ${nodes.parallel_a.output}
```

### `tool` node

Calls a built-in or MCP-registered tool directly with structured input.

```yaml
- id: run_tests
  type: tool
  tool: run_tests
  input:
    path: source/__tests__
```

Tool nodes should use the existing `ToolRegistry.execute()` path so normal tool error handling and sandbox behavior remain centralized.

### `skill` node

Activates a registered skill with arguments.

```yaml
- id: review
  type: skill
  skill: code-review
  args: Review ${nodes.diff.output}
```

### `approval` node

Creates a checkpointed human gate.

```yaml
- id: approve_send
  type: approval
  prompt: Approve sending these envelopes?
```

Approval output should include:

```json
{
  "decision": "approved",
  "approvedAt": "...",
  "approvedBy": "local-user",
  "note": "optional"
}
```

If AGAV is running headless and approval is required, the node should stop with `waiting_approval` unless a future permission-prompt callback is provided.

### `test` node

Validates outputs, files, commands, schemas, or tool results.

Supported MVP assertions:

| Assertion | Purpose |
| --- | --- |
| `output_contains` | Check node output contains text. |
| `output_matches` | Regex check. |
| `json_schema` | Validate output against JSON schema. |
| `file_exists` | Verify file artifact exists. |
| `command` | Run shell/test command through sandboxed command path. |
| `tool_result` | Check a tool node returned `isError: false`. |

Example:

```yaml
- id: typecheck
  type: test
  assertions:
    - type: command
      command: pnpm exec tsc --noEmit
      sandbox: auto
```

### `parallel` node

Runs child nodes concurrently and collects outputs.

```yaml
- id: inspect_modules
  type: parallel
  maxConcurrency: 3
  children:
    - id: inspect_auth
      type: agent
      agent: code_review_agent
      task: Inspect auth module
    - id: inspect_db
      type: agent
      agent: code_review_agent
      task: Inspect database module
```

MVP can also allow parallelism through normal DAG scheduling: if two nodes have no dependency on each other, run them concurrently up to `maxConcurrency`.

### `reduce` node

Merges outputs from multiple upstream nodes.

```yaml
- id: final_report
  type: reduce
  dependsOn: [inspect_auth, inspect_db, inspect_api]
  model: cheap
  prompt: Merge findings, dedupe, and rank by severity.
```

### `loop` node

Bounded repeated execution. No unbounded loops.

```yaml
- id: fix_until_tests_pass
  type: loop
  maxIterations: 3
  stopWhen:
    node: run_tests
    status: passed
  body:
    - id: run_tests
      type: tool
      tool: run_tests
      input:
        path: source
    - id: fix_failures
      type: agent
      agent: coding_agent
      task: Fix only the failures from ${nodes.run_tests.output}
```

Loop checkpoints should record each iteration separately:

```text
nodes/fix_until_tests_pass/iterations/1/run_tests.json
nodes/fix_until_tests_pass/iterations/1/fix_failures.json
nodes/fix_until_tests_pass/iterations/2/run_tests.json
```

## Checkpoint and resume design

### Run state

`run.json`:

```json
{
  "id": "run_abc123",
  "workflowName": "ezisign-followup",
  "workflowVersion": 1,
  "workflowHash": "sha256:...",
  "status": "running",
  "createdAt": "...",
  "updatedAt": "...",
  "inputs": {},
  "policies": {},
  "currentNodeIds": ["list_pending"],
  "completedNodeIds": [],
  "failedNodeIds": [],
  "waitingApprovalNodeIds": []
}
```

### Node checkpoint

`nodes/<node-id>.json`:

```json
{
  "id": "list_pending",
  "type": "agent",
  "status": "passed",
  "attempt": 1,
  "startedAt": "...",
  "endedAt": "...",
  "input": {},
  "output": {},
  "summary": "short human-readable output",
  "usage": {
    "inputTokens": 1000,
    "outputTokens": 200,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0
  },
  "error": null,
  "artifacts": [],
  "logs": ["logs/list_pending.log"]
}
```

### Checkpoint rules

1. Write a node checkpoint before execution starts: `status = running`.
2. Append trace events while it runs.
3. On success, atomically write `status = passed` and output.
4. On failure, atomically write `status = failed` and error.
5. On approval wait, atomically write `status = waiting_approval`.
6. Resume skips `passed` nodes if:
   - workflow hash matches;
   - node definition hash matches;
   - upstream outputs match or are unchanged.
7. Resume re-runs `running` nodes because they may have been interrupted mid-call.
8. Resume blocks on `waiting_approval` until approval is supplied.
9. If workflow changed, re-run changed nodes and downstream dependents.

### Atomic writes

Use the existing safe pattern from background processes:

```text
write temp file -> rename atomically
```

This prevents corrupt checkpoints if AGAV exits mid-write.

## Sandbox and permissions

The workflow runtime should not invent a second security model. It should reuse AGAV's current primitives:

- `run_command` sandbox for shell commands;
- `process` safety checks for daemon-backed commands;
- native agent tool permission classifications;
- existing confirmation flow for mutating tools;
- per-agent encrypted credentials;
- A2A loopback restriction until remote trust is added;
- MCP tools through the normal tool registry.

### Sandbox policy resolution

Per node:

```yaml
sandbox: auto
permissionMode: ask
```

Resolution order:

1. node policy;
2. workflow policy;
3. session config;
4. tool default.

### Mutating operation behavior

| Runtime mode | Behavior |
| --- | --- |
| Interactive | Ask user through existing confirmation UI. |
| Headless without approval callback | Stop at `waiting_approval`. |
| Headless with explicit allow policy | Continue and record approval source. |
| Dry run | Skip/mocks mutating calls and record intended action. |

## Internal and external agent composition

### Internal AGAV agents

Workflow `agent` nodes should call the installed agent by name using the existing agent loader/executor.

Example:

```yaml
- id: github_issue
  type: agent
  agent: github_agent
  task: Create a GitHub issue from ${nodes.jira_lookup.output}
```

### External A2A agents

A2A agents should be referenced exactly like native agents. The workflow runtime should not care whether the agent is native or A2A.

```yaml
- id: external_security_scan
  type: agent
  agent: external_security_scanner
  task: Scan this branch and return JSON findings.
```

The agent executor decides whether this is native or A2A.

### Subagents

The runtime can use the existing `subagent` tool indirectly through prompt/tool nodes. A later PR can add explicit `subagent` node support if needed.

## Per-node model/provider/agent configuration

Routing logic is a later PR, but runtime should preserve static node-level configuration now.

Supported node fields:

| Field | Purpose |
| --- | --- |
| `agent` | Which installed agent to call. |
| `model` | Model override for this node. |
| `provider` | Optional provider override if current provider registry supports it later. |
| `effort` | Reasoning effort override. |
| `maxTokens` | Node output cap. |
| `timeoutSeconds` | Node runtime cap. |
| `allowedTools` | Optional narrowed tool set for prompt nodes. |
| `sandbox` | Sandbox backend override. |

Example cheap/local node:

```yaml
- id: summarize_logs
  type: prompt
  provider: ollama
  model: llama3.2
  effort: low
  maxTokens: 1000
  prompt: Summarize this log excerpt: ${nodes.collect_logs.output}
```

Important: if provider switching is not yet available in this PR, the runtime should parse and store these fields but only apply `model`/`effort` where existing provider APIs support it. It should not implement full routing yet.

## Token reduction strategy

The workflow runtime should reduce token use by design.

| Technique | Design |
| --- | --- |
| Node isolation | Each node receives only declared inputs, not the full conversation. |
| Structured outputs | Prefer JSON/output schema for machine handoff. |
| Summaries | Store full logs as artifacts; pass short summaries downstream. |
| Artifact references | Downstream nodes receive file paths/artifact IDs instead of huge inline text. |
| Cheap/local nodes | Static per-node model/effort config allows cheaper summarization/reduce/test nodes. |
| Skip on resume | Completed nodes are not rerun. |
| Parallel fan-out | Independent work avoids long monolithic context. |
| Output caps | `maxTokens` and artifact overflow prevent huge handoff text. |
| Cache-friendly prompts | Reuse stable system/node templates and put variable data late. |

## Speed strategy

| Technique | Design |
| --- | --- |
| DAG scheduling | Run independent nodes concurrently up to `maxConcurrency`. |
| Checkpoint skip | Resume avoids completed work. |
| Direct tool nodes | Use direct tool calls when LLM reasoning is not needed. |
| Test nodes | Run deterministic tests without extra model calls. |
| Static node config | Avoid runtime model-routing overhead in this PR. |
| Lazy agent/MCP startup | Start per-agent MCP only when that agent node runs. |
| Minimal context | Smaller prompts execute faster and cheaper. |

## Runtime status model

Workflow run statuses:

| Status | Meaning |
| --- | --- |
| `pending` | Run record created but not started. |
| `running` | At least one node is executing. |
| `waiting_approval` | Paused for human approval. |
| `passed` | All required nodes completed. |
| `failed` | One or more required nodes failed. |
| `cancelled` | User stopped the run. |
| `timed_out` | Runtime or node exceeded limit. |

Node statuses:

| Status | Meaning |
| --- | --- |
| `pending` | Waiting on dependencies. |
| `running` | Currently executing. |
| `waiting_approval` | Paused at approval gate. |
| `passed` | Completed successfully. |
| `failed` | Completed with error. |
| `skipped` | Skipped due to dry-run, condition, or upstream failure. |
| `cancelled` | Stopped by user. |
| `timed_out` | Exceeded timeout. |

## Traceability and operations

Each node should emit structured trace events:

```json
{"type":"node_started","runId":"...","nodeId":"...","ts":"..."}
{"type":"agent_called","agent":"ezisign_agent","model":"cheap","ts":"..."}
{"type":"tool_called","tool":"ezisign_send_reminder","permission":"modifies","ts":"..."}
{"type":"approval_requested","nodeId":"approve_send","ts":"..."}
{"type":"approval_decided","decision":"approved","ts":"..."}
{"type":"node_completed","nodeId":"send_reminders","durationMs":1200,"ts":"..."}
```

Initial operational commands:

```bash
agav workflows list
agav workflows validate <name-or-path>
agav workflows run <name-or-path> --input inputs.json
agav workflows resume <run-id>
agav workflows status <run-id>
agav workflows logs <run-id> [node-id]
agav workflows stop <run-id>
agav workflows test <name-or-path>
agav workflows dry-run <name-or-path>
```

Slash commands can mirror the same capability later:

```text
/workflows list
/workflows run ezisign-followup
/workflows status <run-id>
/workflows resume <run-id>
/workflows stop <run-id>
```

## Test and eval design

### Unit tests for MVP runtime

Create tests only under `source/__tests__/`.

Minimum tests:

| Test | Purpose |
| --- | --- |
| Workflow schema validation | Reject missing version/name/nodes and invalid node references. |
| DAG ordering | Nodes run only after dependencies pass. |
| Parallel readiness | Independent nodes are both eligible to run. |
| Checkpoint write | Running/passed/failed node checkpoints are persisted. |
| Resume skip | Passed nodes are skipped on resume. |
| Resume rerun interrupted | Nodes left `running` are retried. |
| Changed node invalidation | Changed node hash causes downstream rerun. |
| Approval checkpoint | Approval node stores `waiting_approval` and resumes after decision. |
| Tool node execution | Direct tool node calls `ToolRegistry.execute()`. |
| Test node command | Command assertion uses sandboxed command path. |
| Agent node native | Native agent node calls agent executor abstraction. |
| Agent node A2A | A2A agent node works through same executor abstraction. |
| Dry-run mutating skip | Mutating nodes are skipped/mocked. |
| Loop max iterations | Loop stops at configured cap. |
| Output schema validation | Invalid node output fails the node. |

### Eval fixture layout

```text
.agav/workflows/ezisign-followup.yaml
.agav/workflows/ezisign-followup.evals/
  pending-three-days.json
  no-pending.json
  reminder-failure.json
```

Eval fixture example:

```json
{
  "name": "pending-three-days",
  "inputs": { "daysPending": 3 },
  "mocks": {
    "nodes.list_pending.output": {
      "envelopes": [{ "id": "env_1", "recipient": "a@example.com" }]
    }
  },
  "expect": {
    "status": "waiting_approval",
    "nodes.list_pending.status": "passed",
    "nodes.approve_reminders.status": "waiting_approval"
  }
}
```

Formal eval scoring can come after the runtime, but the runtime should keep the file structure compatible.

## Implementation modules

Recommended production files for a future implementation PR:

```text
source/workflows/types.ts          # WorkflowDefinition, WorkflowRun, WorkflowNodeRun
source/workflows/loader.ts         # load by name/path from project/user locations
source/workflows/validator.ts      # schema, DAG, reference validation
source/workflows/store.ts          # atomic checkpoint/run/artifact storage
source/workflows/interpolate.ts    # ${inputs.*}, ${nodes.*.output} resolution
source/workflows/runtime.ts        # scheduler/executor/resume orchestration
source/workflows/executors.ts      # node executor implementations
source/workflows/evals.ts          # fixture-based dry-run/test harness
source/commands/workflows.ts       # slash command
source/cli/workflows-cli.ts        # CLI command
source/__tests__/workflows.*.test.ts
```

## Minimal public API shape

```ts
export interface WorkflowRuntimeDeps {
  provider: LLMProvider;
  config: AgavConfig;
  toolRegistry: ToolRegistry;
  loadAgent: (name: string) => Promise<AgentDefinition | null>;
  executeAgent: (agent: AgentDefinition, task: string, options: AgentExecutionOptions) => Promise<string>;
  confirm?: (request: WorkflowApprovalRequest) => Promise<WorkflowApprovalDecision>;
}

export async function validateWorkflow(definition: WorkflowDefinition, deps: WorkflowValidationDeps): Promise<WorkflowValidationResult>;

export async function runWorkflow(definition: WorkflowDefinition, inputs: Record<string, unknown>, deps: WorkflowRuntimeDeps): Promise<WorkflowRun>;

export async function resumeWorkflow(runId: string, deps: WorkflowRuntimeDeps): Promise<WorkflowRun>;
```

## MVP build order by value

1. **Types + schema + validator**
   - Workflow files can be parsed and references checked.
2. **Checkpoint store**
   - Run and node status can be atomically persisted.
3. **Sequential DAG runtime**
   - `tool`, `test`, and `agent` nodes run in dependency order.
4. **Resume logic**
   - Passed nodes are skipped; interrupted nodes rerun.
5. **Approval node**
   - Runtime can pause and resume safely.
6. **Prompt/skill nodes**
   - Add LLM and skill integration after deterministic nodes work.
7. **Parallel execution**
   - Add concurrency once checkpoint semantics are correct.
8. **Loop node**
   - Add bounded loops after sequential/parallel execution is stable.
9. **Dry-run/eval harness**
   - Add mocks and assertions before scheduling.
10. **CLI/slash UX**
   - Expose validate/run/resume/status/logs/test.

## Open questions

| Question | Recommended answer for MVP |
| --- | --- |
| YAML dependency | Use existing `yaml` package already in dependencies. |
| Provider override per node | Parse/store now; apply only where existing APIs support it. Full routing later. |
| External A2A auth | Not in runtime PR; use existing A2A behavior. |
| Scheduling workflows | Defer until runtime + tests are stable. CLI can support `run` first. |
| Marketplace workflow templates | Defer. Keep workflow files portable now. |
| Visual dashboard | Defer. Provide status/log CLI and future `/ops` can read run records. |
| Arbitrary graph cycles | No. Use bounded loop node only. |

## Acceptance criteria for the first implementation PR

The first workflow runtime PR should be considered successful when:

1. A workflow YAML can be validated.
2. A simple DAG with `tool`, `test`, and `agent` nodes can run.
3. Each node writes a checkpoint before and after execution.
4. A failed/interrupted run can resume and skip passed nodes.
5. Approval nodes pause and persist `waiting_approval`.
6. Tool/test command execution uses existing sandbox/permission paths.
7. Native and A2A agents are both invoked through a common `agent` node abstraction.
8. Unit tests cover validation, checkpointing, resume, approval pause, tool/test node execution, and agent abstraction.
9. The runtime keeps node context small and does not pass full conversation history between nodes.
10. Per-node `model`, `effort`, `sandbox`, `timeoutSeconds`, and `maxTokens` fields are parsed and persisted, even if full provider routing is deferred.
