---
title: Use Memory Across Sessions
description: Preserve a stable project decision and remove it when it changes
guideLevel: advanced
order: 6
---

# Use Memory Across Sessions

Use memory for verified facts that should influence future conversations, not for temporary task progress.

## Supported memory commands

| Command | Intent |
| --- | --- |
| `/remember <text>` | Save `<text>` as a durable project memory. |
| `/memory list` | List saved memories for the current project. |
| `/memory add <text>` | Save `<text>` as a project memory. |
| `/memory path` | Show where the current project's memories are stored. |
| `/memory delete <memory name>` | Remove the saved memory named `<memory name>`. |
| `/forget` | List memories so you can select one to remove. |
| `/forget <memory name>` | Remove the saved memory named `<memory name>`. |
| `/memory clear` | Remove every memory for the current project. |

## Scenario: preserve the project data contract

| Command | Intent |
| --- | --- |
| `/remember <text>` | Save the verified data contract as a durable project memory. |
| `/memory list` | Confirm that Agav saved the data contract. |
| `/memory path` | Find the project's memory directory when you need to inspect it. |

hello-agav persists its run counter in `state.json`. Save that stable convention:

```text
/remember counter.py reads and writes state.json with a {"count": N} shape. Any module that touches the counter must preserve this format and use the path parameter for testability.
```

Inspect the saved entry:

```text
/memory list
/memory path
```

Exit Agav, reopen it from the same Git repository, and ask:

```text
What must I preserve when changing how the run counter works?
```

Agav should recall the convention because memory is scoped from the Git repository root.

## Remove stale knowledge

| Command | Intent |
| --- | --- |
| `/forget` | List memories before choosing the outdated entry. |
| `/forget <memory name>` | Remove the specific outdated memory named `<memory name>`. |
| `/memory clear` | Remove all project memories when none should be retained. |

If the project changes its persistence format, list the memories and remove the outdated entry:

```text
/forget
/forget <memory name>
```

Replace `<memory name>` with the memory name shown in the list; for example, `/forget state-json-contract`. Use `/memory clear` only when every project memory should be removed. Do not save current plan steps, branch names, guesses, or one-off errors.

## Expected result

Future sessions begin with the verified data contract without carrying temporary work forward.

Next: [Sessions and Memory](/workflows/sessions-and-memory).
