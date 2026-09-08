<div align="center">

# Agav

**Terminal-native autonomous coding agent for real repositories**

<p>
  <img alt="Version" src="https://img.shields.io/github/package-json/v/prapaa-ai/agav?style=for-the-badge&amp;label=version&amp;color=111">
  <img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-111?style=for-the-badge">
  <a href="https://github.com/harbor-framework/terminal-bench-2-1/pull/225"><img alt="Terminal-Bench 2.1" src="https://img.shields.io/badge/Terminal--Bench_2.1-84.7%25_%7C_top_of_the_board-111?style=for-the-badge"></a>
  <a href="https://swe-bench-live.github.io"><img alt="SWE-bench-Live Lite" src="https://img.shields.io/badge/SWE--bench--Live_Lite-62.0%25_%7C_%232_on_the_board-111?style=for-the-badge"></a>
</p>

</div>

<div align="center">
  <img src="https://www.agav.dev/preview.gif" alt="Agav preview" width="100%" style="border-radius:16px;" />
</div>

Agav is an autonomous agent, not a chat wrapper. It reads, reasons, edits and verifies across your actual codebase — in the terminal where work happens.

## Install

No Node.js required. One command, self-contained binary:

```bash
curl -fsSL https://agav.dev/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://www.agav.dev/install.ps1 | iex
```

Download binaries or pre-releases from [Releases](../../releases). See [docs.agav.dev/getting-started/installation](https://docs.agav.dev/getting-started/installation) for Windows cmd, `--beta`, upgrade and uninstall.

## Run

```bash
agav
```

Pick a provider and model, or use defaults:

```bash
agav --provider openai --model gpt-4o
agav --provider openrouter --model openrouter/auto
agav --provider ollama --model llama3.2
```

Non-interactive for scripts and CI:

```bash
agav run "review the code in src/"
agav -P "what does this project do?"
cat error.log | agav -P "explain this error"
```

Keep it current:

```bash
agav update
```

## Why Agav

Today, the most powerful AI tools are controlled by a handful of companies. They choose which models you use, where your data goes, and how much you pay. If they change the rules tomorrow, you have no choice but to follow.

We’re building the alternative — an AI that works for you, runs on your terms, and belongs to no one.

**You own it.** Apache 2.0 open source. No lock-in, no hidden telemetry, auditable code.

**You choose the brain.** 7 providers — Anthropic, OpenAI, OpenRouter, NVIDIA NIM, Gemini, Vertex AI, Ollama. Switch models mid-session with `/model`, run local with Ollama, or route via OpenRouter.

**You control the data.** Encrypted API keys, local-first option, per-tool permissions, and sandboxed commands on macOS/Linux.

**Real work, not chat.** Built-in tools read, search, edit, test and undo inside your repo. Plans are tracked, sessions survive, and `/undo` keeps you safe.

**Autonomous and verifiable.** Plans are created and tracked automatically, human-in-the-loop for destructive actions, and non-interactive `agav run` for CI with JSON Schema output.

## Vision

* **Autonomous in real code** — a complete coding harness that reads, reasons, edits and verifies across real codebases.
* **Terminal-native superpower** — meets you where work happens with IDE capabilities and command-line speed.
* **An agent for everyone** — equally useful to senior engineers debugging distributed systems and non-technical founders drafting a pitch deck.

## Who is it for

**Developers & Engineers**
Refactor, debug, run Terminal-Bench level tasks, and audit repos with scriptable `agav run` and JSON schema output.

**Teams & Ops**
Schedule, watch and loop tasks. Non-interactive mode with per-tool permissions for CI. Memory and planning that survive session restarts.

**Non-coders**
Ask in plain English to summarize docs, analyze a CSV, generate a deck outline or draft emails — private, no code required.

## Proof

* **Terminal-Bench 2.1** — 84.7% [377/445 trials ±0.84%](https://github.com/harbor-framework/terminal-bench-2-1/pull/225), top of public board.(PR under review)
* **SWE-bench-Live Lite** — 62.0% [186/300](https://github.com/SWE-bench-Live/submission/blob/main/submissions/lite/agav/gpt-5.5), #2 on the board.

## Highlights

* **Providers** — switch mid-session with `/model`. Fast `/fast` and deep `/deep` shortcuts.
* **Non-interactive mode** — `agav run` and `agav --print` with per-tool permissions and optional JSON Schema output.
* **Sessions that survive** — resume, branch, name, search and export. `/compact` reclaims context without losing plans.
* **Skills & Agents** — reusable instruction bundles and installable service agents from a marketplace. Delegate scoped work to fresh-context subagents.
* **Memory** — cross-session memories per project: user preferences, feedback, project decisions, references.
* **Repository-aware editing** — LSP queries, notebook support, test running, `/undo`, and planning UI.

## Quick links

* [Quick start](https://docs.agav.dev/getting-started/quick-start)
* [CLI reference](https://docs.agav.dev/reference/cli)
* [Tools, skills & agents](https://docs.agav.dev/features)
* [Workflows & automation](https://docs.agav.dev/workflows)
* [Changelog](https://github.com/prapaa-ai/agav/releases)

## Community

Email: contact@agav.dev  
Discord: [discord.gg/6u3m2JN6k](https://discord.gg/6u3m2JN6k)

## License

[Apache 2.0](LICENSE)

---

*Documentation source lives in [`docs/`](./docs/). To run locally: `cd docs && npm install && npm run dev`.*
