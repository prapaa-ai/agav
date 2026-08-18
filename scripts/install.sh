#!/bin/sh

set -eu

REPO="prapaa-ai/agav"
BINARY_NAME="agav"
VERSION="${AGAV_VERSION:-latest}"
NON_INTERACTIVE="${AGAV_NON_INTERACTIVE:-false}"
SKIP_CHECKSUM="${AGAV_SKIP_CHECKSUM:-0}"

BIN_DIR="${AGAV_INSTALL_DIR:-$HOME/.local/bin}"
BIN_PATH="$BIN_DIR/$BINARY_NAME"
AGAV_HOME="${AGAV_HOME:-$HOME/.agav}"
STANDALONE_ROOT="$AGAV_HOME/packages/standalone"
RELEASES_DIR="$STANDALONE_ROOT/releases"
CURRENT_LINK="$STANDALONE_ROOT/current"
LOCK_FILE="$STANDALONE_ROOT/install.lock"
LOCK_DIR="$STANDALONE_ROOT/install.lock.d"

tmp_dir=""
lock_dir_held=0
path_action="already"
path_profile=""
conflict_manager=""
conflict_path=""

# --- Output helpers ---

step() {
  printf '  ==> %s\n' "$1"
}

warn() {
  printf '  WARNING: %s\n' "$1" >&2
}

err() {
  printf '  ERROR: %s\n' "$1" >&2
}

# --- Download helpers ---

download_file() {
  url="$1"
  output="$2"

  if command -v curl >/dev/null 2>&1; then
    if [ -t 2 ]; then
      curl -fL --progress-bar "$url" -o "$output"
    else
      curl -fsSL "$url" -o "$output"
    fi
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    if [ -t 2 ]; then
      # --show-progress keeps the bar but drops the verbose request log. It
      # landed in wget 1.16 and is absent from busybox wget, so probe first.
      if wget --help 2>&1 | grep -q -- "--show-progress"; then
        wget -q --show-progress -O "$output" "$url"
      else
        wget -O "$output" "$url"
      fi
    else
      wget -q -O "$output" "$url"
    fi
    return
  fi

  err "curl or wget is required to install Agav."
  exit 1
}

download_text() {
  url="$1"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -q -O - "$url"
    return
  fi

  err "curl or wget is required to install Agav."
  exit 1
}

# --- Checksum verification ---
#
# This is the only thing standing between a hijacked download and a binary the
# user is about to run, so every path through it fails closed. Set
# AGAV_SKIP_CHECKSUM=1 to opt out deliberately; nothing else may skip silently.

checksum_bypassed() {
  case "$SKIP_CHECKSUM" in
    1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss]) return 0 ;;
  esac
  return 1
}

# Prints the hex digest on success; prints nothing and returns 1 when the
# machine has no SHA-256 tool at all.
file_sha256() {
  path="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
    return 0
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
    return 0
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$path" | sed 's/^.*= //'
    return 0
  fi

  return 1
}

checksum_abort() {
  err "$1"
  err "Re-run with AGAV_SKIP_CHECKSUM=1 to install without verification."
  rm -f "$2"
  exit 1
}

verify_checksum() {
  archive_path="$1"
  expected="$2"

  if [ -z "$expected" ]; then
    checksum_abort "No published checksum to verify against." "$archive_path"
  fi

  if ! actual="$(file_sha256 "$archive_path")" || [ -z "$actual" ]; then
    checksum_abort \
      "Cannot verify the download: none of sha256sum, shasum, or openssl is installed." \
      "$archive_path"
  fi

  # Case-fold both sides: openssl and sha256sum agree on lowercase, but a
  # hand-edited SHA256SUMS need not.
  actual="$(printf '%s' "$actual" | tr 'A-F' 'a-f')"
  expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"

  if [ "$actual" != "$expected" ]; then
    err "Checksum verification failed — refusing to install."
    err "Expected: $expected"
    err "Actual:   $actual"
    rm -f "$archive_path"
    exit 1
  fi
}

# --- Version helpers ---

normalize_version() {
  case "$1" in
    "" | latest) printf 'latest\n' ;;
    v*)          printf '%s\n' "${1#v}" ;;
    *)           printf '%s\n' "$1" ;;
  esac
}

