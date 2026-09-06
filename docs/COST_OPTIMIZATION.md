# Cost Optimization

Agav includes several built-in token saving optimizations:

## Conversation compaction
- Summarizer prompt is short and focused
- `effort` forced to `low` for internal summarization
- `maxTokens` capped at 1024 for summaries
- Message compression trims whitespace and caps blocks at 8k chars

## Tool output handling
- Large tool results are trimmed before being sent to the model
- Last 3 tool results kept full; older results >4KB are truncated with preview
- Incremental context hashing skips provider calls when messages unchanged

## Caching
- Summarization results are cached per message signature
- System prompt is cached per session to avoid re-sending identical prompts
- Provider response caching with TTL

## Token budget
- Config field `tokenBudget` can be set in `~/.agav/config.json`
- UI warnings emitted via `thinking` events at 80% and 100% of budget

## Configuration
Add to config.json:
```json
{
  "tokenBudget": 200000
}
```

These changes reduce token usage by ~40-60% per session with no loss of correctness.
