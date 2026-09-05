<div align="center">

# Agav

**A terminal-native AI coding assistant for real repositories**

<p>
  <img alt="Version" src="https://img.shields.io/github/package-json/v/prapaa-ai/agav?style=for-the-badge&amp;label=version&amp;color=111">
  <img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-111?style=for-the-badge">
  <a href="https://github.com/harbor-framework/terminal-bench-2-1/pull/225"><img alt="Terminal-Bench 2.1" src="https://img.shields.io/badge/Terminal--Bench_2.1-84.7%25_%7C_top_of_the_board-111?style=for-the-badge"></a>
</p>

</div>

<div align="center">
  <img src="https://www.agav.dev/preview.gif" alt="Agav preview" width="100%" style="border-radius: 16px;" />
</div>

## Quickstart

Run it inside a repository:

```bash
agav
```

Pick a provider and model, or take the defaults:

```bash
agav --provider openai --model gpt-4o
agav --provider openrouter --model openrouter/auto
agav --provider vertex-ai --model vertex/gemini-3.5-flash
agav -r                                  # resume a session (lists them if no id)
```

Non-interactive, for scripts and CI:

```bash
agav run "review the code in src/"
# Read-only audit: block every tool that isn't explicitly allowed
agav run --permission '{"*":"deny","read_file":"allow","grep_search":"allow"}' "audit dependencies"
# Deny one tool; the rest still run without confirmation
agav run --permission '{"write_file":"deny"}' "check for security issues"
agav -P "what does this project do?"
agav -P --stream "explain this repository"
cat error.log | agav -P "explain this error"
```

Keep it current:

```bash
agav update
```

### Options

| Flag | Meaning |
| --- | --- |
| `--provider`, `-p` | `anthropic`, `openai`, `openrouter`, `nvidia`, `gemini`, `vertex-ai` or `ollama` (default: `anthropic`) |
| `--model`, `-m` | Model name |
| `--effort` | Reasoning effort: `low`, `medium`, `high` or `max` (default: `high`) |
| `--print`, `-P` | Run the prompt, print the result, exit |
| `--stream` | Stream text to stdout in real time, with `--print` |
| `--output-schema` | Require pipe-mode output to match an inline JSON Schema, or `@file` |
| `--permission` | JSON tool permissions for run mode |
| `--max-turns` | Cap agent/tool iterations in run mode — a safety limit for unattended CI work |
| `--resume`, `-r [id]` | Resume a session; prefix match if an id is given |
| `--auto-accept`, `-y` | Skip tool confirmations |
| `--deny-writes` | Block all write operations |
| `--openai-api` | OpenAI API mode: `responses` or `chat` (default: `responses`) |
| `--ollama-host` / `--ollama-port` / `--ollama-endpoint` / `--ollama-api-key` | Ollama connection |
| `--help`, `-h` / `--version`, `-v` | Help, version |

## Vision

- **The best agentic coding harness in the world** — not a wrapper around an API, but a complete autonomous agent that reads, reasons, edits, and verifies across real codebases.
- **Terminal-first, no compromises** — the terminal is where work happens; Agav meets you there with the full power of an IDE and the speed of the command line.
- **An agent for everyone** — equally useful to the senior engineer debugging a distributed system and the non-technical founder drafting a pitch deck.

## What it does

Agav reads, searches and edits the repository you run it in, and runs the commands you'd otherwise run yourself. On [Terminal-Bench 2.1](https://www.tbench.ai/leaderboard/terminal-bench/2.1) — all 89 tasks, five trials each, judge-audited trajectories — Agav scored [**84.7%**](https://github.com/harbor-framework/terminal-bench-2-1/pull/225) (377 of 445 trials, ± 0.84%), ahead of every entry on the current public board (submission in review).

- **Seven providers** — Anthropic, OpenAI, OpenRouter, NVIDIA NIM, Gemini, Vertex AI and Ollama, switchable mid-session with `/model`.
- **Sandboxed commands** — shell tools run under Seatbelt on macOS and Bubblewrap on Linux where either is available.
- **Non-interactive mode** — `agav run` and `agav --print` make the same agent scriptable from CI, with per-tool permissions and optional JSON Schema output.
- **Sessions that survive** — resume, branch, name, search and export past conversations; `/compact` reclaims context without starting over. Plans are saved per-session and picked back up on resume.
- **Extensible** — MCP servers, plugins, a skill marketplace and installable agents; delegate scoped work to fresh-context subagents.
- **Lights-off operation** — schedule tasks (`/schedule`), loop prompts (`/loop`) and watch files (`/watch`); specs go in, verified work comes out.
- **Repository-aware editing** — LSP-backed queries, notebook support, test running, and `/undo` for the last file change.

