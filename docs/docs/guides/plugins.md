---
title: Create a Local Plugin
description: Add a small JavaScript tool for repository-specific data
guideLevel: advanced
order: 8
---

# Create a Local Plugin

Plugins are useful when Agav needs a deterministic operation that is not built in. They run with the same operating-system access as Agav, so use only code you trust.

## Scenario: report the next model shutdown

Create `~/.agav/plugins/next-model-shutdown.mjs`:

```javascript
import fs from "node:fs";
import path from "node:path";

export default {
  schema: {
    name: "next_model_shutdown",
    description: "Read the tracker data and return the next model shutdown",
    inputSchema: { type: "object", properties: {} }
  },
  async execute() {
    const file = path.join(process.cwd(), "data", "deprecations.json");
    const entries = JSON.parse(fs.readFileSync(file, "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    const next = entries
      .filter((entry) => entry.shutdown_date >= today)
      .sort((a, b) => a.shutdown_date.localeCompare(b.shutdown_date))[0];

    return {
      output: next
        ? `${next.provider}: ${next.model_name} shuts down ${next.shutdown_date}`
        : "No future shutdown is recorded.",
      isError: false
    };
  }
};
```

Restart Agav, check `/debug` for `next_model_shutdown`, then ask:

```text
Use next_model_shutdown and explain which provider needs attention first.
```

The tool expects Agav to be running at the tracker root. Validate inputs and handle file errors before expanding a plugin to accept user-supplied paths or perform writes.

## Expected result

Agav gets a short, deterministic answer from the repository's current JSON data without asking the model to sort the full file.

Next: [Plugins and Subagents](/features/plugins-and-subagents).
