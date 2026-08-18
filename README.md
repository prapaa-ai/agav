<div align="center">

<pre align="center" style="color: #0891B2;">
   █████╗  ██████╗  █████╗ ██╗   ██╗
  ██╔══██╗██╔════╝ ██╔══██╗██║   ██║
  ███████║██║  ███╗███████║██║   ██║
  ██╔══██║██║   ██║██╔══██║╚██╗ ██╔╝
  ██║  ██║╚██████╔╝██║  ██║ ╚████╔╝
  ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝  ╚═══╝
</pre>

**A terminal-native AI coding assistant for real repositories**

<p>
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.2-111?style=for-the-badge">
  <img alt="Node.js" src="https://img.shields.io/badge/node-22%2B-111?style=for-the-badge&logo=node.js&logoColor=83CD29">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.x-111?style=for-the-badge&logo=typescript&logoColor=3178C6">
  <img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-111?style=for-the-badge">
</p>

</div>

<div align="center">
  <img src="./assets/image.png" alt="Agav preview" width="100%" style="border-radius: 16px;" />
</div>

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

### Uninstall

Both installers accept `--uninstall`.

**macOS / Linux:**

```bash
curl -fsSL https://agav.dev/install.sh | bash -s -- --uninstall
```

**Windows PowerShell:**

```powershell
& ([scriptblock]::Create((irm https://www.agav.dev/install.ps1))) --uninstall
```

**Windows Command Prompt (`cmd.exe`):**

```bat
curl -fsSL https://agav.dev/install.cmd -o install.cmd
install.cmd --uninstall
del install.cmd
```

If you installed via a package manager instead, remove it the same way:

```bash
npm uninstall -g agav-cli    # or: bun remove -g agav-cli
```

#### What `--uninstall` leaves behind

It removes the binary, but deliberately keeps your settings and does not edit your shell profile:

| | Removed | Left behind |
| --- | --- | --- |
| macOS / Linux | `~/.local/bin/agav`, `~/.agav/packages/standalone/` | `~/.agav/` config, `PATH` line in your shell profile |
| Windows | `%LOCALAPPDATA%\agav\agav.exe` | `%USERPROFILE%\.agav\` config, `PATH` entry in your user environment |

To remove your configuration as well — this deletes `config.json` (which holds your **encrypted API keys**), `prompt-history.json`, `keybindings.json`, and any installed `plugins/` and `skills/`:

```bash
rm -rf ~/.agav                       # macOS / Linux
```

```powershell
Remove-Item -Recurse -Force "$HOME\.agav"    # Windows
```

To remove the `PATH` entry, delete this block from your shell profile — `~/.zprofile` (macOS + zsh), `~/.bash_profile` (macOS + bash), `~/.zshrc` or `~/.bashrc` (Linux), or `~/.profile`:

```bash
# >>> Agav installer >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< Agav installer <<<
```

On Windows, remove the Agav entry from your user `PATH` under **Settings → Edit environment variables for your account**.

Agav also writes per-project directories inside repositories you've worked in — `.agav/` (cached images) and `.agav-worktrees/`. Delete those individually if you want them gone.

### Run from source

#### macOS

```bash
git clone https://github.com/prapaa-ai/agav && cd agav && pnpm install --frozen-lockfile && pnpm build && pnpm start
```

#### Linux

```bash
git clone https://github.com/prapaa-ai/agav && cd agav && pnpm install --frozen-lockfile && pnpm build && pnpm start
```

#### Windows

```powershell
git clone https://github.com/prapaa-ai/agav; cd agav; pnpm install --frozen-lockfile; pnpm build; pnpm start
```

## Provider setup

Anthropic, OpenAI, and Gemini need nothing more than their API key in the environment — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` — and Ollama just needs a local server running. Vertex AI takes a little more.

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

## Multi-line input

Press **Shift+Enter** to insert a newline instead of sending the message.

This requires the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) — without it your terminal transmits the exact same byte for Shift+Enter and Enter, so the modifier is lost before Agav ever sees it. Agav asks the terminal on startup and adapts: Kitty, Ghostty, WezTerm, foot, Alacritty and recent iTerm2 support it, and terminals that don't are left untouched.

`Ctrl+J` inserts a newline on **every terminal and every platform**, with no configuration. It is the fallback to reach for when Shift+Enter does nothing.

`Alt+Enter` (`Option+Enter` on macOS) also works, but only where the terminal sends Option as Meta.

The prompt footer only advertises the bindings your terminal can actually send, so whatever it shows will work.

### macOS Terminal.app

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

To bind something else, set `newline` in `~/.agav/keybindings.json` (or `.agav/keybindings.json` in a project):

```json
{ "newline": ["shift+enter", "meta+enter", "ctrl+o"] }
```

If a terminal answers the protocol query but handles it badly, set `AGAV_KITTY_KEYBOARD=0` to force the legacy encoding, or `AGAV_KITTY_KEYBOARD=1` to force the protocol on.

## Documentation

Detailed CLI documentation can be found [here](https://docs.agav.dev).

## Contact

Email: contact@agav.dev
