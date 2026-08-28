---
title: Compose Agents, Skills, and Tools
description: Give reusable guidance, short checks, and delegated work separate roles
guideLevel: advanced
order: 4
---

# Compose Agents, Skills, and Tools

Combine capabilities when one task has reusable rules, quick local checks, and independent investigations.

## Scenario: review a Bedrock scraper change

A change to `bedrock_scraper.py` can affect the shared data shape, generated README table, calendar, and Slack message.

```text
Review the proposed change to @scraper/bedrock_scraper.py.

- Use the scraper-review skill for the standard scraper checks.
- Directly inspect @scraper/base.py and @scraper/__init__.py for the shared contract and registration.
- Delegate one read-only subagent to inspect generators/readme_generator.py and generators/ics_generator.py.
- Delegate another read-only subagent to inspect generators/slack_notifier.py and .github/workflows/update-deprecations.yml.

Do not edit files. Return one prioritized report describing any downstream risk.
```

This division keeps responsibilities clear:

| Layer | Responsibility |
| --- | --- |
| Skill | Repeatable scraper-review procedure |
| Main prompt | This change, its paths, and the required report |
| Direct tools | Small checks needed in the main conversation |
| Subagents | Independent downstream investigations |

Ask the main agent to reconcile the results before starting an implementation phase. Keep temporary repository paths in the prompt, not in a global skill.

## Expected result

You get one review that covers the scraper contract and every downstream consumer without making each worker inspect the whole repository.

Next: [Automate with Loops, Watch, and Schedules](/guides/scheduler).