## Tools

Agav ships with 19 built-in tools the agent calls on your behalf — reading, writing, searching, running commands, and talking to external services.

| Tool | What it does |
| --- | --- |
| `read_file` | Read files — text with line ranges, PDF/Office with page ranges, images as compressed visual previews |
| `write_file` | Create or overwrite files; creates parent directories as needed |
| `edit_file` | Surgical string replacement — find an exact string, replace its first occurrence |
| `run_command` | Execute shell commands, sandboxed via Seatbelt, Bubblewrap or Docker |
| `grep_search` | Recursive regex search across files, with optional file-glob filters |
| `find_files` | Glob-based file discovery |
| `list_directory` | List a directory's contents with file types and sizes |
| `web_search` | Search the web; returns titles, URLs and snippets |
| `fetch_url` | HTTP requests (GET/POST/PUT/DELETE/PATCH) with custom headers |
| `lsp_query` | Language Server Protocol queries — diagnostics, definitions, references, hover |
| `read_notebook` | Read Jupyter notebook cells with their outputs |
| `edit_notebook` | Edit Jupyter notebook cells by index |
| `github` | GitHub CLI integration — create and view PRs and issues |
| `overview` | Codebase structure map showing the file tree and key symbols per file |
| `run_tests` | Auto-detecting test runner (pytest, vitest, jest, go test, cargo test) with structured pass/fail results |
| `update_plan` | Mark plan steps as in-progress, done or failed |
| `save_memory` | Persist cross-session memories (user, feedback, project, reference) |
| `subagent` | Spawn independent parallel subagents, each with their own context and tools |
| `activate_skill` | Run a registered skill by name |

## Skills

Agav ships with a set of built-in skills — reusable instruction bundles the agent can activate on its own or that you can trigger manually. Skills load in order from bundled → global (`~/.agav/skills/`) → project (`.agav/skills/`), with later entries overriding earlier ones.

| Skill | What it does | Trigger |
| --- | --- | --- |
| `code-review` | Review code changes for bugs, security issues, and improvements | auto + manual |
| `deep-research` | Multi-source research on a topic with citations | manual |
| `diagnose` | Diagnose and fix errors and bugs | auto + manual |
| `doc-gen` | Generate documentation for code | auto + manual |
| `explain` | Explain code in plain language | auto + manual |
| `git-commit` | Generate a commit message from staged changes | auto + manual |
| `refactor` | Suggest and apply code refactoring | auto + manual |
| `security-scan` | Check code for security vulnerabilities | manual |
| `simplify` | Reduce complexity and simplify code | auto + manual |
| `test-writer` | Generate unit tests for existing code | auto + manual |

Browse and install additional skills from the marketplace with `/skills`, or drop your own into the skills directory.

## Agents

Agav can delegate work to standalone agents — in-process or external — that carry their own tools, model preferences, and permissions.

- **Native agents** — JS/TS agents defined by an `AGENT.md` file with YAML frontmatter, running in-process with custom tools, model/effort overrides, MCP servers, and tool permissions.
- **A2A agents** — external processes that communicate over HTTP via the Agent-to-Agent protocol.
- **Marketplace** — install agents from git repos with `/agents`; repos are sparse-cloned, validated, and sandboxed.
- **Origins** — agents load from bundled → global (`~/.agav/agents/`) → project-local, the same cascade as skills.
- **Creation** — `/agents → Create` opens a wizard that builds an agent definition with an LLM-generated system prompt, workspace MCP server selection, and credential management.

## Memory

Agav remembers things across sessions. Memories are scoped per project (identified by the git root hash) and stored as markdown files.

Four memory types:

| Type | What it holds | Examples |
| --- | --- | --- |
| `user` | Role, preferences, expertise | "I'm a data scientist", "prefer tabs" |
| `feedback` | Corrections and confirmations | "don't do X", "yes, that approach works" |
| `project` | Project decisions, deadlines, context | "we use PostgreSQL", "deadline is Friday" |
| `reference` | Pointers to external resources | Linear boards, Slack channels, dashboards |

