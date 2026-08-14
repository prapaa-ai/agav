#!/bin/bash
set -e

TARGETS="${1:-native}"
OUTDIR="dist"

mkdir -p "$OUTDIR"

if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# Ensure react-devtools-core is available (Ink optional dependency)
if [ ! -d "node_modules/react-devtools-core" ]; then
  bun install react-devtools-core 2>/dev/null || true
fi

build_target() {
  local target="$1"
  local outname="$2"

  echo "Building for $target..."
  if [ "$target" = "native" ]; then
    bun build source/cli.tsx --compile --outfile "$OUTDIR/$outname"
  else
    bun build source/cli.tsx --compile --target="bun-$target" --outfile "$OUTDIR/$outname"
  fi
  echo "Built: $OUTDIR/$outname ($(du -sh "$OUTDIR/$outname" | cut -f1))"
}

case "$TARGETS" in
  native)
    build_target "native" "agav"
    ;;
  all)
    build_target "darwin-arm64" "agav-darwin-arm64"
    build_target "darwin-x64" "agav-darwin-x64"
    build_target "linux-x64" "agav-linux-x64"
    build_target "linux-arm64" "agav-linux-arm64"
    # No windows-arm64: Bun has no such compile target. ARM64 Windows runs
    # the x64 build under emulation.
    build_target "windows-x64" "agav-windows-x64.exe"
    ;;
  *)
    build_target "$TARGETS" "agav-$TARGETS"
    ;;
esac

echo "Done."
