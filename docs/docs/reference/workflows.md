# Workflows (experimental)

Enable `backgroundJobsEnabled: true` **and** `workflowsEnabled: true` in `~/.agav/config.json`. `workflowsEnabled` is global-only and defaults off. A workflow is a JSON or YAML file describing a DAG of nodes. Every run executes **in the background** as a supervised runner job on the background-jobs coordinator, so it outlives the terminal or session that started it. Runs that need a human decision park and show up in an inbox that any session (CLI, slash command or TUI) can answer.

```yaml
# .agav/workflows/review-copy.yaml
version: 1
name: review-copy
nodes:
  - id: A
    type: tool
    tool: read_file
    input: { path: README.md }
  - id: review
    type: approval
    dependsOn: [A]
    prompt: Copy the reviewed content?
  - id: B
    type: tool
    dependsOn: [review]
    tool: write_file
    input: { path: reviewed.txt, content: "${nodes.A.output}" }
```

```sh
agav workflows validate review-copy
agav workflows run review-copy            # consent prompt, then returns; add --wait to follow
agav workflows inbox                      # pending decisions of every run
agav workflows approve 3f2a review        # run id prefix + node id (or decision id)
agav workflows status 3f2a
```

Provider credentials are only needed when a run contains `agent` or `prompt` nodes.

## Discovery and file formats

A bare workflow name is looked up in `<cwd>/.agav/workflows/` and then `~/.agav/workflows/`. A project workflow shadows a user workflow with the same name. Files are `*.json`, `*.yaml` or `*.yml`. Within one directory `.json` wins over `.yaml`, which wins over `.yml`, for the same name. Names must match `[A-Za-z0-9][A-Za-z0-9_-]*`, and the file name (without extension) is the workflow's name in commands. An operand that contains a path separator or ends in a workflow extension is treated as a path relative to the cwd.

YAML is parsed and then normalized to plain JSON before validation. Equivalent JSON and YAML sources therefore produce the same stored definition and hash. Unknown fields, at the definition or node level, are rejected rather than ignored.

## Definition