The agent saves memories proactively when it detects relevant information during a session. Manage them yourself with:

- `/memory` — list and manage saved memories
- `/remember` — save a memory manually
- `/forget` — delete a memory by name

Memories are automatically loaded into future sessions for the same project.

## Planning

Agav creates multi-step plans for complex tasks and tracks progress visually. Plans are saved per-session and picked back up on resume.

- The agent creates plans automatically when a task has enough moving parts to warrant one.
- Each step carries a status: `in_progress`, `done`, or `failed`.
- `/plan` shows the active plan; `/plan list`, `/plan <n> <status>`, and `/plan clear` manage it.
- `Ctrl+G` toggles the plan detail panel.
- Plans survive `/compact` operations and session resumes — context gets reclaimed, the plan stays.

## Slash commands

<details>
<summary>29 commands, available in any session</summary>

| Command | What it does |
| --- | --- |
| `/help` | Show available commands |
| `/model` | Show or change the current model |
| `/fast` | Switch to a fast, lightweight model |
| `/deep` | Switch to a powerful model for complex tasks |
| `/effort` | Show or change reasoning effort |
| `/context` | Show context window usage |
| `/compact` | Compact conversation history to free up context |
| `/plan` | Show, list, or update the active plan (`/plan list`, `/plan <n> <status>`, `/plan clear`) |
| `/steer` | Add context or direction to guide the agent |
| `/undo` | Revert the last file change |
| `/memory` | Manage persistent memories |
| `/remember` | Save a memory |
| `/forget` | Delete a memory by name |
| `/resume` | Resume a previous session |
| `/search` | Search past sessions by keyword |
| `/branch` | Fork a new session or list branches |
| `/name` | Name the current session |
| `/export` | Export conversation as a markdown file |
| `/new` | Start a new chat without deleting saved sessions |
| `/clear` | Start a new chat (alias: `/new`) |
| `/watch` | Watch files and run a command on change |
| `/loop` | Repeat a prompt on an interval |
| `/schedule` | Manage persistent scheduled tasks |
| `/changelog` | Show release notes for the current version |
| `/skills` | Manage skills: list, install, remove, or browse the marketplace |
| `/agents` | Manage service agents (list, install, create) |
| `/ps` | Run a brief side query without interrupting the main task |
| `/debug` | Show internal state for debugging |
| `/exit` | Exit Agav |

</details>

## Installation

### Quick install (recommended)