version_from_binary() {
  bin_path="$1"
  if [ ! -x "$bin_path" ]; then
    return 1
  fi
  "$bin_path" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

current_installed_version() {
  version="$(version_from_binary "$BIN_PATH" || true)"
  if [ -n "$version" ]; then
    printf '%s\n' "$version"
  fi
}

# --- Platform detection ---

detect_platform() {
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)
      err "Agav supports macOS and Linux. Use install.ps1 on Windows."
      exit 1
      ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64)  arch="x64" ;;
    arm64 | aarch64)  arch="arm64" ;;
    *)
      err "Unsupported architecture: $(uname -m)"
      exit 1
      ;;
  esac

  # Rosetta 2 detection — use native arm64 binary
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
      arch="arm64"
    fi
  fi

  asset_name="agav-${os}-${arch}"

  case "$os" in
    darwin)
      if [ "$arch" = "arm64" ]; then
        platform_label="macOS (Apple Silicon)"
      else
        platform_label="macOS (Intel)"
      fi
      ;;
    linux)
      if [ "$arch" = "arm64" ]; then
        platform_label="Linux (ARM64)"
      else
        platform_label="Linux (x64)"
      fi
      ;;
  esac
}

# --- Conflict detection ---

detect_conflicting_install() {
  existing_path="$(command -v agav 2>/dev/null || true)"

  if [ -z "$existing_path" ] || [ "$existing_path" = "$BIN_PATH" ]; then
    return
  fi

  # Check if it's managed by npm/bun
  if [ -f "$existing_path" ] && grep -qF "#!/usr/bin/env node" "$existing_path" 2>/dev/null; then
    case "$existing_path" in
      *".bun"*) conflict_manager="bun" ;;
      *)        conflict_manager="npm" ;;
    esac
    conflict_path="$existing_path"
    step "Detected existing $conflict_manager-managed Agav at $existing_path"
    warn "Multiple installs can be ambiguous — PATH order decides which one runs."
  fi
}

handle_conflicting_install() {
  if [ -z "$conflict_manager" ]; then
    return
  fi

  case "$conflict_manager" in
    bun) uninstall_cmd="bun remove -g agav-cli" ;;
    *)   uninstall_cmd="npm uninstall -g agav-cli" ;;
  esac

  if prompt_yes_no "Uninstall the existing $conflict_manager-managed Agav now?"; then
    step "Running: $uninstall_cmd"
    if ! sh -c "$uninstall_cmd"; then
      warn "Failed to uninstall. Continuing with standalone install."
    fi
  else
    warn "Leaving existing install. PATH order will determine which agav runs."
  fi
}

# --- Install lock ---

acquire_lock() {
  mkdir -p "$STANDALONE_ROOT"

  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    flock 9
    return
  fi

  if [ "$(uname -s)" = "Darwin" ] && command -v lockf >/dev/null 2>&1; then
    : >>"$LOCK_FILE"
    exec 9<>"$LOCK_FILE"
    lockf 9
    return
  fi

  # Stock macOS ships neither flock nor lockf, so without this the lock was a
  # silent no-op and two concurrent installers could race on `rm -rf` of the
  # same release directory. mkdir is atomic on every POSIX filesystem.
  waited=0
  while [ "$waited" -lt 120 ]; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      lock_dir_held=1
      printf '%s\n' "$$" >"$LOCK_DIR/pid" 2>/dev/null || true
      return
    fi

    # Reclaim the lock from an installer that was killed before it could clean
    # up, otherwise one Ctrl+C would wedge every future run on this machine.
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -z "$holder" ] || ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$LOCK_DIR"
      continue
    fi

    if [ "$waited" -eq 0 ]; then
      step "Waiting for another Agav installer (pid $holder) to finish..."
    fi
    sleep 1
    waited=$((waited + 1))
  done

  warn "Timed out waiting for the install lock — continuing without it."
}

release_lock() {
  exec 9>&- 2>/dev/null || true
  if [ "$lock_dir_held" -eq 1 ]; then
    lock_dir_held=0
    rm -rf "$LOCK_DIR"
  fi
}

# --- PATH management ---

pick_profile() {
  case "$os:${SHELL:-}" in
    darwin:*/zsh)  printf '%s\n' "$HOME/.zprofile" ;;
    darwin:*/bash) printf '%s\n' "$HOME/.bash_profile" ;;
    linux:*/zsh)   printf '%s\n' "$HOME/.zshrc" ;;
    linux:*/bash)  printf '%s\n' "$HOME/.bashrc" ;;
    *)             printf '%s\n' "$HOME/.profile" ;;
  esac
}

