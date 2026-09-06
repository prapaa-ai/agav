---
title: Compose Agents, Skills, and Tools
description: Give reusable guidance, short checks, and delegated work separate roles
guideLevel: advanced
order: 4
---

# Compose Agents, Skills, and Tools

Combine capabilities when one task has reusable rules, quick local checks, and independent investigations.

## Scenario: review a counter.py change

A change to `counter.py` can affect how `main.py` calls it, what `state.json` contains, and whether tests still pass.

```text
Review the proposed change to @counter.py.

- Use the module-review skill for the standard module checks.
- Directly inspect @main.py for how it calls increment() and reset().
- Delegate one read-only subagent to inspect @tests/test_counter.py and check whether the new behavior is covered.
- Delegate another read-only subagent to inspect @greeting.py and confirm the count parameter contract is unchanged.

Do not edit files. Return one prioritized report describing any downstream risk.
```

This division keeps responsibilities clear:

| Layer | Responsibility |
| --- | --- |
| Skill | Repeatable module-review procedure |
| Main prompt | This change, its paths, and the required report |
| Direct tools | Small checks needed in the main conversation |
| Subagents | Independent downstream investigations |

Ask the main agent to reconcile the results before starting an implementation phase. Keep temporary repository paths in the prompt, not in a global skill.

## Expected result

You get one review that covers the counter module and every downstream consumer without making each worker inspect the whole repository.

Next: [Automate with Loops, Watch, and Schedules](/guides/scheduler).
