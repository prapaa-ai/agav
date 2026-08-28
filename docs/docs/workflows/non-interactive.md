---
title: Non-interactive and CI
description: Use Agav in shell scripts, pipes, and continuous integration
order: 6
---

# Non-interactive and CI

Agav provides two one-shot modes. Quote prompts that contain spaces. In print mode, put flags such as `--stream` and `--output-schema` before `-P`, because the argument immediately after `-P` is treated as the prompt.

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
cat error.log | agav -P "explain the failure"
agav --stream -P "review the current diff"
```

Print mode accepts cwd-relative `@file` mentions, but it does not add dynamic repository context such as git state, project instructions, memories, or skills.

## Run mode

| Command | Intent |
| --- | --- |
| `agav run "<prompt>"` | Run a one-shot, repository-aware agent task with streamed output. |
| `agav run --max-turns <count> "<prompt>"` | Limit the number of internal model/tool iterations available to the task. |
| `agav run --permission '<json>' "<prompt>"` | Supply an explicit JSON tool-permission policy. |

`agav run` includes dynamic repository context and streams output, making it suitable for agent-style CI work:

```bash
agav run "review src for security issues"
agav run --max-turns 20 "fix the type errors"
```

Non-interactive runs auto-accept tools by default, so use `--permission` or `AGAV_PERMISSION` to narrow what CI jobs can do.

Control tools with JSON permissions or `AGAV_PERMISSION`:

```bash
agav run --permission '{"*":"deny","read_file":"allow","grep_search":"allow"}' "audit the code"
```

An explicit `"*":"deny"` creates a true allowlist. If a policy contains deny rules without `"*":"deny"`, Agav falls back to broad `deny-writes`-style blocking rather than fine-grained per-tool deny behavior. `--permission` and `AGAV_PERMISSION` apply to `agav run` only, not to `agav -P`.

You can also use the normal selection flags in non-interactive mode, including `--provider`, `--model`, `--effort`, `--openai-api`, and the Ollama connection flags.

## Structured output

| Command | Intent |
| --- | --- |
| `agav --output-schema @<path> -P "<prompt>"` | Require the final answer to match a JSON Schema file in the current directory. |
| `agav --output-schema '<json>' -P "<prompt>"` | Require the final answer to match an inline JSON Schema. |

Require final stdout to match JSON Schema:

```bash
agav --output-schema @schema.json -P "list risky dependencies"
agav --output-schema '{"type":"object","required":["summary"]}' -P "summarize"
```

`--output-schema` is print-mode only. Schema mode buffers output even when `--stream` is present. Agav validates JSON, retries once with correction instructions, then prints only the validated JSON value. Invalid schemas, provider errors, or output that remains invalid return exit code `1`; success returns `0`.

Keep secrets in environment variables and use an appropriately narrow tool policy for CI jobs.
