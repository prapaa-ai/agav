---
title: Reduce Token Cost
description: Cut LLM spend with caching, context editing, model routing, and budgets
order: 20
---

# Reduce Token Cost

Long agent sessions spend most of their tokens re-sending the same growing
context on every turn. Agav ships several optimizations that cut that cost
without changing the model that writes your code. Most are on by default.

## Quick start

Most optimizations need no configuration. To tune or opt in, add fields to
`~/.agav/config.json`:

```json
{
  "contextEditing": { "enabled": true, "keepRecentResults": 4, "minClearChars": 2000 },
  "autoRouteInternal": true,
  "autoRouteTurns": false,
  "tokenBudget": 200000
}
```

## What Agav does

### 1. Prompt caching

Providers can bill a repeated prompt prefix at a fraction of the normal input
price. Agav keeps the prefix stable and, where the provider needs explicit
markers, adds them.

- **Anthropic** — Agav marks cache breakpoints on the system prompt, the tool
  list, and a rolling point in the conversation history, so the whole prefix
  bills as a cache read (about a 90% discount) on every follow-up turn. Short
  conversations are skipped (below the provider's minimum, caching is a no-op).
- **OpenAI, OpenRouter, Azure/compatible** — these providers cache identical
  prompt prefixes automatically server-side; Agav keeps volatile per-turn text
  at the tail so the stable prefix keeps hitting the cache. Cache-read tokens are
  reported in usage.
- **Gemini / Vertex AI** — benefit from stable-prefix reuse where the model
  supports it.

The single most important thing you can do to help caching: **don't change the
system prompt or tool set mid-session**, and let Agav append per-turn context at
the tail (it already does).

### 2. Context editing (tool-result clearing)

The fastest-growing part of a long session is accumulated tool output — file
reads, greps, fetches — most of which is re-fetchable. Agav replaces older tool
results with a compact placeholder that names the tool and its input. The most
recent results stay in full, and the tool-call record is preserved.

The original text is kept locally (reversible compression), and the placeholder
includes a `retrieve` id. If the model needs the exact data again it calls the
built-in `retrieve` tool to get the original bytes back — no need to re-run the
tool. If the original has been evicted (or the session was resumed), `retrieve`
says so and the model re-runs the tool instead.

It batches this work at a token threshold rather than every turn, so it does not
repeatedly invalidate the prompt cache. Configure with `contextEditing`.

Agav also **compresses large JSON tool results** as they arrive. Output like
search results or directory listings — arrays of similar objects — is reduced by
keeping the informative items (errors, statistical outliers, and the first/last
few) and replacing the redundant middle with a short marker that states how many
items were omitted. The result stays valid JSON, and the full output is still
shown to you in the terminal; only the copy stored in history is compressed.
Repetitive JSON commonly shrinks 60–90%. Turn it off with
`{ "contextEditing": { "compressJson": false } }`.

### 3. Cheap, cached compaction

When context fills up (or you run `/compact`), Agav summarizes and drops older
turns using a short prompt at low reasoning effort, and caches the result so a
repeat compaction on unchanged history is free.

### 4. Model routing

- **Internal calls** (conversation summaries) are routed to the provider's cheap
  model tier automatically. Your coding model is never changed. Disable with
  `"autoRouteInternal": false`.
- **Per-turn routing (opt-in)** — with `"autoRouteTurns": true`, Agav classifies
  each user turn and routes confidently-simple ones (short lookups, "what is…")
  to the cheap tier. Anything that might edit code stays on your model, and once
  a tool cycle is running Agav stays on your model. Off by default because
  misrouting a hard task to a weak model degrades output. Classification uses a
  small logistic-regression model that ships with Agav and runs in **pure
  TypeScript inside the binary** — no native runtime, no network — with a
  heuristic safety gate that keeps "hard" whenever the text mentions code,
  errors, or an action verb.
- **Manual routing** — `/fast`, `/deep`, and `/effort` move the whole session
  between tiers when you already know the work is simple or hard.

### 5. Output-token reduction

You pay for what the model *writes back* too, and output tokens cost several
times input. Agav trims two kinds of waste, both cache-safe:

- **Verbosity steering** — a short "be concise, don't restate context" note is
  appended to the *end* of the system prompt (the cached prefix is unchanged), so
  replies skip preambles and don't re-print visible file/tool output.
- **Resume-turn effort routing** — when a turn is just the model continuing after
  clean tool output (a file read, a passing test), reasoning effort is lowered
  one notch. Your own new turns keep full effort, and any turn whose latest tool
  output contained an **error** keeps full effort so hard debugging is never
  starved.

On by default. Disable either with
`{ "outputReduction": { "verbositySteering": false, "resumeEffortRouting": false } }`.

### 6. Token budget

Set `tokenBudget` to a soft ceiling. At 80% of it, Agav shows a one-time warning
suggesting `/compact`. It is advisory and never blocks.

## Measuring savings

Run `/cost` at any time to see the current session's token usage broken down by
input, output, and cache read/write, plus:

- An **estimated dollar cost** for your current model (approximate — providers
  change prices and Agav has no live price feed).
- A **cache hit rate** for the input side.
- How much **prompt caching saved** versus paying full price for those tokens.

Because cache reads bill at ~10% of input, a healthy long session shows cache
reads dominating the input side and a large reported saving.

## What to expect

Savings scale with session length and how much repeated context and tool output
you accumulate. On long, tool-heavy coding sessions the combined effect is
typically a large reduction in input-token cost, with no change to output
quality — the model that writes your code is unchanged unless you opt in to
per-turn routing for trivial questions.

Short, prose-only exchanges see little benefit: there is little repeated context
to cache and little tool output to clear.

## See also

- [Configuration](/reference/configuration) — all cost-related fields.
- [Providers](/getting-started/providers) — model tiers and provider caching.
- [Slash Commands](/reference/slash-commands) — `/compact`, `/fast`, `/deep`, `/effort`.
