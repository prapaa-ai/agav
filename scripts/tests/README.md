# Installer tests

Tests for `scripts/install.sh` and `scripts/install.ps1`. These two files are
delivered outside the release pipeline — they are copied by hand to
`agav.dev` — so nothing else in the repo covers them.

Run everything your machine can run:

```bash
npm run test:installer          # or: sh scripts/tests/run-installer-tests.sh
```

It reports what it skipped instead of skipping silently.

No suite downloads a release binary or contacts GitHub. The shell suites only
ever reach `--uninstall`, `--purge` and `--help`, all of which return long
before the first `download_file` call site; the PowerShell suite replaces
`Save-FileWithProgress` and `Get-RemoteText` with local fakes that copy a
20-byte file. All four run green under `docker run --network none`.

The one exception is `install-ps1-lint.test.ps1`, which fetches PSScriptAnalyzer
from PSGallery when the module is not already installed. Offline it says so and
falls back to the parse and encoding checks rather than failing.

## The suites

| File | What it covers |
| --- | --- |
| `install-sh.test.sh` | `install.sh --uninstall` / `--purge` end to end, against a throwaway `HOME` |
| `install-sh-path.test.sh` | `add_to_path` in isolation, lifted out of the source with `awk` |
| `install-ps1.test.ps1` | `install.ps1` end to end — install, upgrade, checksums, uninstall, purge |
| `install-ps1-path.test.ps1` | The three PATH helpers, lifted out of the source via the PowerShell AST |
| `install-ps1-lint.test.ps1` | It parses, it is pure ASCII, and PSScriptAnalyzer is happy with it under 5.1 |

Each takes the installer path as its one optional argument, defaulting to the
sibling in `scripts/`.

The helpers are lifted out of the shipped file rather than copied, and the
PowerShell stub is regenerated from source on every run, so a test can never
pass against a stale duplicate of the code it is meant to be checking.

## Running one at a time

```bash
sh scripts/tests/install-sh.test.sh
dash scripts/tests/install-sh.test.sh          # install.sh is #!/bin/sh; dash is what Debian gives it
pwsh -NoProfile -File scripts/tests/install-ps1.test.ps1
```

Without a local `pwsh`, the runner falls back to Docker:

```bash
docker run --rm -v "$PWD/scripts:/s:ro" \
  mcr.microsoft.com/powershell:lts-7.4-ubuntu-22.04 \
  pwsh -NoProfile -File /s/tests/install-ps1.test.ps1 /s/install.ps1
```

CI runs the PowerShell suites natively on `windows-latest`, which is the only
place the registry half of the PATH handling is exercised for real. Linux and
macOS runs skip it: `Microsoft.Win32.Registry` throws there, and the installer
catches it, exactly as it would on a machine with a locked-down `HKCU`.

## What the PowerShell suite writes

`install-ps1.test.ps1` really does write `HKCU\Environment\PATH` on Windows,
because that is what an install does. It captures the original value before the
first test and restores it in a `finally` block. Everything else lives under a
directory in `%TEMP%`, and the purge tests refuse to run at all unless the data
directory they are about to delete resolves inside it.
