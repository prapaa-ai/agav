# Agav Service Agents System

A complete service agent system for agav with native (JS/TS) and polyglot (A2A protocol) support.

## Overview

Service agents are specialized assistants that integrate with external services (Jira, GitHub, Slack, etc.). The main agav agent can delegate tasks to these service agents, enabling multi-agent orchestration.

## Key Features

- ✅ **Multi-Agent Orchestration** - Main agent delegates to specialized service agents
- ✅ **Pluggable Post-Build** - Install agents without recompiling agav
- ✅ **Low-Code Creation** - Simple `.mjs` tool files + YAML manifest
- ✅ **Security** - Per-agent encrypted credentials, HITL for destructive tools
- ✅ **Native + Polyglot** - JS/TS in-process + HTTP for Python/Go/Rust
- ✅ **Three-Tier Priority** - Bundled < Global < Project overrides
- ✅ **Dynamic Discovery** - Catalog injection, LLM routing by description
- ✅ **Marketplace** - Browse and install agents from git repositories
- ✅ **Full CLI + TUI** - Command-line and interactive management

## Quick Start

### Install an Agent

```bash
# From CLI
agav agents install https://github.com/your-org/agents/jira-agent

# Or use the TUI
agav
/agents  # Opens interactive TUI
[2]      # Navigate to Marketplace tab
ENTER    # Install selected agent
```

### Use an Agent

```bash
agav run "Use the jira agent to show me my open issues"
```

The main agent will automatically route to the `jira_agent` tool when appropriate.

### Manage Agents

```bash
# List all agents
agav agents list

# Enable/disable an agent
agav agents disable jira
agav agents enable jira

# Remove an agent
agav agents remove jira

# Interactive management
agav
/agents
[1]       # List tab
ENTER/i   # Inspect selected agent
d/e       # Disable/enable
```

## Agent Structure

```
agent-name/
  AGENT.md          # Manifest + system prompt
  tools/            # Tool implementations
    tool1.mjs
    tool2.mjs
  config.json       # Encrypted credentials (auto-generated)
```

### AGENT.md Format

```yaml
---
name: jira
description: Jira agent for issue tracking
version: 1.0.0
type: native                    # or "a2a" for polyglot
required-config:
  - JIRA_URL
  - JIRA_EMAIL
  - JIRA_API_TOKEN
tools-dir: ./tools
model: claude-sonnet-4-5        # Optional override
effort: medium                  # Optional override
tags: [jira, project-management]
tool-permissions:
  jira_create_issue: destructive
  jira_view_issues: safe
enabled: true
---

# System Prompt

You are a Jira assistant with access to Jira REST API...
```

### Tool Format (.mjs)

```javascript
export default {
  schema: {
    name: "jira_view_issues",
    description: "View all Jira issues assigned to me",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        max_results: { type: "number", default: 50 }
      }
    }
  },
  async execute(input) {
    const { JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
    
    // Tool implementation using credentials
    const response = await fetch(`${JIRA_URL}/rest/api/3/search?...`);
    
    return {
      output: "Result text...",
      isError: false
    };
  }
};
```

## Agent Loading (Three-Tier)

Agents are loaded from three locations, with later tiers overriding earlier ones by name:

1. **Bundled** (`source/agents/bundled/`) - Shipped with agav
2. **Global** (`~/.agav/agents/`) - User-wide installations
3. **Project** (`.agav/agents/`) - Project-local overrides

```bash
# Example: Override bundled jira agent with custom version
mkdir -p .agav/agents/jira
cp -r ~/.agav/agents/my-custom-jira/* .agav/agents/jira/
```

## Credentials

Agents declare required credentials in `required-config`:

```yaml
required-config:
  - JIRA_URL
  - JIRA_EMAIL
  - JIRA_API_TOKEN
```

Credentials are stored per-agent in encrypted `config.json`:

```json
{
  "JIRA_URL": "encrypted:abc123...",
  "JIRA_EMAIL": "encrypted:def456...",
  "JIRA_API_TOKEN": "encrypted:ghi789..."
}
```

At runtime, credentials are injected into `process.env` for the agent's execution scope only.

### Setting Credentials (Manual)

```bash
# Edit ~/.agav/agents/jira/config.json
{
  "JIRA_URL": "https://your-domain.atlassian.net",
  "JIRA_EMAIL": "user@example.com",
  "JIRA_API_TOKEN": "your-api-token"
}

# Agav will encrypt on next run
```

## Polyglot Agents (A2A Protocol)

