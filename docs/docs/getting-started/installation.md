---
title: Install Agav
description: Install Agav and verify that the command is available
order: 2
---

# Install Agav

One command, no Node.js required — Agav ships as a self-contained binary compiled with [Bun](https://bun.sh). Use the prebuilt release unless you are developing Agav itself.

These docs describe the 0.2.9 release line. The default installer follows the latest **published stable** release, which can lag behind the source tree. Check [Releases](https://github.com/prapaa-ai/agav/releases) for available versions and use `agav --version` to see what you actually installed.

| Platform | Release binaries |
| --- | --- |
| macOS | Apple Silicon (`darwin-arm64`) and Intel (`darwin-x64`). The installer selects arm64 on Apple Silicon even when launched from a Rosetta shell. |
| Linux | x64 and arm64. |
| Windows | x64 `.exe` and x64 baseline `.exe`. The PowerShell installer selects baseline when it does not detect AVX2. On ARM64 it installs an x64 executable, which requires x64 emulation; there is no native Windows ARM64 artifact. |

## macOS or Linux

```bash
curl -fsSL https://agav.dev/install.sh | bash
```

## Windows PowerShell

```powershell
irm https://www.agav.dev/install.ps1 | iex
```

> **Note:** Use the `www.` URL in Windows PowerShell. It avoids a `(308) Permanent Redirect` error if the short host redirects; Windows PowerShell 5.1 cannot follow that redirect.

## Windows Command Prompt

```bat
curl -fsSL https://agav.dev/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Command Prompt uses a wrapper around the PowerShell installer. Alternatively, download the binary for your platform from [Releases](https://github.com/prapaa-ai/agav/releases), compare its SHA-256 against the published checksum, and make it executable on macOS/Linux (`chmod +x <file>`).

The installers normally configure `PATH` for you. A manual binary download does not. Open a new terminal, then verify the installation (these commands work in PowerShell too):

```bash
agav --version
agav --help
```

If `agav` is still not found, your shell probably has not picked up the updated `PATH` yet. First open a fresh terminal window or start a new shell. If that still does not work, add the install directory to `PATH` manually:

- macOS or Linux default install directory: `~/.local/bin`
- Windows default install directory: `%LOCALAPPDATA%\agav` (`$env:LOCALAPPDATA\agav` in PowerShell)

On macOS, the installer writes to `~/.zprofile` for zsh or `~/.bash_profile` for bash; on Linux, it uses `~/.zshrc` or `~/.bashrc`. Other shells fall back to `~/.profile`, which your shell may not read. On Windows it tries to update your user `Path`. If a different copy is being picked up, see [installation troubleshooting](/reference/troubleshooting#agav-is-not-found-or-runs-an-older-version).

## Pre-release builds

Betas ship as GitHub pre-releases. `--beta` asks the installer for the newest entry returned by the GitHub releases list, which includes both stable and pre-release builds. It can therefore select a stable build. To install a particular published beta, use `--version=<tag>` instead.

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

Setting `AGAV_BETA=1` has the same effect (`export AGAV_BETA=1` on macOS/Linux, `$env:AGAV_BETA = '1'` in PowerShell). Both installers also accept `--version=<tag>` and `--dir=<path>` or their environment equivalents, `AGAV_VERSION` and `AGAV_INSTALL_DIR`. For a PowerShell install path with spaces, pass the whole argument as one string, for example `'--dir=C:\My Tools\Agav'`, after the script block above.

## Update Agav

Standalone builds can check for updates on startup. To check manually:

```bash
agav update
```

On builds with channel-aware updates, both the startup check and untargeted `agav update` follow the installed version: stable installs stay on stable; `-beta.N` installs can move to a higher beta number with the same version core or a release with a higher `major.minor.patch`. A beta is not downgraded to the same-core stable automatically. After updating to a stable build, subsequent checks stay on stable. Older binaries may behave differently.

To switch explicitly, run `agav update <version>` with a published tag (with or without the leading `v`), or rerun the installer with `--version=<tag>`. To return to the latest stable with the installer, omit `--beta` and clear any `AGAV_BETA` or explicit version override first. If you need the Windows baseline build, **use the PowerShell installer to update**: the in-app updater in this release line requests the standard x64 asset, not the baseline asset. Set `$env:AGAV_NO_UPDATE = '1'` before launching Agav to disable the startup check in that PowerShell session.

The startup check is skipped when `CI` is nonempty, `AGAV_NO_UPDATE=1`, or stdout is not a terminal. This does not disable explicit `agav update`. Source checkouts must be updated through Git, not by replacing the Node or Bun executable.

## Uninstall

Both installers accept two flags: `--uninstall` removes the installed binary and cleans up its `PATH` configuration; `--purge` also deletes the Agav user data directory. `--purge` implies `--uninstall`. If you installed into a custom directory, pass the same `--dir=<path>` or `AGAV_INSTALL_DIR` again. For a manually downloaded executable, remove it and any `PATH` entry you added yourself.

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

`--purge` deletes user data such as `config.json` (which can contain saved credentials), session and prompt history, keybindings, installed extensions, and the local voice model. Back up anything you want to keep; there is no undo.

Open a new terminal afterwards so its `PATH` reflects the change.

Uninstalling does not remove repository `.agav/` directories (which can hold project settings, agents, and attachments) or `.agav-worktrees/`. Review those directories for files or uncommitted work before removing them.

## Optional external tools

The release executable does not bundle these attachment converters. They are optional, but without them some previews are text-only or some images cannot be attached. The native helper for [voice input](/features/voice-input) is separate from these tools and is embedded in release builds; the speech model is downloaded separately with your approval.

| Tool | What it adds | Install |
| --- | --- | --- |
| Poppler (`pdftoppm`) | Page images for PDFs. Without it, a PDF is read as text only. | `brew install poppler` · `apt install poppler-utils` · `winget install oschwartz10612.Poppler` |
| `sips` or ImageMagick | Downscales oversized images, and converts formats a model won't accept. Without either, PNG/JPEG/GIF/WebP up to 3.5 MiB are sent as-is and anything larger or in another format is refused. | `sips` ships with macOS · `brew install imagemagick` · `apt install imagemagick` · `winget install ImageMagick.ImageMagick` |
| LibreOffice | Higher-fidelity `.docx` and `.pptx` conversion. Without it, Agav extracts the text, tabs, and speaker notes itself. | `brew install --cask libreoffice` · `apt install libreoffice` on Debian/Ubuntu · on Windows, put `soffice.exe` on `PATH` or set `LIBREOFFICE_PATH` to the full executable path |

Agav says which tool is missing when it hits one of these limits, so there is nothing to configure up front.

## Develop Agav from source

This route requires Git, Node.js 22.13.0 or newer, and the pnpm version pinned in the root `package.json`. Install pnpm first (or enable it with `corepack enable` if Corepack is installed):

```bash
git clone https://github.com/prapaa-ai/agav.git
cd agav
pnpm install --frozen-lockfile
pnpm start
```

Use the repository's `pnpm-lock.yaml` rather than mixing package managers. A plain source run does not embed the native release helpers. Use the standalone release for normal use, especially on Windows, where [shell and test tools require the sandbox helper by default](/reference/security#windows).

Next: [connect a model provider](/getting-started/providers).
