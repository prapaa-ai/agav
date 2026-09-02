---
title: Operate a Long-Running Task
description: Break a large repository change into reviewable phases
guideLevel: advanced
order: 9
---

# Operate a Long-Running Task

Long tasks stay manageable when discovery, implementation, and review have explicit boundaries.

## Scenario: add the Azure Foundry deprecation scraper

Give Agav the outcome, source of truth, constraints, and checkpoints. This keeps the web research, repository edits, tests, and generated documentation in one auditable workflow:

```text
plan: add an Azure Foundry deprecation scraper to model-deprecation-tracker.

First, use web search to find Azure Foundry's official deprecation or lifecycle page.
Open the official result, record its URL and the fields it publishes, and do not use
search-result summaries as source data.

Then inspect the shared scraper contract and two existing provider scrapers. Propose
the Azure Foundry field mapping, parsing rules, and affected outputs before editing.
Preserve the DeprecationEntry shape and the JSON, README, calendar, and Slack outputs.

Work in these phases:
1. web-search and open the official Azure Foundry deprecation page
2. inspect the shared contract and existing scrapers
3. propose the mapping, test approach, and affected files; stop for my approval
4. implement and register the scraper
5. add focused tests for the new parsing behavior and run the repository's relevant verification
6. run the generation command, inspect the README diff, and use check_deprecation_readme
   to confirm each generated Azure Foundry entry is present in README.md
7. show the source URL, final diff, verification output, and any remaining uncertainty

Do not publish, push, or change external systems.
```

The first phase deliberately requires the official page before implementation: this makes the scraper traceable to a source that can be rechecked when Azure changes its policy.

### Add a task-specific skill

For a task that will recur, add a project skill before starting. Its clear description lets Agav automatically select it when a prompt mentions Azure Foundry deprecations, a scraper, or generated README data; you can also invoke it explicitly.

Create `.agav/skills/azure-foundry-deprecation/SKILL.md`:

```markdown
---
name: azure-foundry-deprecation
description: Research Azure Foundry deprecations, implement the tracker scraper, add focused tests, and verify generated README entries
version: 1.0.0
invocation: both
allowed-tools:
  - web_search
  - read_file
  - grep_search
  - find_files
  - run_command
---

# Azure Foundry deprecation workflow

1. Search for and open the official Azure Foundry lifecycle or deprecation page.
2. Cite the source URL and map its fields to `DeprecationEntry`; never infer absent dates.
3. Follow existing scraper patterns, then add focused parser tests.
4. Run the generator and `check_deprecation_readme` before reporting completion.
5. Report changed paths, verification output, and uncertain source fields.
```

Restart Agav after creating the skill. Use the same task through the explicit skill command when you want to guarantee the procedure is applied:

```text
/azure-foundry-deprecation add Azure Foundry coverage using the official lifecycle page
```

### Add a deterministic README check plugin

Use a local plugin for the mechanical generated-output check rather than relying on the model to visually compare a long README. Create `~/.agav/plugins/check-deprecation-readme.mjs`:

```javascript
import fs from "node:fs";
import path from "node:path";

export default {
  schema: {
    name: "check_deprecation_readme",
    description: "Confirm generated deprecation entries are present in README.md",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider to check" }
      },
      required: ["provider"]
    }
  },
  async execute({ provider }) {
    const root = process.cwd();
    const entries = JSON.parse(fs.readFileSync(
      path.join(root, "data", "deprecations.json"), "utf8"
    ));
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const expected = entries.filter((entry) => entry.provider === provider);
    const missing = expected
      .filter((entry) => !readme.includes(entry.model_name))
      .map((entry) => entry.model_name);

    return {
      output: missing.length === 0
        ? `README contains all ${expected.length} ${provider} entries.`
        : `README is missing ${provider} entries: ${missing.join(", ")}`,
      isError: missing.length > 0
    };
  }
};
```

Restart Agav and verify that `/debug` lists `check_deprecation_readme`. After the scraper's generator completes, prompt Agav:

```text
Use check_deprecation_readme with provider "Azure Foundry". If it reports missing entries,
inspect the generator and README diff; do not claim the task is complete until the check passes.
```

Check progress with `/plan`. If a requirement changes, steer future work without discarding completed investigation:

```text
/steer treat missing shutdown dates as unknown; do not infer them
```

Use subagents only for independent research or downstream reviews—for example, one can compare the official Azure Foundry page with the proposed field mapping while another reviews the README generator. Keep the main agent responsible for the shared contract, edits, tests, and final diff.

Before implementation, review the proposed mapping. Before completion, review changed paths, generated outputs, tool failures, and unresolved assumptions. Use `/compact` if the conversation becomes long; save memory only for a durable decision that should affect later sessions.

## Expected result

The Azure Foundry addition progresses through visible phases, pauses before edits, and ends with a source-backed scraper, focused tests, and a deterministic check that README generation includes the new entries.

Next: [Planning and Steering](/workflows/planning-and-steering), [Author and Evolve a Skill](/guides/create-search-skill), and [Create a Local Plugin](/guides/plugins).
