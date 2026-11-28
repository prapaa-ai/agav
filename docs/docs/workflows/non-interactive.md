---
title: Non-interactive and CI
description: Use Agav in shell scripts, pipes, and continuous integration
order: 6
---

# Non-interactive and CI

Agav provides two one-shot modes. Quote prompts that contain spaces. In print mode, pass the prompt immediately after `-P`; put flags such as `--stream` and `--output-schema` before the `-P "<prompt>"` pair.

Both modes also accept piped stdin. When stdin is present, Agav wraps it as:

```text
<stdin>
...
</stdin>
```

and prepends it to the prompt it sends to the model.

## Print mode

| Command | Intent |
| --- | --- |
| `agav -P "<prompt>"` | Run one agent turn and write only the final answer to stdout. |
| `agav --stream -P "<prompt>"` | Stream response text while preserving stderr for tool progress and errors. |

`agav -P` runs one agent turn, writes the final answer to stdout, writes tool progress and errors to stderr, and exits:

```bash
agav -P "summarize this repository"
agav --stream -P "review the current diff"
```

Pipe a text log from the shell that launches Agav:

**POSIX shell**

```bash
cat error.log | agav -P "explain the failure"
```

**Windows PowerShell**

```powershell
Get-Content -Raw -Encoding UTF8 .\error.log | agav -P "explain the failure"
```

Print mode accepts cwd-relative `@file` mentions, but it does not add dynamic repository context such as git state, project instructions, memories, or skills.

`--max-turns <number>` caps agent iterations for the print prompt. The cap applies per prompt across model requests, including retries.

## Run mode

| Command | Intent |
| --- | --- |
| `agav run "<prompt>"` | Run a one-shot, repository-aware agent task with streamed output. |
| `agav run --max-turns <count> "<prompt>"` | Limit the number of model requests available to the task. |
| `agav run --permission '<json>' "<prompt>"` | Supply an explicit JSON tool-permission policy. |

`agav run` includes dynamic repository context and streams output, making it suitable for agent-style CI work:

```bash
agav run "review src for security issues"
agav run --max-turns 20 "fix the type errors"
```

Non-interactive runs default to auto-accept, subject to organization policy. Use `--permission` or `AGAV_PERMISSION` with `agav run` to narrow what CI jobs can do.

Control tools with JSON permissions or `AGAV_PERMISSION`:

```bash
agav run --permission '{"*":"deny","read_file":"allow","grep_search":"allow"}' "audit the code"
```

In Windows PowerShell, set the JSON in the environment instead of passing it as a native command argument. Restore or remove the variable after the run if the shell will be reused:

```powershell
$env:AGAV_PERMISSION = '{"*":"deny","read_file":"allow","grep_search":"allow"}'
agav run "audit the code"
```

An explicit `"*":"deny"` allows the listed tools and blocks other tools that are not already safe. If a policy contains deny rules without `"*":"deny"`, Agav falls back to broad `deny-writes`-style blocking rather than fine-grained per-tool deny behavior. `--permission` and `AGAV_PERMISSION` apply to `agav run` only, not to `agav -P`.

You can also use the normal selection flags in non-interactive mode, including `--provider`, `--model`, `--effort`, `--openai-api`, and the Ollama connection flags.

## Structured output

| Command | Intent |
| --- | --- |
| `agav --output-schema @<path> -P "<prompt>"` | Require the final answer to match a JSON Schema file in the current directory. |
| `agav --output-schema '<json>' -P "<prompt>"` | Require the final answer to match an inline JSON Schema. |

Require final stdout to match JSON Schema:

```bash
agav --output-schema '@schema.json' -P "list risky dependencies"
agav --output-schema '{"type":"object","required":["summary"]}' -P "summarize"
```

In Windows PowerShell, prefer the quoted `'@schema.json'` file form to avoid embedded JSON quotes in native arguments.

`--output-schema` is print-mode only. Schema mode buffers output even when `--stream` is present. Agav validates JSON, retries once with correction instructions if the iteration budget allows, then prints only the validated JSON value. Invalid schemas, provider errors, or output that remains invalid return exit code `1`; success returns `0`.

Keep secrets in environment variables and use an appropriately narrow tool policy for CI jobs.

## Trajectory export

Use `--trajectory <path>` to save a one-shot transcript separately from stdout. Both examples work in a POSIX shell or Windows PowerShell:

```text
agav run --trajectory "run-trace.json" "summarize the current diff"
agav --trajectory "print-trace.json" -P "summarize this repository"
```

The versioned JSON records the provider, model, timestamps, aggregate token usage (including cache reads and writes), and ordered messages with tool calls and results. It keeps the recorded history through compaction and retries. It may contain prompts, file contents, and tool output: image bytes are omitted, but secrets are not redacted. Write to a protected location and review before sharing.

The destination’s parent directory must already exist. Agav attempts to write completed history even on provider or output-schema validation failure; a startup failure or hard kill may leave no file. An export write failure is reported on stderr and returns exit code `1`. The flag does not change stdout formatting and is not supported in interactive mode.

## Output recovery and stopping jobs

Model-facing tool text has the same [output limits](/features/built-in-tools#output-limits-and-recovery) as interactive sessions, even with `--stream`. Streaming the final answer does not make intermediate tool results unlimited. Saved output paths are temporary and normal process exit attempts cleanup; ask Agav to copy required diagnostics into a protected artifact location during the run, before it exits. A saved log can itself be partial.

Non-interactive tasks have no Ink selection/copy shortcuts or stay-in-session Esc behavior. Use your scheduler's timeout and termination policy, and do not assume a hard-killed process can finish cleanup or publish its logs. Native shell cleanup is best-effort; agent/test subprocesses, detached jobs, MCP server work, and Docker containers have different cancellation limits. Arrange explicit service/container cleanup in CI rather than relying on universal descendant termination. See [cancellation limits](/reference/security#cancellation-is-not-isolation).
