# Review: PR #286 — feat(cost-optimization): add token saving optimizations

**Reviewer:** Agav
**Branch under review:** `cost-optimization-safe` (PR #286 targets beta)
**Scope:** +171 / −9 across `loop.ts`, `conversation.ts`, `compact.ts`, `config.ts`, `providers/types.ts`, docs, tests.

---

## TL;DR

The PR bundles **seven** claimed optimizations. Only **three** are genuinely safe and effective
(compact prompt shortening, effort=low for summaries, tokenBudget config field). The rest are
either **dead code**, **incorrect**, or **risky**:

| # | Change | Verdict | Notes |
|---|--------|---------|-------|
| 1 | Short summarizer prompt + `effort: "low"` + `maxTokens 2048→1024` in `compact.ts` | ✅ SAFE, KEEP | Real input+output token savings. But only applied to `compact.ts`, not the duplicate in `loop.ts`. |
| 2 | `compressMessages()` in `conversation.ts` | ⚠️ RISKY | Mutates message text in place, collapsing ALL whitespace. Corrupts code blocks, diffs, stack traces. Runs on every `compactIfNeeded` call. |
| 3 | Tool output truncation | ❌ NOT IMPLEMENTED | Described in docs; no code. `trimToolResults` already existed pre-PR. |
| 4 | Summarization + system-prompt caching | ❌ NOT IMPLEMENTED | Docs claim it; no cache code exists. |
| 5 | `tokenBudget` config field | ✅ SAFE, but INERT | Field added; nothing reads it. No warnings emitted. |
| 6 | `complete?()` on `LLMProvider` | ⚠️ DEAD CODE | Optional method, zero implementations, zero callers. |
| 7 | Incremental context hashing (`hashMessages`) | ❌ BROKEN/DEAD | Function defined in `loop.ts`, never called. `lastMessagesHash` written never. Hash keys on `role + content.length` only — would skip real turns if wired up. |

**Recommendation:** Do NOT merge as-is. Cherry-pick #1 (extend to loop.ts) and #5 (wire it up).
Reject #2 (data corruption), #6/#7 (dead code), and the doc claims for #3/#4 (false — describe behavior that doesn't exist).

---

## Comparison with Codex and Claude Code

How the two reference agents actually reduce token cost, and how this PR measures up:

### Prompt caching (the single biggest lever)
- **Claude Code** relies on Anthropic **prompt caching**: the system prompt + tool
  definitions + stable conversation prefix are marked with `cache_control` breakpoints.
  Cache reads are ~10% the cost of fresh input tokens. This is where the bulk of Claude
  Code's savings come from — not from shortening prompts.
- **Codex** similarly leans on the provider's automatic prefix caching (OpenAI caches
  identical prompt prefixes ≥1024 tokens automatically) and keeps the system/tool prefix
  byte-stable so it stays cacheable.
- **This PR:** claims "system prompt caching" in docs but implements **none**. Agav already
  reports `cacheReadTokens`/`cacheWriteTokens`, so the plumbing exists — the real win would
  be adding `cache_control` breakpoints in the Anthropic provider. The PR misses this entirely.

### Conversation compaction / summarization
- **Claude Code** auto-compacts near the context limit with a structured summary, preserving
  file paths and state — essentially what Agav's *existing* `compactIfNeeded` + structured
  summarizer prompt already does.
- **Codex** trims/rolls the transcript and summarizes.
- **This PR:** shortening the summarizer prompt (#1) is directionally aligned with both, and
  `effort: "low"` is a sensible, safe knob. This is the one change that matches best practice.
  ⚠️ But note: shortening the prompt too aggressively (300-word cap) risks dropping the
  file-path/error preservation that makes resumed sessions work — the existing longer prompt
  exists for a reason (see the comment block in `compactIfNeeded`).

### Tool-output / context trimming
- Both reference agents truncate large tool results and keep only recent ones full.
- **Agav already does this** via `trimToolResults(targetTokens, preserveRecent)` (pre-PR).
  The PR's docs describe this as a new feature — it is not. No new trimming code is added.

### Whitespace collapsing
- Neither Codex nor Claude Code collapse whitespace inside message content. It's a
  micro-optimization (10-20% is wildly overstated for real transcripts) that **destroys
  the semantics of code, diffs, and terminal output**. Both reference agents preserve
  content fidelity precisely because the model needs exact bytes to edit files.
- **This PR's #2 is an anti-pattern** relative to both references.

**Bottom line vs. references:** The PR chases small/false wins (whitespace, dead hashing)
and skips the large real win both Codex and Claude Code depend on: **provider prompt caching**.

---

## Detailed findings

### #2 `compressMessages()` — data-corruption risk (BLOCKER)
```ts
block.text = block.text.replace(/\s+/g, " ").trim();
```
- Applied to **every** text block of **every** message on **every** `compactIfNeeded` call
  (including the non-forced auto-check that runs each loop iteration).
- `\s+ → " "` flattens newlines and indentation. A message containing a code snippet, a
  unified diff, or a stack trace is irreversibly mangled *in the live history*, then sent to
  the model and persisted to the session file.
- The model then edits files based on corrupted context → wrong edits.
- The 8000-char cap silently drops the tail of any long legitimate message.
- **Verdict:** reject. If whitespace trimming is wanted at all, it must (a) only touch the
  *dropped* half being summarized, never the kept history, and (b) never collapse newlines
  inside fenced/code content.

### #7 `hashMessages()` — dead + would be wrong if wired
```ts
const simple = msgs.map(m => `${m.role}:${m.content?.length ?? 0}`).join("|");
```
- `lastMessagesHash` is declared and never assigned; `hashMessages` is never called → dead code.
- Even if wired: hashing on `role + block-count` collides constantly. Two different user
  messages with one text block each hash identically → the "skip provider call" it advertises
  would drop real turns. This cannot be shipped even as a future hook.

### #6 `complete?()` — speculative dead code
- Optional method, no provider implements it, nothing calls it. "Future-proofing" that adds
  surface area with zero current value. Prefer adding it in the PR that uses it.

### #5 `tokenBudget` — inert
- Added to `AgavConfig`. Nothing reads it; no 80%/100% warnings exist despite the docs and
  manual test plan asserting `⚠️`/`🚨` events. The manual test plan (Tests 4–7) describes
  behavior that does not exist and would fail if actually run.

### Docs accuracy (BLOCKER for docs)
- `docs/COST_OPTIMIZATION.md` and `docs/MANUAL_TEST_COST_OPTIMIZATION.md` assert caching,
  truncation with a specific marker string, budget warnings, and context-hash skipping — all
  **unimplemented**. Shipping docs that describe non-existent features is worse than no docs.

### Tests
- The staged `cost-optimization.test.ts` was reduced to two trivial assertions
  (`tokenBudget === 1000` on a literal, `typeof msgs === "object"`). These test nothing about
  the PR. The PR's original whitespace test relied on `compressMessages` (the risky #2).
- Net: the PR is effectively **untested**.

---

## Safe subset to implement

1. **Shorten summarizer prompt + `effort: "low"` + `maxTokens: 1024`** — apply to BOTH
   `compact.ts` AND the duplicate summarizer in `loop.ts` (the PR only touched `compact.ts`).
   Keep the explicit instruction to preserve file paths / function names / error messages so
   resumed sessions don't break.
2. **`tokenBudget` config field** — keep it, and either wire a real warning or clearly mark
   it as reserved (don't ship docs claiming warnings that don't fire).

Everything else: drop from this PR. The high-value follow-up is **provider prompt caching
(`cache_control`)**, which is what actually makes Claude Code / Codex cheap.