add_to_path() {
  path_action="already"
  path_profile=""

  case ":$PATH:" in
    *":$BIN_DIR:"*) return ;;
  esac

  profile="$(pick_profile)"
  path_profile="$profile"
  begin_marker="# >>> Agav installer >>>"
  end_marker="# <<< Agav installer <<<"
  path_line="export PATH=\"$BIN_DIR:\$PATH\""

  if [ -f "$profile" ] && grep -qF "$begin_marker" "$profile" 2>/dev/null; then
    if grep -qF "$path_line" "$profile" 2>/dev/null; then
      path_action="configured"
      return
    fi

    # A block is already here but points somewhere else — a previous run with a
    # different --dir. Rewrite that block instead of appending a second one,
    # which used to stack up a new stanza on every re-run.
    rewritten="${TMPDIR:-/tmp}/agav-profile.$$"
    if awk -v begin="$begin_marker" -v end="$end_marker" -v line="$path_line" '
      $0 == begin { print; print line; skipping = 1; next }
      $0 == end   { print; skipping = 0; next }
      skipping    { next }
                  { print }
    ' "$profile" >"$rewritten" 2>/dev/null && [ -s "$rewritten" ]; then
      # Write through the existing file rather than mv'ing over it, so the
      # profile keeps its inode, mode, and ownership.
      if cat "$rewritten" >"$profile"; then
        rm -f "$rewritten"
        path_action="added"
        return
      fi
    fi
    rm -f "$rewritten"
    warn "Could not update the Agav block in $profile — add this line yourself:"
    warn "$path_line"
    path_action="already"
    return
  fi

  {
    printf '\n%s\n' "$begin_marker"
    printf '%s\n' "$path_line"
    printf '%s\n' "$end_marker"
  } >>"$profile"
  path_action="added"
}

# Take the installer's block back out of every profile that has one.
#
# add_to_path writes this block but nothing ever removed it, so uninstalling
# left a dead PATH entry pointing at a deleted directory — permanently, and in
# a file most people never read.
#
# Every candidate profile is scanned rather than just pick_profile's answer:
# the block may have been written by an earlier run under a different shell,
# and pick_profile depends on $os, which is not detected until after uninstall
# has already run.
remove_path_block() {
  path_removed_from=""

  for profile in \
    "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
    [ -f "$profile" ] || continue
    grep -qF "# >>> Agav installer >>>" "$profile" 2>/dev/null || continue

    stripped="${TMPDIR:-/tmp}/agav-uninstall.$$"
    # Blank lines are buffered and only emitted once something follows them, so
    # the blank line add_to_path printed before the block goes with it instead
    # of piling up one more empty line per install/uninstall cycle.
    if awk '
      $0 == "# >>> Agav installer >>>" { skipping = 1; blanks = 0; next }
      $0 == "# <<< Agav installer <<<" { skipping = 0; next }
      skipping { next }
      /^[[:space:]]*$/ { blanks++; next }
      { while (blanks > 0) { print ""; blanks-- } print }
      END { while (blanks > 0) { print ""; blanks-- } }
    ' "$profile" >"$stripped" 2>/dev/null; then
      # Write through the existing file rather than mv'ing over it, so the
      # profile keeps its inode, mode, and ownership. No -s guard here: a
      # profile that contained nothing but our block correctly ends up empty.
      if cat "$stripped" >"$profile"; then
        path_removed_from="$path_removed_from $profile"
      fi
    fi
    rm -f "$stripped"
  done
}

# --- Prompts ---

prompt_yes_no() {
  prompt="$1"

  case "$NON_INTERACTIVE" in
    1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss]) return 1 ;;
  esac

  if ( : </dev/tty ) 2>/dev/null; then
    printf '%s [y/N] ' "$prompt" >/dev/tty
    if ! IFS= read -r answer </dev/tty; then
      return 1
    fi
  elif [ -t 0 ]; then
    printf '%s [y/N] ' "$prompt"
    if ! IFS= read -r answer; then
      return 1
    fi
  else
    return 1
  fi

  case "$answer" in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

# --- Atomic symlink swap ---

replace_symlink() {
  link_path="$1"
  link_target="$2"
  tmp_link="${link_path}.tmp.$$"

  rm -f "$tmp_link"
  ln -s "$link_target" "$tmp_link"
  mv -f "$tmp_link" "$link_path" 2>/dev/null || {
    rm -f "$link_path"
    mv -f "$tmp_link" "$link_path"
  }
}

# --- Parse args ---

# Two passes: collect every flag first, then act. Acting inline meant
# `--uninstall --dir=/opt/bin` uninstalled from the default directory, because
# --uninstall was reached before --dir had been read.
do_uninstall=0
do_purge=0

