# Manual Test Plan for Cost Optimization

Covers only behavior that ships in the current build.

## Prerequisites
1. Check out this branch and `pnpm build` (or run via `pnpm start`).
2. Configure an Anthropic model (caching is Anthropic-native).

## Test 1: History prefix caching produces cache reads
**Steps**
1. Start a session and run 4–5 turns so history exceeds ~1024 tokens.
2. Watch the per-turn usage (cache read / cache write token counts).

**Expected**
- The first substantial turn shows cache **write** tokens.
- Subsequent turns show large cache **read** token counts (history prefix
  billed at 0.1×), with only the newest turn as fresh input.
- Total input cost per turn stops scaling linearly with history size.

## Test 2: Short conversations are not cached
**Steps**
1. Start a fresh session and send a single short message.

**Expected**
- No cache write for the history prefix on the very first exchange (below the
  1024-token minimum). System/tool caching may still apply.

## Test 3: Context editing (tool-result clearing)
**Steps**
1. In a session, read several large files (>2KB each) via `read_file` across
   many turns until the conversation crosses ~50% of the model's window.
2. Continue for a few more turns.

**Expected**
- A `Context trimmed: cleared ~N tokens of old tool output` system line appears.
- Older tool outputs are replaced with a placeholder naming the tool (e.g.
  "was output of `read_file` ..."); the most recent ~4 results stay full.
- The model can still re-run a tool to recover cleared data if it needs it.
- Clearing does not fire on every turn (it batches at a threshold).

## Test 4: Cheap compaction summarizer
**Steps**
1. Grow a session to 20+ turns with edits and at least one error.
2. Run `/compact`.

**Expected**
- Summary is concise (~300 words) and preserves all file paths, function names,
  and error messages.
- Summarizer uses `effort: low` and `maxTokens: 1024` internally.
- Session continues correctly after compaction.

## Test 5: Automatic internal-call routing
**Steps**
1. Use an Anthropic Sonnet model as your main model.
2. Grow a session until it auto-compacts (or run `/compact`).
3. Inspect provider logs / usage for the summarization call.

**Expected**
- The summarization request goes to the fast tier (`claude-haiku-4-5`), not
  Sonnet.
- Your main conversation turns still run on Sonnet.
- Setting `{ "autoRouteInternal": false }` sends summaries back to the main model.

## Test 6: Automatic per-turn routing (opt-in)
**Steps**
1. Set `{ "autoRouteTurns": true }` and use a Sonnet main model.
2. Ask a trivial lookup: "what is a closure?"
3. Then ask an action turn: "refactor the auth module".

**Expected**
- The trivial turn's request goes to the fast tier (`claude-haiku-4-5`).
- The action turn stays on Sonnet.
- With `autoRouteTurns` unset/false, both turns stay on Sonnet.
- If a routed simple turn spawns tool calls, the continuation uses Sonnet.

## Test 7: Summarization result caching
**Steps**
1. Grow a session and run `/compact`.
2. Without adding any new messages, run `/compact` again.

**Expected**
- The second `/compact` returns effectively instantly with the same summary.
- No new summarization provider call / token usage is recorded for it.

## Test 8: Token budget warning
**Steps**
1. Add `{ "tokenBudget": 5000 }` to `~/.agav/config.json`.
2. Run a session until cumulative tokens exceed ~4000 (80%).

**Expected**
- A single `⚠️ Token budget` thinking message appears suggesting `/compact`.
- It fires once, not every turn, and never blocks the session.

## Sign-off
Confirm Tests 1–8 pass and that cache-read tokens dominate input on follow-up
turns of a long Anthropic session.
