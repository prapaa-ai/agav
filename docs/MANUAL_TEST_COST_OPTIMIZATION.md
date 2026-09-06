# Manual Test Plan for Cost Optimization

## Prerequisites
1. Checkout `cost-optimization` branch
2. Set `tokenBudget` in `~/.agav/config.json` e.g., `{"tokenBudget": 50000}`
3. Start Agav session

## Test 1: Summarizer Prompt Shortening
**Steps**
1. Start a long session with 20+ turns
2. Run `/compact`
3. Check logs for summarizer usage

**Expected**
- Summary is concise, max ~300 words
- No verbose section headers `## Task`, `## Changes Made` etc.
- Token usage for compaction is lower than baseline

## Test 2: Message Compression
**Steps**
1. Create a message with extra whitespace: `"  hello   world  \n\n\n"`
2. Trigger compaction

**Expected**
- Whitespace collapsed to single spaces
- Text length capped

## Test 3: Tool Output Truncation
**Steps**
1. Read a large file >10KB via `read_file`
2. Continue conversation for 5 more turns
3. Inspect token usage

**Expected**
- Older tool results truncated with `... [truncated for token savings] ...`
- Recent 3 tool results remain full
- Session stays under context window without errors

## Test 4: Summarization Cache
**Steps**
1. Trigger compaction twice in same session without new messages
2. Observe usage events

**Expected**
- Second compaction returns cached summary instantly
- No new provider call emitted

## Test 5: System Prompt Caching
**Steps**
1. Start session, note first turn token usage
2. Continue for 5 turns, compare per-turn input tokens

**Expected**
- System prompt not re-sent verbatim each turn
- Input token growth is linear with user messages only

## Test 6: Token Budget Warning
**Steps**
1. Set `tokenBudget: 5000`
2. Generate long conversation

**Expected**
- UI shows `⚠️ Token budget warning` at ~80%
- UI shows `🚨 Token budget exceeded` after 100%
- Warnings appear as `thinking` events below

## Test 7: Incremental Context Hashing
**Steps**
1. Send a message, let model respond
2. Send same message again without changes
3. Observe provider calls

**Expected**
- Second identical turn skips provider call
- `[context unchanged, skipping provider call]` thinking event emitted

## Sign-off
Tester should confirm all 7 tests pass and token usage is visibly lower than main branch baseline.
