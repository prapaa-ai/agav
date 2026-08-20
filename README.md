<div align="center">

# Agav

**A terminal-native AI coding assistant for real repositories**

<p>
  <img alt="Version" src="https://img.shields.io/github/package-json/v/prapaa-ai/agav?style=for-the-badge&amp;label=version&amp;color=111">
  <img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-111?style=for-the-badge">
</p>

</div>

<div align="center">
  <img src="https://agav.dev/preview.gif" alt="Agav preview" width="100%" style="border-radius: 16px;" />
</div>

## What it does

Agav reads, searches and edits the repository you run it in, and runs the commands you'd otherwise run yourself.

- **Five providers** — Anthropic, OpenAI, Gemini, Vertex AI and Ollama, switchable mid-session with `/model`.
- **Sandboxed commands** — shell tools run under Seatbelt on macOS and Bubblewrap on Linux where either is available.
- **Non-interactive mode** — `agav run` and `agav --print` make the same agent scriptable from CI, with per-tool permissions and optional JSON Schema output.
- **Sessions that survive** — resume, branch, name, search and export past conversations; `/compact` reclaims context without starting over. Plans are saved per-session and picked back up on resume.
- **Extensible** — MCP servers, plugins, skills and subagents.
- **Repository-aware editing** — LSP-backed queries, notebook support, test running, and `/undo` for the last file change.

## Quickstart

Run it inside a repository:

```bash
agav
```

Pick a provider and model, or take the defaults:

```bash
agav --provider openai --model gpt-4o
agav --provider vertex-ai --model vertex/gemini-3.5-flash
agav -r                                  # resume a session (lists them if no id)
```

Non-interactive, for scripts and CI:

```bash
agav run "review the code in src/"
agav run --permission '{"bash":"deny"}' "check for security issues"
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
| `--provider`, `-p` | `anthropic`, `openai`, `gemini`, `vertex-ai` or `ollama` (default: `anthropic`) |
| `--model`, `-m` | Model name |
| `--effort` | Reasoning effort: `low`, `medium`, `high` or `max` (default: `high`) |
| `--print`, `-P` | Run the prompt, print the result, exit |
| `--stream` | Stream text to stdout in real time, with `--print` |
| `--output-schema` | Require pipe-mode output to match an inline JSON Schema, or `@file` |
| `--permission` | JSON tool permissions for run mode |
| `--resume`, `-r [id]` | Resume a session; prefix match if an id is given |
| `--auto-accept`, `-y` | Skip tool confirmations |
| `--deny-writes` | Block all write operations |
| `--openai-api` | OpenAI API mode: `responses` or `chat` (default: `responses`) |
| `--ollama-host` / `--ollama-port` / `--ollama-endpoint` / `--ollama-api-key` | Ollama connection |
| `--help`, `-h` / `--version`, `-v` | Help, version |

## Slash commands

<details>
<summary>27 commands, available in any session</summary>

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
| `/history` | List saved sessions or load one by index |
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

## Provider setup

Anthropic, OpenAI, and Gemini need nothing more than their API key in the environment — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` — and Ollama just needs a local server running. Vertex AI takes a little more.

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
| `VERTEX_AI_CREDENTIALS_PATH` / `VERTEX_AI_LOCATION` | Vertex AI service account and region |
| `OLLAMA_HOST` / `OLLAMA_PORT` / `OLLAMA_ENDPOINT` / `OLLAMA_API_KEY` | Ollama connection |
| `AGAV_OLLAMA_NUM_CTX` | Override the per-model Ollama context cap |
| `AGAV_PERMISSION` | Default tool permissions for `agav run`, same JSON as `--permission` |
| `AGAV_NO_UPDATE=1` | Disable the startup update check |
| `AGAV_NO_SANDBOX=1` | Run shell commands unsandboxed |
| `AGAV_KITTY_KEYBOARD` | Force the Kitty keyboard protocol on (`1`) or off (`0`) |
| `AGAV_DEBUG_GEMINI` | Verbose Gemini request logging |
| `LIBREOFFICE_PATH` | Path to LibreOffice, for document conversion |
| `NO_COLOR` | Disable coloured output |

`AGAV_SKIP_CHECKSUM=1` is read by the install scripts, not the CLI, and skips SHA-256 verification of the downloaded binary.

### Sandboxing

Shell commands run inside a sandbox when one is available: `sandbox-exec` (Seatbelt) on macOS, `bwrap` (Bubblewrap) on Linux. Agav detects the backend at runtime and falls back to running unsandboxed when neither is present. Set `AGAV_NO_SANDBOX=1` to opt out deliberately.

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
| `Tab` | Cycle subagent focus |
| `Ctrl+R` | Retry last turn |
| `Ctrl+L` | Clear screen |
| `Ctrl+Q` | Exit |

Shortcuts are customisable in `~/.agav/keybindings.json` or `.agav/keybindings.json`. See the [keybindings reference](https://docs.agav.dev/reference/keybindings) for the full list.

## Extending

- **MCP servers** — declare them under `mcpServers` in `config.json`; their tools and prompts join the session.
- **Skills** — reusable instruction bundles, loadable from a marketplace or written yourself.
- **Plugins** — loaded from `~/.agav/plugins/`.
- **Subagents** — the agent can delegate a scoped task to a fresh context and keep the noise out of yours.

## Documentation

Detailed CLI documentation can be found [here](https://docs.agav.dev).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the ground rules.

## Security

To report a vulnerability, follow [SECURITY.md](SECURITY.md). Please don't open a public issue for one.

## License

[Apache 2.0](LICENSE).

## Contact

Email: contact@agav.dev
