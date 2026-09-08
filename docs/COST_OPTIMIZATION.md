# Cost Optimization — Engineering Notes

> **Internal / contributor doc.** This file documents the implementation with
> `source/...` references. The user-facing guide lives at
> `docs/docs/guides/reduce-token-cost.md` (published to docs.agav.dev).

Agav reduces LLM token cost through provider-native prompt caching and a cheap
compaction path. Everything below is implemented and verified — no speculative
features.

## 1. Conversation-history prefix caching (biggest lever)

In a multi-turn agent loop, every request re-sends the entire conversation
history as input. Without caching you pay full input price for all prior turns
on every single step.

Agav marks a **rolling `cache_control` breakpoint** on the conversation history
for Anthropic models (`withHistoryCacheBreakpoint` in
`source/providers/anthropic.ts`). The breakpoint is placed on the last content
block of the second-to-last message, so the cached prefix stays byte-identical
across the next request and scores a cache hit.

- Cache reads cost **0.1× the normal input token price** (a 90% discount).
- Cache writes cost 1.25× on the first turn (5-minute TTL), then amortize away.
- Short conversations (< 3 messages) are skipped — below Anthropic's ~1024-token
  minimum, caching is a no-op and would only add a write premium.

This stacks with the existing breakpoints on the **system prompt** and the
**tool list**, which Agav already caches.

## 2. Context editing (tool-result clearing)

The largest, fastest-growing part of a long agent session is accumulated tool
output — file reads, greps, fetches. Most of it is **re-fetchable**, so paying to
re-send it every turn is wasteful.

Agav clears stale tool results in place (`clearStaleToolResults` /
`shouldClearToolResults` in `source/agent/conversation.ts`):

- The most recent `keepRecentResults` tool results are kept **in full**.
- Older `tool_result` payloads above `minClearChars` are replaced with a compact
  placeholder that **names the tool and its input**, so the model can re-run it
  if it needs the data again.
- The `tool_use` record is never touched — tool_use / tool_result pairing stays
  valid for providers that enforce it.
- **Reversible (CCR).** Before replacing a result, the exact original is stashed
  in `clearedStore` (`source/agent/cleared-store.ts`) and the placeholder embeds
  a `retrieve` id. The built-in `retrieve` tool (`source/tools/retrieve.ts`)
  returns the original bytes on demand — lossless, no re-execution. The store is
  bounded (LRU) and process-scoped; on a miss the model re-runs the tool.

Anthropic's own benchmark for this pattern shows up to **~84% token reduction**
on long (100-turn) runs.

**Cache safety.** Rewriting a block invalidates the prompt-cache prefix from that
point on, so clearing every turn would trade a cache hit for a cache re-write.
Agav therefore batches: it only clears once the conversation crosses ~50% of the
window **and** has grown ~10% of the window since the last pass
(`shouldClearToolResults`). The loop runs this **before** the more expensive
summarize-and-drop compaction, reclaiming cheap tokens first.

Configure (enabled by default) in `~/.agav/config.json`:

```json
{
  "contextEditing": {
    "enabled": true,
    "keepRecentResults": 4,
    "minClearChars": 2000
  }
}
```

## 2b. JSON tool-result compression (SmartCrusher-style)

Large JSON tool outputs — arrays of similar objects (search results, directory
listings, API/MCP dumps) — are compressed as they arrive
(`compressJsonToolResult` in `source/agent/json-compressor.ts`), before being
stored in history. Pure TypeScript, no dependencies, no model.

- Detects a compressible array (root array, or the largest array-of-objects
  field of a root object) and only acts on payloads ≥ `minChars` with ≥
  `minArrayItems` items.
- Keeps the **informative** items: first/last `keepBoundary`, anything that looks
  like an error (`error`/`status: error`/`fatal`…), and length outliers
  (> mean + 2σ). The redundant middle collapses to one `__compressed__` marker
  that states how many items were dropped and how to get more.
- Output stays **valid JSON**. Only compresses when it actually shrinks the
  payload; never grows it. Error results are never compressed.