For agents in other languages (Python, Go, Rust), use the A2A protocol:

### AGENT.md for A2A

```yaml
---
name: my-python-agent
type: a2a
start-command: python agent.py --port 4000
endpoint: http://localhost:4000
description: Custom Python agent
version: 1.0.0
---
```

### A2A Protocol Endpoints

Your agent must implement:

- `GET /health` - Health check (returns 200 when ready)
- `POST /execute` - Execute task (request: `{task, context}`, response: `{output, isError}`)
- `POST /stream` - Stream execution (SSE format, optional)

Agav will:
1. Start the process via `start-command`
2. Poll `/health` until ready
3. Send tasks to `/execute`
4. Kill the process on exit

## Marketplace

### Using a Marketplace

Configure in `~/.agav/config.json`:

```json
{
  "agentMarketplace": "https://raw.githubusercontent.com/your-org/agav-agents/main"
}
```

Browse and install via TUI:

```bash
agav
/agents
[2]       # Marketplace tab
↑↓        # Navigate
ENTER     # Install
```

### Creating a Marketplace

1. Create a git repository
2. Add `index.json` in root:

```json
{
  "version": "1.0.0",
  "agents": [
    {
      "name": "jira",
      "description": "Jira agent for issue tracking",
      "category": "project-management",
      "tags": ["jira", "issues"],
      "version": "1.0.0",
      "path": "agents/jira",
      "tool-count": 5,
      "has-destructive-tools": true
    }
  ],
  "categories": [
    {
      "id": "project-management",
      "name": "Project Management"
    }
  ]
}
```

3. Create `agents/jira/` with `AGENT.md` + `tools/*.mjs`
4. Host on GitHub or any static server

Users install with:

```bash
agav agents install https://raw.githubusercontent.com/your-org/agav-agents/main/agents/jira
```

## Creating Your Own Agent

### Quick Start

1. Create directory structure:

```bash
mkdir -p my-agent/tools
cd my-agent
```

2. Create `AGENT.md`:

```yaml
---
name: my-agent
description: My custom agent
version: 1.0.0
type: native
tools-dir: ./tools
enabled: true
---

# My Agent

System prompt goes here...
```

3. Create tools in `tools/*.mjs`:

```javascript
// tools/my-tool.mjs
export default {
  schema: {
    name: "my_tool",
    description: "Does something useful",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string" }
      },
      required: ["input"]
    }
  },
  async execute(input) {
    return {
      output: `Processed: ${input.input}`,
      isError: false
    };
  }
};
```

4. Install locally:

```bash
agav agents install ./my-agent
```

5. Test:

```bash
agav run "Use my agent to process 'hello world'"
```

## Multi-Agent Orchestration

The main agent can call multiple service agents in sequence or parallel:

### Example: Sequential

```
User: "Get details on JIRA-123 and create a GitHub issue for it"

Main agent reasoning:
1. Call jira_agent({ task: "get details of JIRA-123" })
2. Call github_agent({ task: "create issue: ..." })
3. Synthesize and respond
```

### Example: Parallel

```
User: "Show me all my open work across Jira and GitHub"

Main agent reasoning:
1. Call jira_agent({ task: "get my open issues" }) in parallel with
   github_agent({ task: "get my assigned PRs and issues" })
2. Merge results and respond
```

Service agents do NOT call each other - only the main agent orchestrates.

## Bundled Agents

### test (3 tools)

Simple validation agent:
- `test_echo` - Echo a message
- `test_greet` - Greet with a name
- `test_write` - Write to a file (destructive)

### jira (5 tools)

Production Jira integration:

**Read-only (safe):**
- `jira_view_my_issues` - View assigned issues
- `jira_search_issues` - JQL search
- `jira_get_issue` - Full issue details with comments

**Mutating (destructive):**
- `jira_create_issue` - Create new issues
- `jira_add_comment` - Add comments

Requires credentials: `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`

## CLI Reference

```bash
# List all agents
agav agents list

# Install from URL or local path
agav agents install <url|path>
agav agents install https://github.com/org/repo/agents/jira
agav agents install ./my-local-agent
agav agents install <url> --alias my-jira --destination project

# Manage agents
agav agents enable <name>
agav agents disable <name>
agav agents remove <name>
```

## TUI Reference

```bash
agav
/agents
```

**Keyboard Shortcuts:**

```
1/2/3       Switch tabs (List / Marketplace / Create)
↑↓          Navigate lists
ENTER/i     Inspect agent (list) / Install (marketplace)
d           Disable selected agent
e           Enable selected agent
r           Refresh marketplace
b/ESC       Back (in inspect view)
q/ESC       Exit
```

