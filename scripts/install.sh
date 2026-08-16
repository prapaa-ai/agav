#!/bin/sh

set -eu

REPO="prapaa-ai/agav"
BINARY_NAME="agav"
VERSION="${AGAV_VERSION:-latest}"
NON_INTERACTIVE="${AGAV_NON_INTERACTIVE:-false}"

BIN_DIR="${AGAV_INSTALL_DIR:-$HOME/.local/bin}"
BIN_PATH="$BIN_DIR/$BINARY_NAME"
AGAV_HOME="${AGAV_HOME:-$HOME/.agav}"
STANDALONE_ROOT="$AGAV_HOME/packages/standalone"
RELEASES_DIR="$STANDALONE_ROOT/releases"
CURRENT_LINK="$STANDALONE_ROOT/current"
LOCK_FILE="$STANDALONE_ROOT/install.lock"

tmp_dir=""
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
    curl -fL "$url" -o "$output"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -O "$output" "$url"
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

file_sha256() {
  path="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$path" | sed 's/^.*= //'
    return
  fi

  warn "sha256sum, shasum, or openssl not found — skipping checksum verification."
  printf 'skip\n'
}

verify_checksum() {
  archive_path="$1"
  expected="$2"

  if [ "$expected" = "skip" ] || [ -z "$expected" ]; then
    return
  fi

  actual="$(file_sha256 "$archive_path")"
  if [ "$actual" = "skip" ]; then
    return
  fi

  if [ "$actual" != "$expected" ]; then
    err "Checksum verification failed."
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
}

release_lock() {
  exec 9>&- 2>/dev/null || true
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
  fi

  {
    printf '\n%s\n' "$begin_marker"
    printf '%s\n' "$path_line"
    printf '%s\n' "$end_marker"
  } >>"$profile"
  path_action="added"
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

for arg in "$@"; do
  case "$arg" in
    --uninstall)
      if [ -f "$BIN_PATH" ]; then
        rm -f "$BIN_PATH"
        rm -rf "$STANDALONE_ROOT"
        step "Uninstalled Agav from $BIN_DIR"
      else
        err "Agav not found at $BIN_PATH"
      fi
      exit 0
      ;;
    --version=*) VERSION="${arg#*=}" ;;
    --dir=*)     BIN_DIR="${arg#*=}"; BIN_PATH="$BIN_DIR/$BINARY_NAME" ;;
    --help|-h)
      cat <<EOF
Agav Installer

Usage: install.sh [OPTIONS]

Options:
  --version=<tag>    Install a specific version (default: latest)
  --dir=<path>       Install directory (default: ~/.local/bin)
  --uninstall        Remove Agav
  -h, --help         Show this help

Environment:
  AGAV_VERSION          Version to install; overridden by --version.
  AGAV_INSTALL_DIR      Install directory; overridden by --dir.
  AGAV_NON_INTERACTIVE  Set to 1/true/yes to skip prompts.
EOF
      exit 0
      ;;
  esac
done

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

# Verify it's a real binary
file_type="$(file "$archive_path" 2>/dev/null || echo "unknown")"
case "$file_type" in
  *executable* | *ELF* | *Mach-O*) ;;
  *)
    err "Downloaded file is not a valid binary: $file_type"
    exit 1
    ;;
esac

# Download and verify checksum if available
checksum_url="https://github.com/${REPO}/releases/download/v${resolved_version}/SHA256SUMS"
expected_checksum=""
if checksum_text="$(download_text "$checksum_url" 2>/dev/null)"; then
  expected_checksum="$(printf '%s\n' "$checksum_text" | awk -v asset="$asset_name" '$2 == asset { print $1 }')"
  if [ -n "$expected_checksum" ]; then
    step "Verifying checksum..."
    verify_checksum "$archive_path" "$expected_checksum"
    step "Checksum verified."
  fi
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

# Clean up old releases (keep current + previous)
if [ -d "$RELEASES_DIR" ]; then
  current_target="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
  for dir in "$RELEASES_DIR"/*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    if [ "$dir" != "$current_target" ] && [ "$(basename "$dir")" != "$resolved_version" ]; then
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
