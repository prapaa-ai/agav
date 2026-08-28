---
title: Coordinate Parallel Subagents
description: Split a larger review into independent investigations
guideLevel: advanced
order: 2
---

# Coordinate Parallel Subagents

Use subagents when independent investigations need more context than a few tool calls.

## Scenario: audit every provider scraper

The tracker has separate implementations for OpenAI, Anthropic, Google, and AWS. They can be reviewed independently, then compared against the shared `DeprecationEntry` contract.

```text
Audit the provider scrapers with three parallel subagents:

- Review scraper/openai_scraper.py and scraper/anthropic_scraper.py.
- Review scraper/vertex_scraper.py and scraper/gemini_scraper.py.
- Review scraper/bedrock_scraper.py.

Each subagent must:
- compare its scrapers with scraper/base.py
- report date parsing, deduplication, and missing-data risks
- cite file paths
- make no edits

After they finish, combine the findings into one prioritized report.
```

Each assignment includes its files, checks, output, and no-edit constraint because subagents work independently and cannot ask follow-up questions.

## Review the combined result

Use `Tab` to inspect active subagents. Sensitive confirmations still appear in the main terminal.

When all workers finish, ask the main agent to resolve disagreements and remove duplicate findings. Delegate edits only when workers own different files; worktrees reduce interference but do not make overlapping changes safe.

## Expected result

You receive three bounded audits and one reconciled list of scraper risks, while the main conversation retains final ownership.

