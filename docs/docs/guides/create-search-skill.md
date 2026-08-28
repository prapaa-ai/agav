---
title: Author and Evolve a Skill
description: Turn a repeated repository review into a reusable procedure
guideLevel: advanced
order: 3
---

# Author and Evolve a Skill

Use a skill when you repeat the same procedure across several tasks.

## Scenario: review provider scrapers consistently

Create `.agav/skills/scraper-review/SKILL.md` in the tracker repository:

```markdown
---
name: scraper-review
description: Review a provider scraper against tracker conventions
version: 1.0.0
invocation: user
allowed-tools:
  - read_file
  - grep_search
  - find_files
---

# Scraper Review

1. Read the supplied scraper and `scraper/base.py`.
2. Find its registration in `scraper/__init__.py`.
3. Check date parsing, missing values, status, and deduplication.
4. Return a table with risk, evidence path, and recommendation.
5. Do not edit files.
```

Restart Agav, then run the skill manually:

```text
/scraper-review @scraper/openai_scraper.py
```

`invocation: user` keeps the workflow predictable: it runs only when you call it. The tool allowlist also keeps the review read-only.

## Improve it from real use

Inspect its configuration and usage:

```text
/skills info scraper-review
```

After several runs, change one instruction when you see a repeated problem—for example, add a replacement-model check if reviews keep missing it. Keep project skills in source control and review instruction changes like code.

## Expected result

Every provider review follows the same checks and produces the same compact report format.

Next: [Compose Agents, Skills, and Tools](/guides/agent-skill-tool-combinations).