- Applied to the **stored** `toolResult` only — the UI still receives the full
  output via the `tool_result` event.

Repetitive JSON commonly shrinks 60–90%. Rides under the `contextEditing`
umbrella; disable with `{ "contextEditing": { "compressJson": false } }`.

## 2c. Output-token reduction

Output tokens cost several times input. Two cache-safe levers
(`source/agent/output-reduction.ts`), both on by default:

- **Verbosity steering** (`applyVerbositySteering`) — appends a terse
  "be concise / don't restate context / don't re-print tool output" note to the
  **end** of the system prompt. Appending (not rewriting) keeps the cached prefix
  byte-stable. Idempotent.
- **Resume-turn effort routing** (`resolveTurnEffort` + `inspectLastToolResults`)
  — when a turn is the model resuming after tool output that had **no errors**,
  effort is clamped **down one notch** (never below `low`, never up). The user's
  own turn (iteration 0) and any turn whose latest tool output errored keep the
  configured effort. The final graceful-shutdown step keeps full effort too (it
  injects a prompt, so it isn't detected as a resume turn).

Wired in `source/agent/loop.ts`; configured via `outputReduction` and threaded
through both call sites. Disable with
`{ "outputReduction": { "enabled": false } }`.

## 3. Cheap compaction summarizer

When context fills up (or you run `/compact`), Agav summarizes and drops older
turns. The summarizer is tuned to be cheap:

- Concise prompt that still preserves every file path, function name, and error.
- `effort` forced to `low` for internal summarization.
- `maxTokens` capped at `1024` (was 2048).

Applied to both the automatic loop path (`source/agent/loop.ts`) and the manual
`/compact` command (`source/commands/compact.ts`).

## 4. Automatic model routing (internal calls)

Agav makes internal LLM calls that don't need the flagship model — most notably
**conversation summarization** during compaction. Faithful compression is a
cheap-model task; using the user's expensive model for it is waste.

Agav now routes these internal calls to the provider's **fast tier**
automatically (`resolveFastModel` in `source/agent/model-tiers.ts`):

- Anthropic → `claude-haiku-4-5`, OpenAI → `gpt-4o-mini`, Gemini →
  `gemini-3.5-flash-lite`, etc. (same table that backs `/fast` and `/deep`).
- The **user-facing model is never changed** — only internal summaries are
  rerouted. The actual coding turns stay on your chosen model.
- Providers without a static fast tier (Ollama, whose models are local) fall
  back to the current model, so the call always works.

Applies to both auto-compaction (`source/agent/loop.ts`) and the manual
`/compact` command. Turn it off with `{ "autoRouteInternal": false }` in
`~/.agav/config.json`.

Haiku is roughly **1/12th the price** of Sonnet, so a summary that cost, say,
$0.02 on the flagship costs well under a cent when routed — with no impact on the
main conversation's quality.

Manual routing is still available: `/fast`, `/deep`, and `/effort` let you move
the *whole* session between tiers when you know a stretch of work is simple or
hard.

### Optional: automatic per-turn routing

Agav can also classify each **user turn** and route confidently-simple ones
(short lookups, "what is…", "explain…") to the fast tier, while anything that
might touch code stays on your model. This is **opt-in** and off by default:

```json
{ "autoRouteTurns": true }
```

- Classification (`source/agent/task-classifier.ts`) uses a fast, dependency-free
  heuristic that **fails safe toward "hard"** — it only downgrades a turn when it
  is short, question-shaped, and free of code/error/action signals, above a high
  confidence bar (0.85 by default). Misrouting a hard task to a weak model is far
  more costly than paying full price for a simple one, so the bar is deliberately
  high.
- Routing applies **only to the user's own turn** (the first iteration). Once a
  tool cycle is running, Agav stays on your configured model — switching models
  mid-cycle would hurt output consistency and invalidate the prompt cache.
- **Bundled pure-TS model.** A logistic-regression classifier
  (`source/agent/linear-model.ts` over hashed n-gram features in
  `source/agent/text-features.ts`) is trained offline by
  `scripts/train-task-classifier.mjs` and shipped as
  `source/agent/task-classifier-weights.json`. It runs in pure TypeScript — no
  native runtime, no WASM, no network — so it works inside the `tsc` build and
  the `bun --compile` binary. `classifyWithModel` lazy-loads the weights and
  predicts P(hard); the heuristic (`classifyHeuristic`) is the safety gate that
  overrides a model "simple" verdict whenever it sees code/error/action signals.
  If the weights are missing or malformed, it falls back to the heuristic.
- **Routing entry point:** `resolveTurnModelAsync` (model) / `resolveTurnModel`
  (sync heuristic) in `source/agent/model-tiers.ts`. The interactive loop uses
  the async, model-backed version.
- **Retrain:** `pnpm train:classifier` (or `node scripts/train-task-classifier.mjs`).
  Feature extraction is duplicated in the script and the runtime; a held-out test
  in `agent.linear-model.test.ts` guards against the two drifting apart.
- **Dataset & how to improve accuracy:** see `docs/TASK_CLASSIFIER_DATASET.md`.

## 5. Summarization result caching

Compaction summaries are cached by a signature of the exact messages being
summarized plus the model (`source/agent/summary-cache.ts`). If the same drop
set is summarized again, the stored summary is returned with **no provider call**.

This helps in two real cases:
- **Error-recovery re-compaction / retries** in the agent loop — the loop caches
  per invocation.
- **Running `/compact` twice** on unchanged history — a module-level cache in the
  command returns the first summary instantly the second time.

Only non-empty summaries are cached (an empty result means the summarizer failed
and must be retried), and the cache is bounded (LRU eviction) so it never grows
without limit. It is never persisted across sessions.

## 5b. Measurement — `/cost`

`/cost` (`source/commands/cost.ts`) surfaces the savings the levers above
produce. It reads the session `tokenUsage` (already tracked: input, output,
cacheRead, cacheWrite) and estimates cost via `source/agent/pricing.ts`:

- Per-model rate table (Anthropic/OpenAI/Gemini families); cache reads billed at
  0.1× input, cache writes at 1.25× input.
- Reports token breakdown, cache hit rate, estimated $ cost, and the $ saved by
  caching vs. the no-cache counterfactual.
- Unknown models report "no price table entry" rather than a wrong number.

Estimates are clearly labeled approximate — there is no live price feed.

## 6. Token budget warning

Set a soft ceiling in `~/.agav/config.json`:

```json
{
  "tokenBudget": 200000
}
```

When cumulative input+output tokens cross **80%** of the budget, the loop emits a
single `thinking` warning suggesting `/compact`. It is advisory — it never blocks
or truncates.

## Cost impact

For a typical multi-turn coding session, the history prefix is by far the largest
and fastest-growing part of each request.

| Lever | Applies to | Typical saving |
|-------|-----------|----------------|
| History prefix caching | Every follow-up turn (Anthropic) | ~90% off the cached input tokens; in practice **~50–80% of total input cost** for long sessions, since the history dominates and is re-read every turn |
| System + tool caching | Every turn (already present) | ~90% off those (static) tokens |
| Context editing (tool-result clearing) | Long, tool-heavy sessions | up to ~84% on cleared payloads (Anthropic benchmark) |
| JSON tool-result compression | Turns returning large JSON arrays | ~60–90% on repetitive arrays; applied on arrival |
| Output reduction (verbosity + resume effort) | Every reply; resume-after-tool turns | Fewer output tokens (4–5× input cost) + lower reasoning cost on routine steps |
| Cheap summarizer | Each compaction | ~50% fewer summary output tokens, plus `effort: low` reduces reasoning cost per compaction |
| Auto model routing (internal calls) | Every summarization | Summaries run on the fast tier (~1/12th Sonnet's price); the user's coding model is unchanged |
| Auto per-turn routing (opt-in) | Confidently-simple user turns | Trivial lookups run on the fast tier; anything that might edit code stays on your model |
| Summarization result caching | Repeat/identical summaries | A cache hit is free — avoids re-summarizing the same drop set on retries or a second `/compact` |

Worked example — a 20-turn session with ~40k tokens of accumulated history:
- **Without history caching:** ~40k input tokens re-billed at full price every
  turn → ~800k input-token-equivalents over the session.
- **With history caching:** the 40k prefix is written once (~1.25×) then read at
  0.1× on the remaining turns → roughly **60–70% lower input-token cost** for the
  session, with identical model behavior.

Actual savings depend on session length, model, and cache TTL hits (the 5-minute
window is refreshed on every request, so an active session stays warm).

## Verification

`source/__tests__/cost-optimization.test.ts`:
- The Anthropic request carries the history breakpoint on the right message.
- Short conversations get no breakpoint.
- `tokenBudget` is a typed config field.
- Compaction still runs the cheap summarizer and preserves paths/errors.

`source/__tests__/agent.pricing.test.ts` and `source/__tests__/commands.cost.test.ts`:
- Rate lookup matches model families and returns null for unknown models.
- Cost = input + output + 0.1× cache read + 1.25× cache write; saving computed.
- `/cost` reports counts, hit rate, estimate, and saving; unknown model → no estimate.

`source/__tests__/agent.output-reduction.test.ts` and `source/agent/loop.test.ts`:
- Verbosity note is appended to the tail (prefix stable), handles undefined, is idempotent.
- Effort is lowered one notch only on a clean resume turn; never below low; kept on errors/fresh turns.
- The loop applies both: fresh turn keeps effort, clean resume lowers it, system prompt gains the note.

`source/__tests__/agent.json-compressor.test.ts` and `source/agent/loop.test.ts`:
- Non-JSON, small, and invalid payloads are left untouched.
- Large arrays compress to valid JSON keeping boundaries/errors/outliers.
- Compresses the largest array field of a root object; never grows a payload.
- The loop stores the compressed copy but yields the full output to the UI.

`source/__tests__/agent.ccr-retrieve.test.ts`:
- `ClearedStore` stores/retrieves originals and evicts oldest past capacity.
- The `retrieve` tool returns exact originals and errors helpfully on a miss.
- Round-trip: a cleared placeholder's `retrieve` id returns the exact original.

`source/__tests__/agent.context-editing.test.ts`:
- Older tool results are cleared; the most recent N are kept full.
- The placeholder names the tool so the model can re-fetch.
- tool_use / tool_result pairing is never broken.
- Clearing is idempotent, skips small results, and is gated on token pressure.

`source/__tests__/agent.model-tiers.test.ts` and `source/agent/loop.test.ts`:
- Every cloud provider has a fast and deep tier; no cross-provider leakage.
- `resolveFastModel` returns the cheap tier and falls back safely for Ollama.
- The compaction summarizer runs on the routed fast model while the turn stays
  on the user's model.

`source/__tests__/agent.summary-cache.test.ts`:
- Identical messages + model hash to the same signature; different content or
  model do not.
- Stored summaries are returned; empty summaries are never cached.
- The cache is bounded (LRU eviction) and refreshes recency on read.

`source/__tests__/agent.task-classifier.test.ts`, `agent.linear-model.test.ts`, `agent.model-tiers.test.ts`, `source/agent/loop.test.ts`:
- Heuristic: short lookups → simple; action/code/error turns → hard.
- Pure-TS model: features are deterministic, L2-normalized, fixed-dim; weights
  parse and reject malformed input; the bundled model generalizes to held-out
  phrasings (feature-parity guard).
- Safety gate: a model "simple" verdict is overridden to "hard" on code signals.
- `resolveTurnModel` / `resolveTurnModelAsync` are conservative: no routing when
  disabled, on hard turns, when already on the fast model, or for providers
  without a fast tier.
- The loop uses the routed model for the user turn but the main model for tool
  continuation.
