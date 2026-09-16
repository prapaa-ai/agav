---
title: Agav Platform Overview
tags:
  - agav
  - architecture
  - ai-agent
  - terminal-cli
  - agents
version: 0.2.3-beta
updated: 2026-09-15
---

# Agav Platform Overview

> **"Stay in the Shell."** — Terminal-native AI coding assistant engineered for production software repositories.

Agav is an autonomous developer companion operating directly inside modern terminal emulators. Built on a customized, high-performance React/Ink rendering pipeline and compiled to single native binaries, Agav provides deep codebase indexing, multi-agent orchestration, sandboxed tool execution, and native support for major LLM providers.

---

## 1. System Topology & Core Capabilities

```mermaid
graph TD
    User([Developer Terminal]) <--> CLI["Agav CLI (source/cli.tsx)"]
    CLI <--> TUI["React / Ink Engine (source/ink/)"]
    TUI <--> Loop["Agent Loop (source/agent/loop.ts)"]
    
    subgraph "Provider Mesh"
        Loop <--> Gemini["Google Gemini / Vertex AI"]
        Loop <--> Anthropic["Anthropic Claude"]
        Loop <--> OpenAI["OpenAI GPT / o-series"]
        Loop <--> Nvidia["NVIDIA NIM"]
        Loop <--> Local["Ollama / DeepSeek"]
    end

    subgraph "Execution & Isolation"
        Loop <--> ToolRegistry["Native Tool Registry"]
        Loop <--> Sandbox["Seatbelt / Bubblewrap / Docker Sandbox"]
        Loop <--> A2A["Polyglot Agents (A2A Protocol)"]
    end

    subgraph "Persistence"
        Loop <--> History["~/.agav/history/<uuid>.json"]
        Loop <--> Memory["~/.agav/projects/<hash>/memory/"]
        Loop <--> State["~/.agav/session-state.json"]
    end
```

### Key Highlights
- **Pluggable Multi-Provider Core:** Seamless runtime switching between Google Gemini (`gemini-2.5-pro`, `gemini-2.5-flash`), Anthropic Claude (`claude-sonnet-4-5`), OpenAI (`gpt-5.4-mini`), NVIDIA NIM (`nemotron-3.5-lightning`), DeepSeek, and local Ollama instances.
- **Multi-Agent Orchestration (`AGENTS.md`):** Delegate complex, domain-specific tasks (e.g. Jira, GitHub, Slack) to specialized sub-agents with dedicated credential isolation.
- **Polyglot Agent Protocol (A2A):** Run specialized agent workers written in Python, Rust, or Go over lightweight HTTP loopback endpoints (`/health`, `/execute`, `/stream`).
- **Sandboxed Tool Execution:** Untrusted third-party agent tools run under strict OS-level isolation (Apple Seatbelt on macOS, Bubblewrap on Linux, or Docker containers).
- **Session Branching & Persistent Resumption:** Complete conversation history trees with `/branch` and interactive session resumption (`/resume`).

---

## 2. Command Reference

### Interactive Slash Commands
| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/resume` | `[id/name]` | Opens the interactive fuzzy session picker or resumes by prefix |
| `/branch` | `[name]` | Forks the active conversation into a new branch without altering root history |
| `/model` | `[model-id]` | Interactively switches model and auto-selects appropriate provider |
| `/agents` | - | Launches the full TUI Service Agent Manager (List, Marketplace, Create) |
| `/agent-lock` | `[name]` | Locks the active session strictly to a specific service agent |
| `/clear` | - | Preserves the session to history and starts a fresh conversation turn |
| `/memory` | - | Inspects and refreshes repository-specific project memory |
| `/steer` | `<guidance>` | Injects directional guidance into an in-flight turn without interrupting |
| `/exit` | - | Saves state, flushes telemetry, stops agents, and exits gracefully |

### CLI Invocation Syntax
```powershell
# Interactive development
agav

# Explicit provider & model
agav --provider gemini --model gemini-2.5-pro
agav --provider nvidia --model nvidia/nemotron-3.5-lightning-30b-a3b

# Non-interactive / CI Pipe mode
agav run "audit dependencies and report vulnerabilities"
agav -P --stream "explain package.json"

# Service Agent Management
agav agents list
agav agents install https://github.com/your-org/agents/jira-agent
agav agents disable jira
```

---

## 3. Related Documentation

- [[architecture|Agav Architecture Specification]]: Deep dive into the Agent loop, Ink renderer, and sandboxing.
- [[phases|Phases & Roadmap]]: The 5 development and security hardening phases.
- [[memory|Project Memory & Decisions]]: Persistent tracking of design choices, state, and bug resolutions.
