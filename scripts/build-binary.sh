#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
TARGET="native"
WITH_VOICE=false
ALL_FEATURES=false
TARGET_SET=false
for ARG in "$@"; do
  case "$ARG" in
    --voice) WITH_VOICE=true ;;
    --all-features) ALL_FEATURES=true ;;
    --) ;;
    --help|-h)
      echo "Usage: build-binary.sh [native|all|darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-x64-baseline] [--voice|--all-features]"
      echo "Default builds omit native features. --voice enables voice; all enables every feature on every target."
      exit 0 ;;
    *)
      if [ "$TARGET_SET" = true ]; then echo "Unexpected build argument: $ARG" >&2; exit 1; fi
      TARGET="$ARG"; TARGET_SET=true ;;
  esac
done
# Keep the complete feature selection here as optional build features are added.
if [ "$TARGET" = "all" ]; then ALL_FEATURES=true; fi
if [ "$ALL_FEATURES" = true ]; then WITH_VOICE=true; fi
case "$TARGET" in
  all)
    if [ -z "${AGAV_VOICE_HELPER_DIR:-}" ]; then
      echo "all builds every feature on every target. Set AGAV_VOICE_HELPER_DIR to a directory of matching prebuilt native helpers (agav-voice-<platform>-<arch>[.exe])." >&2
      exit 1
    fi
    # Check every helper before compiling anything; never silently omit a feature.
    for HELPER_TARGET in darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64; do
      HELPER_FILE="$AGAV_VOICE_HELPER_DIR/agav-voice-$HELPER_TARGET"
      if [ "$HELPER_TARGET" = "win32-x64" ]; then HELPER_FILE="$HELPER_FILE.exe"; fi
      if [ ! -f "$HELPER_FILE" ] || [ ! -r "$HELPER_FILE" ]; then
        echo "Missing readable helper for $HELPER_TARGET: $HELPER_FILE (AGAV_VOICE_HELPER_DIR)." >&2
        exit 1
      fi
    done
    for PLATFORM in darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-x64-baseline; do
      AGAV_VOICE_HELPER_PATH="" bash scripts/build-binary.sh "$PLATFORM" --all-features
    done
    exit 0 ;;
  native|darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-x64-baseline) ;;
  *) echo "Unsupported binary target: $TARGET" >&2; exit 1 ;;
esac
HOST=$(node -p 'process.platform + "-" + process.arch')
VOICE_TARGET="$TARGET"
case "$TARGET" in
  native) VOICE_TARGET="$HOST" ;;
  windows-*) VOICE_TARGET="win32-x64" ;;
esac
case "$VOICE_TARGET" in
  darwin-arm64|darwin-x64|linux-x64|linux-arm64|win32-x64) ;;
  *) echo "Unsupported native voice helper target: $VOICE_TARGET" >&2; exit 1 ;;
esac
if [ "$WITH_VOICE" = true ] && [ -z "${AGAV_VOICE_HELPER_PATH:-}" ] && [ -n "${AGAV_VOICE_HELPER_DIR:-}" ]; then
  AGAV_VOICE_HELPER_PATH="$AGAV_VOICE_HELPER_DIR/agav-voice-$VOICE_TARGET"
  if [ "$VOICE_TARGET" = "win32-x64" ]; then AGAV_VOICE_HELPER_PATH="$AGAV_VOICE_HELPER_PATH.exe"; fi
fi
if [ "$WITH_VOICE" = true ] && [ "$VOICE_TARGET" != "$HOST" ] && [ -z "${AGAV_VOICE_HELPER_PATH:-}" ]; then
  echo "Cross-target $TARGET requires AGAV_VOICE_HELPER_PATH pointing to a matching $VOICE_TARGET prebuilt helper." >&2
  exit 1
fi

# Keep the developer stub (or any previous generated source) out of the binary
# build's changes, including when helper validation or Bun compilation fails.
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/agav-binary.XXXXXX")
BUNDLE="source/voice/bundled-runtime.ts"
cp -p "$BUNDLE" "$SCRATCH/bundled-runtime.ts"
cleanup() {
  local status=$?
  trap - EXIT
  if ! cp -p "$SCRATCH/bundled-runtime.ts" "$BUNDLE"; then
    echo "Cannot restore $BUNDLE; original retained in $SCRATCH" >&2
    exit 1
  fi
  rm -rf "$SCRATCH"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$WITH_VOICE" = true ]; then
if [ -n "${AGAV_VOICE_HELPER_PATH:-}" ]; then
  HELPER=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$AGAV_VOICE_HELPER_PATH")
else
  node scripts/build-voice-helper.mjs "$VOICE_TARGET" "$SCRATCH/voice-assets"
  HELPER="$SCRATCH/voice-assets/agav-voice-$VOICE_TARGET"
  if [ "$VOICE_TARGET" = "win32-x64" ]; then HELPER="$HELPER.exe"; fi
fi
# Architecture/header and license validation applies to native and cross builds.
node scripts/embed-voice-helper.mjs "$VOICE_TARGET" "$HELPER" "$BUNDLE"
# Cross-target executables cannot run here; native prebuilt helpers must speak
# the same protocol as the bundled client before they can enter a binary.
if [ "$VOICE_TARGET" = "$HOST" ]; then
  if ! PROTOCOL=$("$HELPER" --protocol-version); then
    echo "Native voice helper must report --protocol-version 1." >&2
    exit 1
  fi
  if [ "$(printf '%s' "$PROTOCOL" | tr -d '\r')" != "1" ]; then
    echo "Native voice helper must report --protocol-version 1." >&2
    exit 1
  fi
fi

else
  echo "Building without bundled voice (use --voice to include the native helper)."
fi

node scripts/gen-bundled-skills.mjs
if ! command -v bun &>/dev/null; then
  echo "Bun is required to compile Agav; install Bun before running this script." >&2
  exit 1
fi
mkdir -p dist
OUTNAME="agav-$TARGET"
if [ "$TARGET" = "native" ]; then OUTNAME="agav"; fi
if [ "$VOICE_TARGET" = "win32-x64" ]; then OUTNAME="$OUTNAME.exe"; fi
echo "Building for $TARGET (native voice: $WITH_VOICE)..."
# Windows must build natively to preserve console initialization and avoid
# Bun's Windows --target cache bug. Both variants select CPU features at runtime.
if [ "$TARGET" = "native" ] || { [ "$HOST" = "win32-x64" ] && [ "$VOICE_TARGET" = "$HOST" ]; }; then
  bun build source/cli.tsx --compile --outfile "dist/$OUTNAME"
else
  bun build source/cli.tsx --compile --target="bun-$TARGET" --outfile "dist/$OUTNAME"
fi
echo "Built: dist/$OUTNAME ($(du -sh "dist/$OUTNAME" | cut -f1))"