**Tab 1: List**
- Shows all installed agents grouped by origin
- Inspect mode shows detailed metadata and tool list

**Tab 2: Marketplace**
- Browse agents from configured marketplace
- Install with ENTER
- Shows tool count and destructive flag warnings

**Tab 3: Create**
- Placeholder for agent creation wizard (coming soon)

## Slash Commands

```
/agents     Open interactive TUI
/help agents    Show detailed help
```

## Security

### Tool Permissions

Tools are marked in AGENT.md:

```yaml
tool-permissions:
  safe_tool: safe           # Never prompts for confirmation
  write_tool: destructive   # Always prompts (unless --auto-accept)
  legacy_tool: ~            # Falls back to SAFE_TOOLS list
```

### Credential Isolation

- Credentials are per-agent (no cross-contamination)
- Encrypted at rest using agav's encrypt/decrypt
- Injected into `process.env` only during agent execution
- Restored after execution completes

### HITL (Human-in-the-Loop)

Destructive tools trigger confirmation prompts showing:
- Tool name
- Input parameters
- Preview of changes (for edits)

User can:
- Approve (Y)
- Reject (N)
- Always allow this tool (A)

## Advanced

### Agent Catalog (System Prompt Injection)

When agents load, their catalog is injected into the system prompt:

```
Available specialized agents:
- jira_agent: Jira agent for issue tracking and project management
- github_agent: GitHub PRs, issues, code review
```

Token budget: ~500 tokens max, ~30 tokens per agent.

### Tool Routing

The LLM sees each agent as a tool:

```json
{
  "name": "jira_agent",
  "description": "Jira agent for issue tracking and project management via Jira REST API",
  "inputSchema": {
    "type": "object",
    "properties": {
      "task": {
        "type": "string",
        "description": "The task to delegate to this specialized agent"
      }
    },
    "required": ["task"]
  }
}
```

No special routing logic - the LLM decides based on the description.

### Nested Execution

When an agent is called:
1. Child `ToolRegistry` created with only the agent's tools
2. Fresh `ConversationState` initialized
3. `runAgentLoop()` called recursively
4. Agent's system prompt prepended to base system prompt
5. Output returned to parent as tool result

### Agent Registry

Persistent state in `~/.agav/agents/registry.json`:

```json
{
  "agents": {
    "jira": {
      "name": "jira",
      "alias": null,
      "enabled": true,
      "sourceUrl": "https://github.com/...",
      "installedAt": "2026-08-06T10:32:56.932Z",
      "version": "1.0.0"
    }
  }
}
```

Tracks:
- Enabled/disabled state (overrides manifest)
- Installation source (for updates)
- Install timestamp
- Aliases (for name conflicts)

## Troubleshooting

### Agent not appearing

```bash
# Check if loaded
agav agents list

# Check if enabled
/agents
[1]  # List tab, verify status

# Reload agents
agav  # Restart agav session
```

### Agent not being called

```bash
# Check catalog
agav run "/debug" --auto-accept
# Look for "Available specialized agents:" section

# Check if disabled
agav agents list
```

### Credential errors

```bash
# Verify credentials exist
cat ~/.agav/agents/jira/config.json

# Test manually
node -e "
const { decrypt } = require('./build/utils/encrypt.js');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('~/.agav/agents/jira/config.json'));
console.log(decrypt(config.JIRA_URL));
"
```

### A2A agent won't start

```bash
# Check start-command is correct
cat ~/.agav/agents/my-agent/AGENT.md | grep start-command

# Test manually
cd ~/.agav/agents/my-agent
python agent.py --port 4000  # Or whatever start-command says

# Check health endpoint
curl http://localhost:4000/health
```

## Examples

See `marketplace-example/` for a sample marketplace structure.

See `source/agents/bundled/` for example agent implementations:
- `test-agent/` - Minimal example (3 tools)
- `jira/` - Production example (5 tools, REST API, credentials)

## Contributing

To add a bundled agent:

1. Create `source/agents/bundled/my-agent/`
2. Add `AGENT.md` + `tools/*.mjs`
3. Build will auto-copy to `build/agents/bundled/`
4. Agent loads automatically on next run

To create a marketplace:

1. Fork the marketplace template
2. Add agents to `agents/` directory
3. Update `index.json`
4. Host on GitHub
5. Share the raw URL

## License

Bundled agents inherit agav's license. Marketplace agents may have different licenses - check each agent's AGENT.md.