| Field | Meaning |
| --- | --- |
| `version` | Always `1`. |
| `name` | 1–200 characters. |
| `description` | Optional text. |
| `inputs` | Typed run inputs (see [Inputs](#inputs)). |
| `policies` | Run-level policies (see [Policies](#policies)). |
| `nodes` | 1–1000 nodes. |

Every node has an `id` (`[A-Za-z][A-Za-z0-9_-]{0,63}`, unique across the whole definition including loop bodies), a `type`, and optional `dependsOn` (ids of siblings in the same scope; cycles are rejected). Common optional fields:

| Field | Applies to | Meaning |
| --- | --- | --- |
| `when` | all | Condition ([expression](#expressions)). If it is false the node is `skipped`. It may reference only (transitive) dependencies. |
| `allowSkipped` | all | Treat a `skipped` dependency as satisfied. Without it, a skip cascades to dependents. |
| `retry` | tool (read-only tools only), job, agent, prompt | `{max: 1..10, backoffSeconds?: 0..3600}` gives up to `max` extra attempts after a `failed` or `timed_out` attempt. |
| `timeoutSeconds` | tool, job, agent, prompt, loop | Positive, at most 86400. Not allowed on approval nodes. |

### Node types

**`tool`** runs one built-in tool with `input`. Allowed tools: `read_file`, `write_file`, `edit_file`, `run_command`, `grep_search`, `find_files`, `list_directory` and `overview`. `run_background_job`, network tools, agents, skills and registry extensions are not available. `${…}` references are allowed in input strings, except anywhere inside `run_command` input: commands must be literal. `retry` is allowed only for the read-only tools (`read_file`, `grep_search`, `find_files`, `list_directory`, `overview`), because mutating tools are never re-run automatically.

**`approval`** has a `prompt` (the text shown to the decider) and pauses the run until someone approves (the node is `passed`) or denies (the node is `failed`). It supports neither `timeoutSeconds` nor `retry`. An approval is a workflow decision, **not** a tool-permission grant.

**`job`** runs one literal shell `command` as a background job (`posix-sh`, or `cmd` on win32) in the run's cwd. `${` anywhere in the command is rejected. `tool`, `input` and `prompt` are not allowed. The command must be covered by the run's consent (see [Consent](#launching-and-consent)), and a fresh start is refused while `sandboxRequired` is enabled, because background jobs run outside the OS sandbox. Each attempt has a deterministic request id: `wf-<runId>-<nodeId>-<attempt>`. Inside loops the id is prefixed with `<loopId>.<iteration>.`. The first attempt ends in `-1`, and a retry gets a new id and therefore a new job. Resuming reattaches to the existing job and never starts a second one. Outcomes:

| Job state | Node result |
| --- | --- |
| `completed`, exit code 0 | `passed`; `output` is the stdout tail (at most the last 64 KiB) |
| non-zero exit, or `failed` | `failed`; `error` holds the state, exit code and the last 8 KiB of stderr |
| `interrupted` | `cancelled` |
| `unknown`, `recovery-required`, foreign request id or unreadable state | `failed` with `uncertain: …`, never retried |

`timeoutSeconds` is measured from the node's first start, so a resumed node keeps its budget. When it expires the job is explicitly stopped, and the node becomes `timed_out` once the stop is confirmed.

**`agent`** runs an installed agent (`agent`, resolved from the installed agents; it must be enabled) on an interpolated `task`. The task is the agent's whole input; there is no conversation history. **`prompt`** runs a synthetic agent on an interpolated `prompt`. That agent can use only the workflow tools listed in `allowedTools` (none by default). Both node types accept:

- `model` and `effort`: overrides.
- `maxIterations`: the agent's turn limit, 1–200.
- `output`: `text` (the default) or `json`. The reply must be JSON, or contain a `` ```json `` block.
- `outputSchema`: a JSON Schema that the parsed JSON must match. It requires `output: json`; a mismatch fails the node.
- `retrySafe`: default `true`. An interrupted node is dispatched again on resume. `false` instead parks it on an `uncertain_tool` decision.

Usage, model and duration are recorded on the checkpoint. A transcript is written to `<runDir>/artifacts/<nodeId>.txt`.

**`loop`** runs a `body` sub-DAG once per iteration, sequentially:

- `maxIterations` is required and must be at most **50**.
- The loop stops (`passed`) after an iteration once `until` (an expression that may reference body nodes, the loop's own dependencies and `loop.*`) is true, or once `stopWhen: {node, status}` matches a body node's status.
- A body failure fails the loop. A body approval parks the loop, and the iteration continues on resume.
- `onExhausted` sets the result when `maxIterations` is reached without stopping: `fail` (the default) or `continue` (`passed`, with the last iteration's outputs as `output`).
- `historyLimit` (1–20, default 5) sets how many finished iterations `loop.history` keeps.
- `timeoutSeconds` bounds the whole loop.
- Loops nest at most **2** levels deep. Body nodes may depend only on body siblings. `retry`, `tool`, `input`, `command` and `prompt` are not allowed on the loop itself.
- A passed loop's `output` maps each body node id to its output from the final iteration.

### References

Tool `input` strings, agent `task` and prompt `prompt` may contain:

- `${inputs.<name>}`
- `${nodes.<id>.output}`, optionally followed by a path such as `.field.0`
- `${nodes.<id>.status}`
- Inside a loop body: `${loop.index}`, `${loop.prev.<id>.output…}` (the previous iteration's body nodes), and `${loop.history…}` (a list of `{index, status, outputs}`).

A string that is exactly one reference resolves to the raw value. Embedded references are stringified, with objects and arrays JSON-encoded. A referenced node must be a (transitive) dependency; this is checked at validation. Only a `passed` node's output is data. Referencing the output of a node that did not pass, a missing field or index, or a missing input fails the node.

### Expressions

`when` and loop `until` use a small safe expression language. It is parsed by hand and never uses `eval`:

```text
or:          a || b          and:     a && b
comparison:  == != < <= > >= in
unary:       !x   -x         literals: numbers, 'strings' / "strings", true, false, null
references:  inputs.<name>[.path]  nodes.<id>.status  nodes.<id>.output[.path]
             loop.index  loop.item|prev|history[.path]
```

- `==` and `!=` compare deeply.
- Ordering (`<`, `<=`, `>`, `>=`) is defined only between two numbers or two strings; anything else is false.
- `in` tests array membership or substring.
- Empty string, `0`, `null`, `undefined` and `false` are falsy; arrays are truthy.
- A missing reference evaluates to `undefined` and never errors, so `nodes.x.status == 'passed'` is simply false for a skipped `x`.
- An optional `${…}` wrapper around the whole expression is accepted.
- Limits: 2000 characters and nesting depth 32. `__proto__`, `constructor` and `prototype` are refused.

### Inputs

```yaml
inputs:
  target: { type: string, required: true, description: Branch to test }
  attempts: { type: number, default: 3 }
```

Types are `string`, `number`, `boolean`, `object` and `array`. A `default` must match its type, and a required input cannot have a default. At launch, unknown names, missing required inputs and type mismatches are rejected, and defaults fill the gaps. A definition without `inputs` accepts any JSON object.

### Policies

| Policy | Meaning |
| --- | --- |
| `maxRuntimeSeconds` (≤ 604800) | Run deadline, fixed at the first execution and kept across resumes. When it is hit, the running node and the run become `timed_out`. |
| `stopOnFailure` (default `true`) | With `false`, a failed node only skips its dependents; independent branches continue. |
| `permissionMode` | Narrows (never widens) the run's permission mode (`deny-writes` < `ask` < `auto-accept`). |
| `maxConcurrency` (1–64) | Stored and validated but **not used**: execution is sequential. |

A run is also capped at **500** executor dispatches over its lifetime, counting retries, loop iterations and reattachments. Beyond that the run fails with `execution cap (500) exceeded`.

## Example: fix until tests pass

```yaml
# .agav/workflows/fix-tests.yaml
version: 1
name: fix-tests
description: Run the tests; while they fail, let an agent fix the code (at most 5 rounds).
policies:
  maxRuntimeSeconds: 3600
nodes:
  - id: fix-loop
    type: loop
    maxIterations: 5
    historyLimit: 3
    # The test job always exits 0 and reports the real exit code, so a red test run does not fail the iteration.
    until: "'exit=0' in nodes.test.output"
    body:
      - id: test
        type: job
        command: npm test 2>&1; echo "exit=$?"
        timeoutSeconds: 900
      - id: fix
        type: prompt
        dependsOn: [test]
        when: "!('exit=0' in nodes.test.output)"
        allowedTools: [read_file, grep_search, find_files, edit_file]
        maxIterations: 40
        prompt: |
          The test suite fails (attempt ${loop.index}). Fix the code, not the tests.
          Test output:
          ${nodes.test.output}
  - id: review
    type: approval
    dependsOn: [fix-loop]
    prompt: Tests pass. Review the diff before committing?
```

In each iteration the tests run. While they fail, the `fix` node gets the output and edits files; once they pass, `fix` is skipped and `until` ends the loop. After 5 failing rounds the loop fails (`onExhausted` defaults to `fail`). `npm test …` is a literal job command, so it appears in the consent prompt. Unless the run's permission mode is `auto-accept`, each distinct `edit_file` call by the agent becomes an `agent_tool_consent` decision in the inbox.

## Launching and consent

Every run asks for consent **per invocation**; consent is never inferred or remembered across runs. The prompt shows:

- the workflow name, directory and effective permission mode;
- the tools and literal job commands the definition uses, loop bodies included;
- a checklist of environment variable **names** from the current environment.

Only the selected names are passed to the runner. Values are never shown or stored. In the CLI the checklist is answered with numbers or ranges (`1 3,5-7`), `all` or `none` (the default), followed by a final y/N. `agav workflows run` therefore needs an interactive terminal (`workflow run requires interactive consent`). In the App and the TUI it is a checklist (`↑↓` move, Space toggles, `a` selects all, `x` deselects all, Enter/`y` approves, `n`/ESC denies).

The consent (definition hash, cwd, permission mode, capabilities, env names) is stored on the run and reused by its relaunches. In the detached runner:

- Tool-node calls of tools covered by the consent are approved.
- Literal job commands covered by the consent may start.
- Anything else becomes an inbox decision.

Consent for a tool name never covers an agent's sub-tool calls.

The run is created only after consent. Its runner is launched as a supervised background job (`wf-run-<runId>-<attempt>`) that runs `agav --internal-workflow-runner <runId>`. At most `maxConcurrentWorkflowRuns` runners (default 2, separate from the background-job pool) execute at once; further runs wait as `queued` and are admitted first-in, first-out. Non-Windows hosts without the native process helper refuse to launch. Windows uses the background-jobs fallback with a warning: runners and job nodes run unsandboxed, with no guaranteed Job Object ownership or descendant cleanup.

### Run and node states

Run states: `queued`, `running`, `waiting_approval`, `interrupted`, `cancelling`, then terminal `passed`, `failed`, `cancelled` or `timed_out`. Node states: `pending`, `running`, `waiting_approval`, `passed`, `failed`, `cancelled`, `timed_out` and `skipped`. Display glyphs: ✓ passed, ✗ failed, ● running, ◐ waiting, ⊘ cancelled, ⏱ timed out, … pending or queued, ! interrupted, ↷ skipped.

A runner that parks on a decision exits. Deciding the last pending decision relaunches it as a new attempt, and the runner applies the recorded decisions when it starts. A runner still executing other branches picks the decisions up itself.

### Reconcile

`list`, `status`, `--wait` and the TUI reconcile runs against the coordinator:

- A run whose runner job is gone is marked `interrupted` and relaunched, at most **3** times. After that it stays `interrupted`, and `resume` relaunches it manually.
- A runner in an uncertain state (`unknown`, `recovery-required`) is marked `interrupted` and never relaunched automatically, because it may still be alive.
- A dead runner that left a tool node `running` parks that node on an `uncertain_tool` decision instead of replaying it.
- Queued runs are admitted while the pool has room.

On resume:

- A running job node or loop is reattached or re-entered.
- A retry-safe agent or prompt node is dispatched again.
- An interrupted tool node (or a `retrySafe: false` agent) is **never** replayed: approving its `uncertain_tool` decision retries it, and denying fails it.

Completed nodes never rerun. Resume uses the stored definition, not the edited file, and requires the original working directory.

## Inbox decisions

| Kind | Raised by | Approve | Deny |
| --- | --- | --- | --- |
| `approval` | an approval node | node `passed` | node `failed` |
| `tool_consent` | a tool-node call not covered by the consent | the call runs | node `failed` |
| `agent_tool_consent` | an agent/prompt sub-tool call that needs confirmation | the call runs | only that call is refused; the agent continues |
| `uncertain_tool` | an interrupted tool node | node retried | node `failed` |

Decision ids are deterministic: they are derived from the kind, the node, the tool and a SHA-256 hash of the canonical resolved input. **Identical calls share one approval**, and a changed input gets a new decision. Approvals inside loops are keyed per iteration, so one iteration's answer never decides the next.

Decisions are files under `<runDir>/decisions/`. A decider creates `<id>.decided.json` exclusively, so exactly one session wins. A losing `approve` or `deny` exits 1. Deciders never write `run.json`; the runner remains its only writer. `--note <text>` records a note alongside the decision.

Agent sub-tool calls are confirmed as follows:

- Read-only tools are approved.
- Destructive commands, `deny-writes` and an `allowedTools` restriction refuse the call.
- `auto-accept` approves the call.
- Otherwise an `agent_tool_consent` decision is filed and awaited **in-process**, because the agent's conversation cannot be parked.

## Commands

### CLI

```text
agav workflows validate <name|file>
agav workflows run <name|file> [--input '{"key":"value"}'] [--wait] [--json]
agav workflows list [--json]
agav workflows status <run-id> [--json]
agav workflows inbox [<run-id>] [--json]
agav workflows approve|deny <run-id> <node-id|decision-id> [--note <text>]
agav workflows resume|cancel <run-id>
```

- `<run-id>` is the full UUID or any unique prefix of at least 4 characters. Lists show 8. An ambiguous prefix lists the candidates.
- `--input-json` is accepted as an alias of `--input`.
- `--json` prints machine-readable output:
  - `status`: the full checkpoint.
  - `list`: `[{id, status, workflow, createdAt, updatedAt}]`.
  - `inbox`: pending decisions.
  - `run`: `{status, run}`.
- `--wait` follows the run and prints node and run status changes. It exits 0 when the run passed or is waiting for approval, and 1 when it failed, was cancelled, timed out or stays interrupted. Ctrl+C only detaches; the run keeps going.
- Without `--wait`, `run` exits 0 once the run is started or queued, and 1 if consent is denied.
- `approve`/`deny` name a node id (when it has exactly one pending decision) or a decision id.
- `cancel` writes a durable cancel marker and asks the supervisor to stop the runner. The runner checkpoints `cancelled` within its 4 s shutdown grace. The run's own consent covers stopping its runner and its job nodes.
- `resume` relaunches the runner of an interrupted, waiting or queued run under its original consent.
- Global flags (`--cwd`, `--auto-accept`, `--deny-writes`, `--sandbox-required`) go **before** `workflows`. The permission mode in effect at launch is recorded in the consent.

### Slash command

Inside Agav, `/workflows` with no arguments opens the [Workflows TUI](#workflows-tui). The text actions are:

```text
/workflows validate <name|file>
/workflows run <name|file> [--input-json {"key":"value"}]
/workflows list
/workflows status <run-id>
/workflows inbox [<run-id>]
/workflows approve|deny <run-id> <node-id|decision-id> [--note <text>]
/workflows resume|cancel <run-id>
```

They behave like the CLI, including short ids, but have no `--json` or `--wait`. `run` returns immediately after the consent checklist. Double-quote paths that contain spaces. Input JSON is the remainder after `--input-json`, so do **not** wrap it in shell quotes. The status bar shows `workflows: N running · M need approval`. Run notifications (waiting for approval, passed, failed and so on) are shown once, in one session.

### Workflows TUI

The TUI has three tabs (Workflows │ Runs │ Inbox). `Tab` switches to the next tab, and the Inbox label shows the pending count. All tabs share the resource-manager keys: `↑↓` navigate, `←→` page, Enter/`i` inspect, `s` search, `r` refresh, ESC clears the search or exits.

| Tab | Keys |
| --- | --- |
| Workflows (discovered, with origin and last run) | `R` run (typed-input form, then the consent checklist; the new run opens in Runs), `v` validate, `e` edit name/description/inputs |
| Runs (newest first, refreshed every second) | Enter live detail (tree, inputs, pending decisions, last events), `x` cancel (confirms first), `a`/`D` approve/deny the first pending decision, `l` logs (events and every node output), `R` re-run with the same inputs, `u` resume, `d` delete a finished run |
| Inbox (pending decisions of all runs) | `a`/`D` approve/deny; each shows the full resolved tool input and asks `y`/`n` first |

## Storage

Runs live under `~/.agav/workflow-runs/<runId>/`:

- `run.json`: atomic, fsynced checkpoints.
- `events.jsonl`: a display-only trace.
- `decisions/`
- `artifacts/`: outputs over 64 KiB are stored here and referenced from the checkpoint; agent transcripts are written here too.

A per-run exclusive lock spans execution. Corrupt checkpoints fail closed. Checkpoint storage is trusted local user state, not a hostile or multi-tenant filesystem boundary.

## Permissions

The runner uses the consent's permission mode, narrowed by `policies.permissionMode`:

- Read-only tools never need confirmation.
- `deny-writes` blocks mutating tools and job starts.
- An `allowedTools` allowlist restricts mutating tools even under `auto-accept`.
- Destructive commands are refused.
- `run_command` uses Agav's shell sandbox and the `sandboxRequired` policy. `auto-accept` is not sandboxing.
- File tools keep their ordinary filesystem permissions, including absolute paths.
- Timeouts and cancellation abort a node and wait for the tool to settle. A non-cooperative tool can delay this; cancellation is not proof that escaped child processes are dead.

## Known limitations

- Approval nodes and inbox decisions wait forever: there is no decision timeout or expiry. `maxRuntimeSeconds` still applies while the runner is live.
- An agent sub-tool consent is awaited in-process by the live runner. The agent's conversation is not checkpointed while it waits.
- `policies.maxConcurrency` is stored but ignored: nodes execute one at a time in dependency order.
- Windows background runs use an unsandboxed fallback; no native Job Object helper is bundled, so process-tree ownership and descendant cleanup are not guaranteed. Docker is the only supported Windows sandbox override for explicit `run_command` calls (`sandbox: docker`), not for runners or job nodes. Consent and `sandboxRequired` remain enforced: fresh job starts refuse under `sandboxRequired`, and unsandboxed `run_command` calls refuse.
- Interrupted tool nodes are never replayed automatically. Decide their `uncertain_tool` decision after you have inspected any external effects.
- Terminal runs cannot be resumed or rewound. Use re-run (TUI `R`) or a new `run`.

## Shared job capacity and uncertain jobs

Workflow runners share background-job capacity with independent jobs. For operator-only abandonment of permanently uncertain jobs, see [Recovery guidance](/reference/job-recovery). It releases capacity without proving termination; it does not automatically resume workflows or retry uncertain children.
