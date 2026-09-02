#!/bin/bash
set -e

TARGETS="${1:-native}"
OUTDIR="dist"

mkdir -p "$OUTDIR"

# Bundled skills are inlined into a generated TS module — a compiled binary
# resolves import.meta.url into Bun's virtual filesystem, so it cannot read them
# off disk. Refresh it here as well as in `pnpm build`, or editing a SKILL.md and
# going straight to a release ships the previous text on every platform.
node "$(dirname "$0")/gen-bundled-skills.mjs"

if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
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
    # Baseline variant without AVX2 for older CPUs and Intel 12th/13th gen
    # hybrid CPUs whose E-cores lack AVX2.  Also avoids a class of Bun
    # segfaults tied to SIMD code paths on Windows.
    build_target "windows-x64-baseline" "agav-windows-x64-baseline.exe"
    ;;
  *)
    build_target "$TARGETS" "agav-$TARGETS"
    ;;
esac

echo "Done."
