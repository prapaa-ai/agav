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
irm https://agav.dev/install.ps1 | iex
```

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
& ([scriptblock]::Create((irm https://agav.dev/install.ps1))) --uninstall
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

## Documentation

Detailed CLI documentation can be found [here](https://docs.agav.dev).

## Contact

Email: contact@agav.dev
