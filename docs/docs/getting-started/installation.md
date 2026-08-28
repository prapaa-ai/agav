---
title: Install Agav
description: Install Agav and verify that the command is available
order: 2
---

# Install Agav

Use the prebuilt release unless you are developing Agav itself.

## macOS or Linux

```bash
curl -fsSL https://agav.dev/install.sh | bash
```

## Windows PowerShell

```powershell
irm https://agav.dev/install.ps1 | iex
```

## Windows Command Prompt

```bat
curl -fsSL https://agav.dev/install.cmd -o install.cmd && install.cmd && del install.cmd
```

The installer adds `agav` to your `PATH` automatically. Open a new terminal, then verify the installation:

```bash
agav --version
agav --help
```

If `agav` is still not found, your shell probably has not picked up the updated `PATH` yet. First open a fresh terminal window or start a new shell. If that still does not work, add the install directory to `PATH` manually:

- macOS or Linux default install directory: `~/.local/bin`
- Windows default install directory: `%LOCALAPPDATA%\\agav`

## Update Agav

```bash
agav update
```

To install a specific release, pass the version explicitly:

```bash
agav update 0.3.0
```

Set `AGAV_NO_UPDATE=1` to disable automatic update checks.

## Develop Agav from source

This route requires Node.js 22 or newer, pnpm 9 or newer, and Git:

```bash
git clone https://github.com/prapaa-ai/agav.git
cd code
corepack enable
pnpm install
pnpm start
```

Use the repository's `pnpm-lock.yaml` rather than mixing package managers. Run `pnpm link --global` if you want this checkout to provide the global `agav` command.

Next: [connect a model provider](/getting-started/providers).
