---
title: Run Tools in Parallel
description: Inspect independent parts of a repository at the same time
guideLevel: advanced
order: 1
---

# Run Tools in Parallel

Use parallel tools for short, independent checks that belong in the same conversation.

## Scenario: map the tracker before changing a scraper

Before editing a provider scraper, you need to understand three separate parts of the project:

- where scrapers are registered
- the shape stored in `data/deprecations.json`
- how calendar events are generated

Ask Agav to inspect them together:

```text
Inspect these parts of the repository in parallel:

1. Read @scraper/__init__.py and list the registered providers.
2. Read @scraper/base.py and @data/deprecations.json and summarize the entry shape.
3. Read @generators/ics_generator.py and explain which entries become calendar events.

Do not edit files. Combine the results into one short data-flow summary.
```

Agav can run independent reads and searches concurrently, then return the evidence to the same conversation.

## Keep dependencies in order

Do not parallelize steps when one changes what the next step reads. State the order explicitly:

```text
First update the provider registry. After that edit succeeds, inspect the final registry and generated outputs.
```

Keep overlapping edits and state-changing commands sequential. Use [parallel subagents](/guides/parallel-agents) when each investigation is large enough to need its own context.

## Expected result

You get one concise map of the scraper registry, shared data shape, and calendar output without waiting for each independent read in sequence.

Next: [Coordinate Parallel Subagents](/guides/parallel-agents).
