#!/bin/sh
# Run every installer test suite that this machine can run, and skip the rest
# out loud rather than silently.
#
#   sh scripts/tests/run-installer-tests.sh
#
# The POSIX suites run under every shell that is installed, because install.sh
# is `#!/bin/sh` and that is dash on Debian, bash on Fedora, and ash in a
# BusyBox container. The PowerShell suites prefer a native pwsh and fall back to
# Docker; with neither, they are reported as skipped.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
PS_IMAGE="mcr.microsoft.com/powershell:lts-7.4-ubuntu-22.04"

failed=0
skipped=""

heading() { printf '\n\033[1m===== %s =====\033[0m\n' "$1"; }
note() { printf '\033[36m%s\033[0m\n' "$1"; }
skip() { printf '\033[33mSKIP  %s\033[0m\n' "$1"; skipped="$skipped  - $1
"; }
track() { if [ "$1" -ne 0 ]; then failed=$((failed + 1)); fi; }

# --- shellcheck -------------------------------------------------------------
heading "shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -s sh "$SCRIPTS/install.sh" "$HERE/install-sh.test.sh" \
    "$HERE/install-sh-path.test.sh" "$HERE/run-installer-tests.sh"; then
    note "clean"
  else
    track 1
  fi
elif command -v docker >/dev/null 2>&1; then
  note "no local shellcheck; using docker"
  if docker run --rm -v "$SCRIPTS:/mnt:ro" koalaman/shellcheck:stable \
    -s sh /mnt/install.sh /mnt/tests/install-sh.test.sh \
    /mnt/tests/install-sh-path.test.sh /mnt/tests/run-installer-tests.sh; then
    note "clean"
  else
    track 1
  fi
else
  skip "shellcheck (install it, or start Docker)"
fi

# --- POSIX suites, once per available shell ---------------------------------
# BusyBox ships ash as an applet rather than a binary named `ash`, so ask for it
# by the name people actually have.
for shell in sh dash bash busybox; do
  command -v "$shell" >/dev/null 2>&1 || { skip "install.sh suites under $shell (not installed)"; continue; }
  if [ "$shell" = "busybox" ]; then runner="busybox sh"; else runner="$shell"; fi
  heading "install.sh suites under $shell"
  # shellcheck disable=SC2086
  $runner "$HERE/install-sh.test.sh" "$SCRIPTS/install.sh" || track 1
  # shellcheck disable=SC2086
  $runner "$HERE/install-sh-path.test.sh" "$SCRIPTS/install.sh" || track 1
done

# --- PowerShell suites ------------------------------------------------------
ps_suites="install-ps1.test.ps1 install-ps1-path.test.ps1 install-ps1-lint.test.ps1"

if command -v pwsh >/dev/null 2>&1; then
  for suite in $ps_suites; do
    heading "$suite (native pwsh)"
    pwsh -NoProfile -File "$HERE/$suite" "$SCRIPTS/install.ps1" || track 1
  done
elif command -v docker >/dev/null 2>&1; then
  note "no local pwsh; using docker"
  for suite in $ps_suites; do
    heading "$suite (docker)"
    # Read-only: nothing under scripts/ should be written, and a failure to
    # mount that way is a bug worth hearing about.
    docker run --rm -v "$SCRIPTS:/s:ro" "$PS_IMAGE" \
      pwsh -NoProfile -File "/s/tests/$suite" /s/install.ps1 || track 1
  done
else
  skip "install.ps1 suites (install pwsh, or start Docker)"
fi

printf '\n'
if [ -n "$skipped" ]; then
  printf '\033[33mSkipped:\033[0m\n%s' "$skipped"
fi
if [ "$failed" -eq 0 ]; then
  printf '\033[32mAll suites that ran passed.\033[0m\n'
else
  printf '\033[31m%s suite(s) failed.\033[0m\n' "$failed"
  exit 1
fi
