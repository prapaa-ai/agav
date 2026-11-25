# Agav

**Terminal-native autonomous agent for real repositories and projects**

**[Documentation: https://docs.agav.dev](https://docs.agav.dev)**

[![Version](https://img.shields.io/github/package-json/v/prapaa-ai/agav?label=version&color=blueviolet)](https://github.com/prapaa-ai/agav/releases/latest)&nbsp;[![Terminal-Bench 2.1](https://img.shields.io/badge/Terminal--Bench_2.1-84.7%25-2ea44f?logo=speedtest&logoColor=white)](https://github.com/harbor-framework/terminal-bench-2-1/pull/225)&nbsp;[![SWE-bench-Live Lite](https://img.shields.io/badge/SWE--bench--Live_Lite-62.0%25-2ea44f?logo=speedtest&logoColor=white)](https://swe-bench-live.github.io/#leaderboard-lite)&nbsp;[![Docs](https://img.shields.io/badge/Docs-docs.agav.dev-orange?logo=safari&logoColor=white)](https://docs.agav.dev)&nbsp;[![Discord](https://img.shields.io/badge/Discord-Join%20Us-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/bqDaTQ9ZNS)&nbsp;[![X](https://img.shields.io/badge/X-@agav__dev-black?logo=x&logoColor=white)](https://x.com/agav_dev)&nbsp;[![YouTube](https://img.shields.io/badge/YouTube-@agav--dev-red?logo=youtube&logoColor=white)](https://www.youtube.com/@agav-dev)&nbsp;[![Reddit](https://img.shields.io/badge/Reddit-r/agav-ff4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/agav/)&nbsp;[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)



![Agav preview](https://www.agav.dev/preview.gif)

## Install

No Node.js required. One command, self-contained binary:

```bash
curl -fsSL https://agav.dev/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://www.agav.dev/install.ps1 | iex
```

Windows Command Prompt:

```bat
curl -fsSL https://agav.dev/install.cmd -o install.cmd
install.cmd
del install.cmd
```

Download binaries or pre-releases from [Releases](../../releases). See [docs.agav.dev/getting-started/installation](https://docs.agav.dev/getting-started/installation) for detailed installation steps.

## **Free daily usage**
OpenRouter and NVIDIA NIM offer free daily LLM API credits, no paid plan required. [Create free OpenRouter API key](https://openrouter.ai/keys) · [Create free NVIDIA NIM API key](https://build.nvidia.com/)

## Run

```bash
agav
```

Pick a provider and model, or use defaults:

```bash
agav --provider openai --model gpt-4o
agav --provider openrouter --model openrouter/free
agav --provider nvidia --model meta/muse-glimmer-30b
agav --provider ollama --model llama3.2
```

Non-interactive for scripts and CI:

```bash
agav run "List the files in this repository and explain its structure. Do not modify anything."
agav -P "what does this project do?"
cat error.log | agav -P "explain this error"
```

Keep it current:

```bash
agav update
```

### Run local models through an OpenAI-compatible API

Agav can connect to a local inference server using `--provider openai --openai-api chat`. For example, serve a GGUF model with [llama.cpp](https://github.com/ggml-org/llama.cpp):

```bash
llama-server -m /path/to/model.gguf --alias local-model --port 8080
```

In another terminal, point Agav at that server:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8080/v1 OPENAI_API_KEY=local \
  agav --provider openai --openai-api chat --model local-model
```

Here, `openai` selects the API format; inference runs locally, not on OpenAI's servers. `local` is a placeholder for an unauthenticated server. If your server requires authentication, use its actual key.

[LM Studio](https://lmstudio.ai/docs/developer/openai-compat) works the same way for GGUF models and, on Apple Silicon, MLX models. Start its local server, use `http://127.0.0.1:1234/v1` (the default), and pass the model ID shown by LM Studio. For Agav to use tools, the model and chat template must support tool calling.

## Why harness efficiency matters

AI coding costs are often a harness problem, not just a model problem.

Agav is built to make every model call count. It reuses cached context, limits repeated work, interrupts unproductive repair loops, bounds retries and budgets, and keeps subagent exploration isolated instead of repeatedly sending the same repository context.

In a Terminal-Bench 2.1 cost study using GPT-5.6 Luna at the same rates, Agav had a 15.2¢ median estimated trial cost across 89 tasks and used 49.1% less total spend than Codex. The savings came from measured cache reuse and controls around context, retries, and budgets.

This is a cost result, not a claim of higher accuracy: in that comparison, Agav passed 60.4% of trials versus 76.6% for Codex. We publish the methodology, telemetry, task-level data, implementation references, and limitations in [The economics of coding with Agav](https://agav.dev/research/cost-efficiency).

You own it. Agav is Apache 2.0 open source, with no lock-in, hidden telemetry, or closed hosted runtime required.

You choose the brain. Use Anthropic, OpenAI, OpenRouter, NVIDIA NIM, Gemini, Vertex AI, or Ollama. Switch models mid-session with /model, use local models with Ollama, or route through OpenRouter.

You control the data and actions. API keys are encrypted, local-first operation is supported, tools have per-action permissions, and commands can run in a sandbox on macOS and Linux.

You can verify the work. Agav creates and tracks plans, keeps sessions resumable, supports human approval for destructive actions, and provides non-interactive agav run for CI with optional JSON Schema output.

## Benchmarks and cost evidence

* Top #1-verified on SWE-bench-Live Lite — 62.0% 186/300, you can view [leaderboard](https://swe-bench-live.github.io/#leaderboard-lite) and its [public submission](https://github.com/SWE-bench-Live/submission/blob/main/submissions/lite/agav/gpt-5.5).
* Terminal-Bench 2.1 accuracy — 84.7% [377/445 trials ±0.84%](https://github.com/harbor-framework/terminal-bench-2-1/pull/225). This submission's PR is under review.
* Terminal-Bench 2.1 cost study — 15.2¢ median estimated trial cost and 49.1% lower total spend than Codex at matched GPT-5.6 Luna rates across 89 tasks. See the [full methodology and limitations](https://agav.dev/research/cost-efficiency).

## Highlights

* **Providers** — switch mid-session with `/model`. Fast `/fast` and deep `/deep` shortcuts.
* **Non-interactive mode** — `agav run` and `agav --print` with per-tool permissions and optional JSON Schema output.
* **Sessions that survive** — resume, branch, name, search and export. `/compact` reclaims context without losing plans, and `/permission` switches between ask, auto-accept, and deny-writes mid-session and sticks on resume.
* **Skills & Agents** — reusable instruction bundles and installable service agents from a marketplace. Delegate scoped work to fresh-context subagents.
* **Memory** — cross-session memories per project: user preferences, feedback, project decisions, references.
* **Voice input** — `/voice` dictates an editable prompt with offline, English-only transcription. No FFmpeg, Python, or extra setup.
* **Background jobs** — opt-in `run_background_job` and `/job` keep long-running commands and cron schedules alive beyond a single turn.
* **Repository-aware editing** — LSP queries, notebook support, test running, `/undo`, and planning UI.

## Quick links

* [Quick start](https://docs.agav.dev/getting-started/quick-start)
* [CLI reference](https://docs.agav.dev/reference/cli)
* [Tools, skills & agents](https://docs.agav.dev/features)
* [Workflows & automation](https://docs.agav.dev/workflows)
* [Changelog](https://github.com/prapaa-ai/agav/releases)

## Community

[![Discord](https://img.shields.io/badge/Discord-Join%20Us-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/bqDaTQ9ZNS)&nbsp;[![X](https://img.shields.io/badge/X-@agav__dev-black?logo=x&logoColor=white)](https://x.com/agav_dev)&nbsp;[![YouTube](https://img.shields.io/badge/YouTube-@agav--dev-red?logo=youtube&logoColor=white)](https://www.youtube.com/@agav-dev)&nbsp;[![Reddit](https://img.shields.io/badge/Reddit-r/agav-ff4500?logo=reddit&logoColor=white)](https://www.reddit.com/r/agav/)

Email: contact@agav.dev

## License

[Apache 2.0](LICENSE)

---

*Documentation source lives in* [`docs/`](./docs/)*. To run locally:* `cd docs && npm install && npm run dev`*.*
