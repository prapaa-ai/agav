---
title: Operate a Long-Running Task
description: Break a large repository change into reviewable phases
guideLevel: advanced
order: 9
---

# Operate a Long-Running Task

Long tasks stay manageable when discovery, implementation, and review have explicit boundaries.

## Scenario: add a greeting history feature to hello-agav

Give Agav the outcome, source of truth, constraints, and checkpoints. This keeps the research, repository edits, tests, and documentation in one auditable workflow:

```text
plan: add a greeting history feature to hello-agav.

First, inspect the existing project structure — main.py, greeting.py, counter.py,
and tests/ — to understand the current state.json format and module responsibilities.

Then propose a history.py module that logs each greeting (timestamp, name, count)
to a history.json file. Preserve the existing counter and greeting behavior.

Work in these phases:
1. inspect the existing modules and understand the data flow
2. propose the history module design, file format, and affected files; stop for my approval
3. implement history.py and integrate it into main.py
4. add focused tests for the new history behavior
5. run the existing tests to confirm nothing is broken
6. update README.md to document the --history flag
7. show the final diff, test output, and any remaining uncertainty

Do not push or publish changes.
```

The first phase deliberately requires reading the existing code before implementation: this makes the new feature consistent with the established patterns in the project.

### Add a task-specific skill

For a task that will recur, add a project skill before starting. Its clear description lets Agav automatically select it when a prompt mentions greeting history or logging; you can also invoke it explicitly.

Create `.agav/skills/greeting-history/SKILL.md`:

```markdown
---
name: greeting-history
description: Add and maintain a greeting history feature for hello-agav
version: 1.0.0
invocation: both
allowed-tools:
  - read_file
  - write_file
  - grep_search
  - find_files
  - run_command
---

# Greeting history workflow

1. Inspect existing modules (main.py, greeting.py, counter.py) and understand data flow.
2. Design history.py to log each greeting with timestamp, name, and count to history.json.
3. Follow existing module patterns — keep history.py independent, accept a configurable path.
4. Add focused tests using tmp_path fixtures, matching the style of test_counter.py.
5. Run the full test suite before reporting completion.
6. Report changed paths, test output, and any design decisions.
```

Restart Agav after creating the skill. Use the same task through the explicit skill command when you want to guarantee the procedure is applied:

```text
/greeting-history add a history feature that logs each greeting to history.json
```

### Add a deterministic check plugin

Use a local plugin for a mechanical check rather than relying on the model to visually compare output. Create `~/.agav/plugins/check-history-entries.mjs` (`%USERPROFILE%\.agav\plugins\check-history-entries.mjs` on Windows):

```javascript
import fs from "node:fs";
import path from "node:path";

export default {
  schema: {
    name: "check_history_entries",
    description: "Confirm the greeting history file contains expected entries",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name to check for in history" }
      },
      required: ["name"]
    }
  },
  async execute(input) {
    const root = process.cwd();
    const historyPath = path.join(root, "history.json");
    if (!fs.existsSync(historyPath)) {
      return { output: "history.json does not exist yet.", isError: true };
    }
    const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    const matching = history.filter((entry) => entry.name === input.name);
    return {
      output: matching.length > 0
        ? `Found ${matching.length} greeting(s) for "${input.name}".`
        : `No greetings found for "${input.name}" in history.json.`,
      isError: matching.length === 0
    };
  }
};
```

Restart Agav and verify that `/debug` lists `check_history_entries`. After implementing the history feature, prompt Agav:

```text
Run the CLI with --name Alice twice, then use check_history_entries with name "Alice".
If it reports no entries, inspect history.py; do not claim the task is complete until the check passes.
```

Check progress with `/plan`. If a requirement changes, steer future work without discarding completed investigation:

```text
/steer limit history.json to the most recent 100 entries
```

Use subagents only for independent work — for example, one can review the history module while another updates the README. Keep the main agent responsible for the shared integration, edits, tests, and final diff.

Before implementation, review the proposed design. Before completion, review changed paths, test output, and unresolved assumptions. Use `/compact` if the conversation becomes long; save memory only for a durable decision that should affect later sessions.

## Expected result

The greeting history feature progresses through visible phases, pauses before edits, and ends with a well-tested module, updated README, and a deterministic check that the history file contains the expected entries.

Next: [Planning and Steering](/workflows/planning-and-steering), [Author and Evolve a Skill](/guides/create-search-skill), and [Create a Local Plugin](/guides/plugins).
