---
title: Install Agav
description: Install Agav and verify that the command is available
order: 2
---

# Install Agav

One command, no Node.js required — Agav ships as a self-contained binary compiled with [Bun](https://bun.sh). Use the prebuilt release unless you are developing Agav itself.

## macOS or Linux

```bash
curl -fsSL https://agav.dev/install.sh | bash
```

## Windows PowerShell

```powershell
irm https://www.agav.dev/install.ps1 | iex
```

> **Note:** The `www.` prefix is deliberate. `agav.dev` redirects with a 308 status, and Windows PowerShell 5.1 cannot follow that redirect — it fails with `(308) Permanent Redirect`. `curl` follows it fine, so the other commands on this page use the short host.

## Windows Command Prompt

```bat
curl -fsSL https://agav.dev/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Or download a specific platform binary from [Releases](https://github.com/prapaa-ai/agav/releases).

The installer adds `agav` to your `PATH` automatically. Open a new terminal, then verify the installation:

```bash
agav --version
agav --help
```

If `agav` is still not found, your shell probably has not picked up the updated `PATH` yet. First open a fresh terminal window or start a new shell. If that still does not work, add the install directory to `PATH` manually:

- macOS or Linux default install directory: `~/.local/bin`
- Windows default install directory: `%LOCALAPPDATA%\\agav`

## Pre-release builds

Betas ship as GitHub pre-releases, and the commands above deliberately skip them. Pass `--beta` to install the newest one instead:

**macOS / Linux:**

```bash
curl -fsSL https://agav.dev/install.sh | bash -s -- --beta
```

**Windows PowerShell:**

```powershell
& ([scriptblock]::Create((irm https://www.agav.dev/install.ps1))) --beta
```

> **Note:** `irm ... | iex -- --beta` does not work — it fails with a parameter binding error. `Invoke-Expression` takes the script as its positional `-Command` argument, so `--beta` claims that slot and the piped script has nowhere left to bind. PowerShell has no `--` end-of-options convention. The script block form above is how you pass any flag on Windows.

**Windows Command Prompt:**

```bat
curl -fsSL https://agav.dev/install.cmd -o install.cmd
install.cmd --beta
del install.cmd
```

Setting `AGAV_BETA=1` in the environment does the same thing, which is handy when the flag is awkward to thread through.

Once you're on a pre-release, `agav update` leaves you there: it only ever looks at the latest stable release, and it compares `major.minor.patch` with the suffix stripped. From `0.2.0-beta.1` that means you won't be pulled back to `0.1.9`, but you won't move to `0.2.0` final either — you stay until `0.2.1` ships. To rejoin the stable channel sooner, re-run the installer without `--beta`.

## Update Agav

Agav checks for a newer release on startup and updates itself. Run it by hand at any time:

```bash
agav update
```

To install a specific release, pass the version explicitly:

```bash
agav update 0.3.0
```

The automatic check is skipped when `CI` is set, when `AGAV_NO_UPDATE=1`, and when stdout is not a terminal — so scripted runs never block on it.

## Uninstall

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

**Windows Command Prompt:**

```bat
curl -fsSL https://agav.dev/install.cmd -o install.cmd
install.cmd --uninstall
del install.cmd
```

### What each flag removes

| | `--uninstall` | `--purge` adds |
| --- | --- | --- |
| macOS / Linux | `~/.local/bin/agav`, `~/.agav/packages/standalone/`, the installer's block in your shell profile | `~/.agav/` |
| Windows | `%LOCALAPPDATA%\agav\agav.exe`, the `PATH` entry in your user environment | `%USERPROFILE%\.agav\` |

`--purge` deletes `config.json` (which holds your **encrypted API keys**), `prompt-history.json`, `keybindings.json`, and any installed `plugins/` and `skills/`. There is no undo.

Open a new terminal afterwards — the one you ran this in keeps the `PATH` it started with.

Agav also writes per-project directories inside repositories you've worked in: `.agav/` (cached images) and `.agav-worktrees/`. Uninstalling never touches those; delete them yourself if you want them gone.

## Optional external tools

Agav ships as a single binary with no bundled media libraries — those were 30 MB of download for features most sessions never touch. Attachments still work without any of these; the tools only widen what can be sent.

| Tool | What it adds | Install |
| --- | --- | --- |
| Poppler (`pdftoppm`) | Page images for PDFs. Without it, a PDF is read as text only. | `brew install poppler` · `apt install poppler-utils` · `winget install oschwartz10612.Poppler` |
| `sips` or ImageMagick | Downscales oversized images, and converts formats a model won't accept. Without either, PNG/JPEG/GIF/WebP under 3.5 MB are sent as-is and anything larger or in another format is refused. | `sips` ships with macOS · `brew install imagemagick` · `apt install imagemagick` · `winget install ImageMagick.ImageMagick` |
| LibreOffice | Higher-fidelity `.docx` and `.pptx` conversion. Without it, Agav extracts the text, tabs, and speaker notes itself. | `brew install --cask libreoffice` · point `LIBREOFFICE_PATH` at a non-standard install |

Agav says which tool is missing when it hits one of these limits, so there is nothing to configure up front.

## Develop Agav from source

This route requires Node.js 22 or newer, pnpm 9 or newer, and Git:

```bash
git clone https://github.com/prapaa-ai/agav.git
cd agav
corepack enable
pnpm install
pnpm start
```

Use the repository's `pnpm-lock.yaml` rather than mixing package managers. Run `pnpm link --global` if you want this checkout to provide the global `agav` command.

Next: [connect a model provider](/getting-started/providers).