for arg in "$@"; do
  case "$arg" in
    --uninstall) do_uninstall=1 ;;
    # --purge is useless on its own, so it implies --uninstall rather than
    # making people pass both.
    --purge)     do_uninstall=1; do_purge=1 ;;
    --version=*) VERSION="${arg#*=}" ;;
    --dir=*)     BIN_DIR="${arg#*=}"; BIN_PATH="$BIN_DIR/$BINARY_NAME" ;;
    --help|-h)
      cat <<EOF
Agav Installer

Usage: install.sh [OPTIONS]

Options:
  --version=<tag>    Install a specific version (default: latest)
  --dir=<path>       Install directory (default: ~/.local/bin)
  --uninstall        Remove Agav, keeping your settings and history
  --purge            Remove Agav and delete ~/.agav as well
  -h, --help         Show this help

Environment:
  AGAV_VERSION          Version to install; overridden by --version.
  AGAV_INSTALL_DIR      Install directory; overridden by --dir.
  AGAV_NON_INTERACTIVE  Set to 1/true/yes to skip prompts.
  AGAV_SKIP_CHECKSUM    Set to 1/true/yes to install without verifying SHA-256.
EOF
      exit 0
      ;;
  esac
done

if [ "$do_uninstall" -eq 1 ]; then
  removed=0
  # -e follows the symlink and is false when the target is already gone, so a
  # dangling ~/.local/bin/agav used to report "not found" and leave both the
  # broken link and the ~100 MB release tree behind. -L catches it.
  if [ -e "$BIN_PATH" ] || [ -L "$BIN_PATH" ]; then
    rm -f "$BIN_PATH"
    removed=1
  fi
  if [ -d "$STANDALONE_ROOT" ]; then
    rm -rf "$STANDALONE_ROOT"
    removed=1
  fi
  # rmdir, not rm -rf: if anything else put files under packages/ we have no
  # business deleting them. Fails harmlessly when the directory is not empty.
  rmdir "$AGAV_HOME/packages" 2>/dev/null || true

  remove_path_block
  if [ -n "$path_removed_from" ]; then
    removed=1
  fi

  # Purge runs before the not-found check on purpose: someone who deleted the
  # binary by hand and then ran --purge to finish the job should get their data
  # directory cleaned up, not "Agav not found" with the data still sitting there.
  purged=0
  if [ "$do_purge" -eq 1 ] && [ -d "$AGAV_HOME" ]; then
    rm -rf "$AGAV_HOME"
    purged=1
    removed=1
  fi

  if [ "$removed" -eq 1 ]; then
    step "Uninstalled Agav from $BIN_DIR"
  else
    err "Agav not found at $BIN_PATH"
    exit 1
  fi

  for profile in $path_removed_from; do
    step "Removed the Agav PATH entry from $profile"
  done

  if [ "$purged" -eq 1 ]; then
    step "Removed $AGAV_HOME"
  elif [ -d "$AGAV_HOME" ]; then
    step "Kept your settings and history in $AGAV_HOME — delete them with --purge."
  fi

  if [ -n "$path_removed_from" ]; then
    step "Restart your shell to drop $BIN_DIR from PATH."
  fi
  exit 0
fi

# --- Main ---

detect_platform

VERSION="$(normalize_version "$VERSION")"

step "Agav installer for $platform_label"

# Resolve version
if [ "$VERSION" = "latest" ]; then
  step "Resolving latest release..."
  release_json="$(download_text "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null)" || {
    err "Could not fetch release info. GitHub API may be unavailable."
    exit 1
  }
  resolved_version="$(printf '%s\n' "$release_json" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/')"
  if [ -z "$resolved_version" ]; then
    err "Could not determine latest version."
    exit 1
  fi
else
  resolved_version="$VERSION"
fi

step "Version: $resolved_version"

# Check if already installed at this version
current_ver="$(current_installed_version)"
if [ "$current_ver" = "$resolved_version" ]; then
  step "Agav $resolved_version is already installed."
  exit 0
fi

if [ -n "$current_ver" ]; then
  step "Upgrading Agav $current_ver → $resolved_version"
else
  step "Installing Agav $resolved_version"
fi

detect_conflicting_install