One command, no Node.js required — Agav ships as a self-contained binary compiled with [Bun](https://bun.sh):

```bash
curl -fsSL https://agav.dev/install.sh | bash
```

For Windows PowerShell:

```powershell
irm https://www.agav.dev/install.ps1 | iex
```

> [!NOTE]
> The `www.` is deliberate. `agav.dev` redirects with a 308, and Windows
> PowerShell 5.1 cannot follow that status — it fails with
> `(308) Permanent Redirect`. `curl` follows it fine, so the other commands
> here use the short host.

For Windows Command Prompt (`cmd.exe`):

1. Download the installer:

   ```bat
   curl -fsSL https://agav.dev/install.cmd -o install.cmd
   ```

2. Run it from the same Command Prompt window:

   ```bat
   install.cmd
   ```

3. Remove `install.cmd` when you're done if you no longer need it:

   ```bat
   del install.cmd
   ```


Or download a specific platform binary from [Releases](../../releases).

### Pre-release builds

Betas ship as GitHub pre-releases, and the commands above deliberately skip them. Pass `--beta` to install the newest one instead:

**macOS / Linux:**

```bash
curl -fsSL https://agav.dev/install.sh | bash -s -- --beta
```

**Windows PowerShell:**

```powershell
& ([scriptblock]::Create((irm https://www.agav.dev/install.ps1))) --beta
```

> [!NOTE]
> `irm ... | iex -- --beta` does not work — it fails with a parameter binding
> error. `Invoke-Expression` takes the script as its positional `-Command`
> argument, so `--beta` claims that slot and the piped script has nowhere left
> to bind. PowerShell has no `--` end-of-options convention. The script block
> form above is how you pass any flag on Windows.

**Windows Command Prompt (`cmd.exe`):**

```bat
curl -fsSL https://agav.dev/install.cmd -o install.cmd
install.cmd --beta
del install.cmd
```

Setting `AGAV_BETA=1` in the environment does the same thing, which is handy when the flag is awkward to thread through.

Once you're on a pre-release, `agav update` leaves you there: it only ever looks at the latest stable release, and it compares `major.minor.patch` with the suffix stripped. From `0.2.0-beta.1` that means you won't be pulled back to `0.1.9`, but you won't move to `0.2.0` final either — you stay until `0.2.1` ships. To rejoin the stable channel sooner, re-run the installer without `--beta`.

### Staying up to date

Agav checks for a newer release on startup and updates itself. Run it by hand at any time:

```bash
agav update
```

The automatic check is skipped when `CI` is set, when `AGAV_NO_UPDATE=1`, and when stdout is not a terminal — so scripted runs never block on it. Each release directory replaces the last, so `~/.agav/packages/standalone/releases/` holds one version rather than growing on every update.

### Uninstall

Both installers accept two flags: `--uninstall` removes the binary and takes the `PATH` entry back out, and `--purge` does that *and* deletes your settings and history. `--purge` implies `--uninstall`, so you never need to pass both.

**macOS / Linux:**

```bash
curl -fsSL https://agav.dev/install.sh | bash -s -- --uninstall

# ...or, to delete your settings and history too:
curl -fsSL https://agav.dev/install.sh | bash -s -- --purge
```

**Windows PowerShell:**

```powershell
& ([scriptblock]::Create((irm https://www.agav.dev/install.ps1))) --uninstall

# ...or, to delete your settings and history too:
& ([scriptblock]::Create((irm https://www.agav.dev/install.ps1))) --purge
```

**Windows Command Prompt (`cmd.exe`):**

```bat
curl -fsSL https://agav.dev/install.cmd -o install.cmd
install.cmd --uninstall
del install.cmd
```

#### What each flag removes

| | `--uninstall` | `--purge` adds |
| --- | --- | --- |
| macOS / Linux | `~/.local/bin/agav`, `~/.agav/packages/standalone/`, the installer's block in your shell profile | `~/.agav/` |
| Windows | `%LOCALAPPDATA%\agav\agav.exe`, the `PATH` entry in your user environment | `%USERPROFILE%\.agav\` |

`--purge` deletes `config.json` (which holds your **encrypted API keys**), `prompt-history.json`, `keybindings.json`, and any installed `plugins/` and `skills/`. There is no undo.

Open a new terminal afterwards — the one you ran this in keeps the `PATH` it started with.

Agav also writes per-project directories inside repositories you've worked in: `.agav/` (cached images) and `.agav-worktrees/`. Uninstalling never touches those; delete them yourself if you want them gone.

<details>
<summary>Uninstalled with an older script?</summary>

Versions before 0.1.8 left the `PATH` entry behind. On macOS or Linux, delete this block from your shell profile — `~/.zprofile` (macOS + zsh), `~/.bash_profile` (macOS + bash), `~/.zshrc` or `~/.bashrc` (Linux), or `~/.profile`:

```bash
# >>> Agav installer >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< Agav installer <<<
```

On Windows, remove the Agav entry from your user `PATH` under **Settings → Edit environment variables for your account**.

</details>

### Run from source

Requires Node.js 22 or newer.

**macOS and Linux:**

```bash
git clone https://github.com/prapaa-ai/agav && cd agav && pnpm install --frozen-lockfile && pnpm build && pnpm start
```

**Windows:**

```powershell
git clone https://github.com/prapaa-ai/agav; cd agav; pnpm install --frozen-lockfile; pnpm build; pnpm start
```

### Optional external tools

Agav ships as a single binary with no bundled media libraries — those were 30 MB of download for features most sessions never touch. Attachments still work without any of these; the tools only widen what can be sent.

| Tool | What it adds | Install |
| --- | --- | --- |
| Poppler (`pdftoppm`) | Page images for PDFs. Without it, a PDF is read as text only. | `brew install poppler` · `apt install poppler-utils` · `winget install oschwartz10612.Poppler` |
| `sips` or ImageMagick | Downscales oversized images, and converts formats a model won't accept. Without either, PNG/JPEG/GIF/WebP under 3.5 MB are sent as-is and anything larger or in another format is refused. | `sips` ships with macOS · `brew install imagemagick` · `apt install imagemagick` · `winget install ImageMagick.ImageMagick` |
| LibreOffice | Higher-fidelity `.docx` and `.pptx` conversion. Without it, Agav extracts the text, tabs, and speaker notes itself. | `brew install --cask libreoffice` · point `LIBREOFFICE_PATH` at a non-standard install |

Agav says which tool is missing when it hits one of these limits, so there is nothing to configure up front.

## Provider setup

Anthropic, OpenAI, and Gemini need nothing more than their API key in the environment — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` — and Ollama just needs a local server running. OpenRouter needs one key for every model on its platform; Vertex AI takes a little more.

### OpenRouter

OpenRouter fronts hundreds of models from Anthropic, OpenAI, Google, Meta, DeepSeek, Qwen and others behind a single API — one key, one bill, no vendor lock-in. Agav talks to it through its OpenAI-compatible Chat Completions endpoint, so tool calling works as usual.

Create a key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) (they start with `sk-or-v1-`) and export it:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
agav --provider openrouter --model openrouter/auto
```

The default model is `openrouter/auto`, which lets OpenRouter pick a suitable model per request. Any slug from the [model catalog](https://openrouter.ai/models) can be passed with `--model` or `/model`:

```bash
agav -p openrouter -m anthropic/claude-sonnet-4.5
agav -p openrouter -m deepseek/deepseek-chat-v3.1
```

IDs ending in `-latest` prefixed with a tilde (`~anthropic/claude-sonnet-latest`) are OpenRouter aliases that always resolve to the newest version of a family — that's what `/fast` and `/deep` select:

| Command | Model |
| --- | --- |
| `/fast` | `~google/gemini-flash-latest` |
| `/deep` | `~anthropic/claude-sonnet-latest` |

Like the other providers' keys, an `openrouterApiKey` field in `.agav/config.json` or `~/.agav/config.json` is accepted and encrypted at rest — prefer the environment variable. `/model` lists live models straight from your account, and context-window sizes are looked up from OpenRouter so `/context` stays accurate across the whole catalog.

### NVIDIA NIM

```bash
export NVIDIA_API_KEY="nvapi-..."
agav --provider nvidia
agav --provider nvidia --model nvidia/nemotron-3.5-lightning-30b-a3b
```

Or in config:

```json
{
  "provider": "nvidia",
  "model": "nvidia/nemotron-3.5-lightning-30b-a3b"
}
```

All NVIDIA models use the `nvidia/` prefix. Context window sizes are detected automatically.

### Ollama

A local server on `localhost:11434` is picked up with no configuration. Point Agav elsewhere with flags or environment variables:

```bash
agav --provider ollama --model llama3.2
agav --provider ollama --ollama-endpoint http://192.168.1.5:11434
```

| Setting | Environment variable |
| --- | --- |
| `--ollama-host` | `OLLAMA_HOST` |
| `--ollama-port` | `OLLAMA_PORT` |
| `--ollama-endpoint` | `OLLAMA_ENDPOINT` |
| `--ollama-api-key` | `OLLAMA_API_KEY` (sent as `Authorization: Bearer`) |

Agav sizes the context window per model. `AGAV_OLLAMA_NUM_CTX` overrides that cap when you know your hardware can take more.

### Vertex AI

Vertex AI authenticates with a Google Cloud service-account JSON file. Point Agav at it, then select the provider:

```bash
export VERTEX_AI_CREDENTIALS_PATH=/path/to/service-account.json
agav --provider vertex-ai --model vertex/gemini-3.5-flash
# Claude partner models are supported by the same provider and credentials:
agav --provider vertex-ai --model vertex/claude-sonnet-4-5@20250929
```

Setting the credentials path is what enables the provider; there is no separate on/off flag to keep in sync with it. Agav uses the multi-region `global` endpoint by default — set `VERTEX_AI_LOCATION` (for example `us-east5`) to pin a region instead, which some Claude partner models require.

The same settings can go in `.agav/config.json` (project) or `~/.agav/config.json` (global):

```json
{
  "provider": "vertex-ai",
  "model": "vertex/gemini-3.5-flash",
  "vertexAICredentialsPath": "/path/to/service-account.json",
  "vertexAILocation": "global"
}
```

> [!IMPORTANT]
> **Protect the key file.** The service-account JSON holds an unencrypted private key that can act as that service account against your entire Google Cloud project. Unlike the API keys Agav encrypts into `config.json`, this file is yours to secure: keep it outside the repository, `chmod 600` it, and grant the service account only the `roles/aiplatform.user` role it actually needs.

The service account's `project_id`, `client_email`, `private_key`, and optional `token_uri` are read from that file. Agav exchanges the signed credentials for a short-lived OAuth token and refreshes it automatically. Both model families are addressed with the same `vertex/` prefix — `vertex/gemini-3.5-flash`, `vertex/claude-sonnet-4-5@20250929` — and Claude needs the versioned ID that Vertex AI exposes, including its `@YYYYMMDD` suffix. Vertex AI's implicit Gemini caching and Claude's ephemeral prompt caching are used automatically when supported.

## Configuration

Settings live in `~/.agav/config.json` globally and `.agav/config.json` per project, with the project file winning. Keybindings go in `keybindings.json` beside either. MCP servers are declared under an `mcpServers` key in the same config.

Drop an `AGAV.md` (or `.agavrc`) in a repository to add project-specific instructions to every session there.

### Environment variables

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | Provider credentials |
| `OPENROUTER_API_KEY` | OpenRouter credential (`sk-or-v1-...`) |
| `NVIDIA_API_KEY` | NVIDIA NIM credential (`nvapi-...`) |
| `VERTEX_AI_CREDENTIALS_PATH` / `VERTEX_AI_LOCATION` | Vertex AI service account and region |
| `OLLAMA_HOST` / `OLLAMA_PORT` / `OLLAMA_ENDPOINT` / `OLLAMA_API_KEY` | Ollama connection |
| `AGAV_OLLAMA_NUM_CTX` | Override the per-model Ollama context cap |
| `AGAV_PERMISSION` | Default tool permissions for `agav run`, same JSON as `--permission` |
| `AGAV_NO_UPDATE=1` | Disable the startup update check |
| `AGAV_NO_SANDBOX=1` | Run shell commands unsandboxed |
| `AGAV_KITTY_KEYBOARD` | Force the Kitty keyboard protocol on (`1`) or off (`0`) |
| `AGAV_MARKETPLACE_URL` | Override the agent marketplace URL (normally set via `agentMarketplace` in config) |
| `AGAV_DEBUG_GEMINI` | Verbose Gemini request logging |
| `LIBREOFFICE_PATH` | Path to LibreOffice, for document conversion |
| `NO_COLOR` | Disable coloured output |

`AGAV_SKIP_CHECKSUM=1` is read by the install scripts, not the CLI, and skips SHA-256 verification of the downloaded binary.

### Sandboxing

Shell commands run inside a sandbox when one is available: `sandbox-exec` (Seatbelt) on macOS, `bwrap` (Bubblewrap) on Linux, or a restricted Docker container (`--network=none`, capped CPU/memory) as a fallback. Agav detects the backend at runtime and falls back to running unsandboxed when none is present; across all backends, environment variables whose names look like credentials (`KEY`, `TOKEN`, `SECRET`, …) are stripped before child processes spawn. Set `AGAV_NO_SANDBOX=1` to opt out deliberately.

## Multi-line input

Press **Shift+Enter** to insert a newline instead of sending the message.

This requires the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) — without it your terminal transmits the exact same byte for Shift+Enter and Enter, so the modifier is lost before Agav ever sees it. Agav asks the terminal on startup and adapts: Kitty, Ghostty, WezTerm, foot, Alacritty and recent iTerm2 support it, and terminals that don't are left untouched.

`Ctrl+J` inserts a newline on **every terminal and every platform**, with no configuration. It is the fallback to reach for when Shift+Enter does nothing.

`Alt+Enter` (`Option+Enter` on macOS) also works, but only where the terminal sends Option as Meta.

The prompt footer only advertises the bindings your terminal can actually send, so whatever it shows will work.

To bind something else, set `newline` in `~/.agav/keybindings.json` (or `.agav/keybindings.json` in a project):

```json
{ "newline": ["shift+enter", "meta+enter", "ctrl+o"] }
```

If a terminal answers the protocol query but handles it badly, set `AGAV_KITTY_KEYBOARD=0` to force the legacy encoding, or `AGAV_KITTY_KEYBOARD=1` to force the protocol on.

<details>
<summary>macOS Terminal.app needs a little setup</summary>

Terminal.app implements neither the Kitty protocol nor CSI-u, and ships with Option-as-Meta **off**, so out of the box `Ctrl+J` is the only newline key. You can verify the limitation yourself — Enter and Shift+Enter both emit a single `0d` byte:

```bash
# press Enter, then Shift+Enter, then Ctrl+C to quit
( trap 'stty sane' EXIT INT; stty -icanon -echo; cat -v )
```

Both print `^M`. In a terminal that supports the protocol, Shift+Enter prints `^[[13;2u` instead.

Either of these recovers a dedicated key:

- **Option+Enter** — Settings → Profiles → **Keyboard** → check **Use Option as Meta key**.
- **Shift+Enter** — Settings → Profiles → **Keyboard** → **+** → Key `Return`, Modifier `Shift`, Action `Send Text`, then press the Esc key followed by Return so the field contains `\033\r`. Agav already binds that sequence to `newline`.

For Shift+Enter with no setup at all, use a terminal that implements the protocol: Kitty, Ghostty, WezTerm, foot, Alacritty, or a recent iTerm2.

</details>

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Esc` | Cancel a streaming response |
| `Ctrl+D` | Toggle tool detail panel |
| `Ctrl+G` | Toggle plan detail panel |
| `Ctrl+T` | Toggle thinking text visibility |
| `Ctrl+J` | Insert newline (works on every terminal) |
| `Ctrl+V` | Paste an image from clipboard |
| `Tab` | Cycle subagent focus |
| `Ctrl+R` | Retry last turn |
| `Ctrl+C` | Interrupt the agent |
| `Ctrl+L` | Clear screen |
| `Ctrl+Q` | Exit |

Shortcuts are customisable in `~/.agav/keybindings.json` or `.agav/keybindings.json`. See the [keybindings reference](https://docs.agav.dev/reference/keybindings) for the full list.

### Copying output

Agav runs inside your terminal, so copying uses your terminal's own selection mechanism:

- **macOS** — select text with the mouse, then `Cmd+C`. In Terminal.app and iTerm2 this works out of the box.
- **Linux** — select text, then `Ctrl+Shift+C` (or middle-click to paste a selection).
- **Windows Terminal** — select text, then `Ctrl+C` (when nothing is running) or `Ctrl+Shift+C`.

To save a full conversation to a file instead, use `/export` — it writes the entire session as Markdown.

## Extending

- **MCP servers** — declare them under `mcpServers` in `config.json`; local stdio servers and remote HTTP/SSE endpoints expose their tools and prompts to the session.
- **Skills** — reusable instruction bundles, loadable from a marketplace or written yourself.
- **Plugins** — loaded from `~/.agav/plugins/`.
- **Subagents** — the agent can delegate a scoped task to a fresh context and keep the noise out of yours.
- **Agent creation** — `/agents → [3] Create` opens a wizard to build custom agents with LLM-generated system prompts and workspace MCP server selection.

## Documentation

Detailed CLI documentation can be found in the [CLI reference](https://docs.agav.dev/reference/cli).

The source lives in the [`docs/`](docs/) directory — a Next.js app with Markdown content, full-text search, and dark mode. To run it locally:

```bash
cd docs
npm install
npm run dev
```

Then open [localhost:3000](http://localhost:3000).

Documentation is organised into:

- **[Getting Started](https://docs.agav.dev/docs/getting-started)** — installation, providers, quick start
- **[Features](https://docs.agav.dev/docs/features)** — tools, skills, agents, MCP, plugins
- **[Workflows](https://docs.agav.dev/docs/workflows)** — sessions, planning, automation, non-interactive mode
- **[Guides](https://docs.agav.dev/docs/guides)** — step-by-step recipes for common tasks
- **[Reference](https://docs.agav.dev/docs/reference)** — CLI flags, slash commands, configuration, keybindings

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the ground rules.

## Security

To report a vulnerability, follow [SECURITY.md](SECURITY.md). Please don't open a public issue for one.

## License

[Apache 2.0](LICENSE).

## Contact

Email: contact@agav.dev
Discord: [discord.gg/6u3m2JN6k](https://discord.gg/6u3m2JN6k)
