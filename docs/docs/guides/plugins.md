---
title: Create a Local Plugin
description: Add a small JavaScript tool for repository-specific data
guideLevel: advanced
order: 8
---

# Create a Local Plugin

Plugins are useful when Agav needs a deterministic operation that is not built in. They run with the same operating-system access as Agav, so use only code you trust.

## Scenario: report the current run count

Create `~/.agav/plugins/run-count.mjs` (`%USERPROFILE%\.agav\plugins\run-count.mjs` on Windows):

```javascript
import fs from "node:fs";
import path from "node:path";

export default {
  schema: {
    name: "run_count",
    description: "Read hello-agav's state.json and return the current run count",
    inputSchema: { type: "object", properties: {} }
  },
  async execute() {
    const file = path.join(process.cwd(), "state.json");
    if (!fs.existsSync(file)) {
      return { output: "No state.json found — the CLI has not been run yet.", isError: false };
    }
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const count = data.count ?? 0;
    return {
      output: `The CLI has been run ${count} time${count === 1 ? "" : "s"}.`,
      isError: false
    };
  }
};
```

Restart Agav, check `/debug` for `run_count`, then ask:

```text
Use run_count and tell me how many times the CLI has been used.
```

The tool expects Agav to be running at the hello-agav root. Validate inputs and handle file errors before expanding a plugin to accept user-supplied paths or perform writes.

## Expected result

Agav gets a short, deterministic answer from the repository's current JSON data without asking the model to parse the file.

Next: [Plugins and Subagents](/features/plugins-and-subagents).