tmp_dir="$(mktemp -d)"
cleanup() {
  release_lock
  if [ -n "$tmp_dir" ]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT INT TERM

# Setup directories
mkdir -p "$RELEASES_DIR" "$BIN_DIR"
acquire_lock

# Download binary
download_url="https://github.com/${REPO}/releases/download/v${resolved_version}/${asset_name}"
archive_path="$tmp_dir/$asset_name"

step "Downloading $asset_name..."
download_file "$download_url" "$archive_path" || {
  err "Download failed. Check: https://github.com/${REPO}/releases"
  exit 1
}

# Verify the checksum before anything else looks at the file. This is the
# authoritative integrity gate, so it runs first and every failure is fatal.
if checksum_bypassed; then
  warn "AGAV_SKIP_CHECKSUM is set — installing without verifying the download."
else
  checksum_url="https://github.com/${REPO}/releases/download/v${resolved_version}/SHA256SUMS"
  step "Verifying checksum..."
  if ! checksum_text="$(download_text "$checksum_url" 2>/dev/null)"; then
    checksum_abort "Could not download $checksum_url." "$archive_path"
  fi
  # sha256sum writes "<hex>  <name>", so the asset is field 2.
  expected_checksum="$(printf '%s\n' "$checksum_text" | awk -v asset="$asset_name" '$2 == asset { print $1 }')"
  if [ -z "$expected_checksum" ]; then
    checksum_abort "SHA256SUMS has no entry for $asset_name." "$archive_path"
  fi
  verify_checksum "$archive_path" "$expected_checksum"
  step "Checksum verified."
fi

# A friendly diagnostic, not a security control — the checksum above already
# proved the bytes are the published ones. Skip it when `file` is missing
# rather than failing: slim containers routinely omit it, and treating an
# absent tool as a corrupt download blocked the install outright.
if command -v file >/dev/null 2>&1; then
  file_type="$(file -b "$archive_path" 2>/dev/null || true)"
  case "$file_type" in
    *executable* | *ELF* | *Mach-O*) ;;
    *)
      err "Downloaded file is not a valid binary: ${file_type:-unknown}"
      exit 1
      ;;
  esac
fi

# Install to versioned release directory
release_dir="$RELEASES_DIR/$resolved_version"
rm -rf "$release_dir"
mkdir -p "$release_dir"
cp "$archive_path" "$release_dir/$BINARY_NAME"
chmod 0755 "$release_dir/$BINARY_NAME"

# Update current symlink
replace_symlink "$CURRENT_LINK" "$release_dir"

# Update visible command
replace_symlink "$BIN_PATH" "$CURRENT_LINK/$BINARY_NAME"

release_lock

# Verify installation
if ! "$BIN_PATH" --version >/dev/null 2>&1; then
  err "Installation verification failed. The binary may not be compatible with this platform."
  exit 1
fi

installed_ver="$(version_from_binary "$BIN_PATH" || echo "$resolved_version")"
step "Agav $installed_ver installed to $BIN_PATH"

# PATH management
add_to_path

handle_conflicting_install

start_hint=""
case "$path_action" in
  added)
    printf '\n'
    step "PATH updated in $path_profile"
    start_hint="Open a new terminal first, or run: export PATH=\"$BIN_DIR:\$PATH\""
    ;;
  configured)
    printf '\n'
    step "PATH already configured in $path_profile"
    ;;
esac

# Clean up superseded releases. Compare by directory name, not by path:
# replace_symlink may have written a relative target, and comparing a relative
# readlink against an absolute path never matched, so the live release was only
# spared by the separate $resolved_version test.
if [ -d "$RELEASES_DIR" ]; then
  current_name="$(basename "$(readlink "$CURRENT_LINK" 2>/dev/null || true)" 2>/dev/null || true)"
  for dir in "$RELEASES_DIR"/*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    name="$(basename "$dir")"
    if [ "$name" != "$resolved_version" ] && [ "$name" != "$current_name" ]; then
      rm -rf "$dir"
    fi
  done
fi

# Deliberately do NOT launch Agav from here. Under `curl … | bash` this script
# has no controlling terminal of its own, so an exec'd Ink UI inherits a stdin
# the terminal driver never hands keystrokes to — it paints its first frame and
# then sits there dead to input, Ctrl+C included. Telling the user to type
# `agav` costs one line and always works.
printf '\n'
printf '  ────────────────────────────────────────────\n'
printf '\n'
printf '   Agav %s is installed.\n' "$installed_ver"
printf '\n'
if [ -n "$start_hint" ]; then
  printf '   %s\n' "$start_hint"
  printf '\n'
fi
printf '   Type  agav  to get started.\n'
printf '\n'
printf '   Docs      https://agav.dev\n'
printf '   Update    agav update\n'
printf '\n'
printf '  ────────────────────────────────────────────\n'
printf '\n'
