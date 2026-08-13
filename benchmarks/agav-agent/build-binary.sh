#!/usr/bin/env bash
#
# Build single-file agav executables from the LOCAL checkout, for use by the
# Harbor agav adapter. The agav GitHub repo is private and cannot be cloned
# inside a task container, so we build binaries here and upload the one matching
# each container's architecture (see agav_agent.py::_ARCH_BINARIES).
#
# Task images vary by dataset AND host: Terminal-Bench 2.0 images run amd64,
# but some datasets (e.g. openthoughts-tblite) run arm64-native on Apple Silicon.
# The container reports its arch via `uname -m`, so we build BOTH targets by
# default and let the adapter pick. Each target is built inside a matching-arch
# `oven/bun` container (so native modules resolve for the right target and it
# works even when the host has no bun/node installed).
#
# Outputs:
#   benchmarks/agav-agent/bin/agav-linux-x64     (linux/amd64)
#   benchmarks/agav-agent/bin/agav-linux-arm64   (linux/arm64)
#
# Usage:
#   benchmarks/agav-agent/build-binary.sh              # build any missing/stale targets
#   FORCE=1 benchmarks/agav-agent/build-binary.sh      # always rebuild
#   ARCHES="arm64" benchmarks/agav-agent/build-binary.sh   # build just one target
#
# Requires: Docker running. Nothing outside benchmarks/ is modified.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${SCRIPT_DIR}/bin"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1}"

# Which targets to build. Override with e.g. ARCHES="arm64".
ARCHES="${ARCHES:-x64 arm64}"

# arch token -> docker --platform.
arch_platform() {
  case "$1" in
    x64)   echo "linux/amd64" ;;
    arm64) echo "linux/arm64" ;;
    *)     echo "error: unknown arch '$1' (supported: x64, arm64)" >&2; return 1 ;;
  esac
}

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker does not appear to be running. Start Docker and retry." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

build_one() {
  local arch="$1"
  local platform out_name out_path
  platform="$(arch_platform "${arch}")"
  out_name="agav-linux-${arch}"
  out_path="${OUT_DIR}/${out_name}"

  # Source-less host (e.g. the amd64 run VM): the agav repo is private and isn't
  # shipped, so we can't build. Use the prebuilt binary if it's here, else fail
  # with a clear pointer to build it on a machine that has the checkout.
  if [[ ! -d "${REPO_ROOT}/source" ]]; then
    if [[ -f "${out_path}" ]]; then
      echo "Using prebuilt ${out_path} (no agav source on this host)."
      return 0
    fi
    echo "error: no agav source at ${REPO_ROOT}/source and no prebuilt ${out_path}." >&2
    echo "       Build it on a host with the agav checkout, then copy bin/${out_name} here." >&2
    return 1
  fi

  # Skip rebuild when the binary is newer than every source file (unless FORCE=1).
  if [[ -z "${FORCE:-}" && -f "${out_path}" ]]; then
    if [[ -z "$(find "${REPO_ROOT}/source" "${REPO_ROOT}/package.json" \
                     "${REPO_ROOT}/pnpm-lock.yaml" "${REPO_ROOT}/tsconfig.json" \
                     -newer "${out_path}" 2>/dev/null)" ]]; then
      echo "Up to date: ${out_path} (set FORCE=1 to rebuild)"
      return 0
    fi
  fi

  echo "Building ${out_name} from ${REPO_ROOT} via ${BUN_IMAGE} (${platform})..."

  # Copy just the sources into the container's own filesystem (so the host's repo,
  # and anything outside benchmarks/, is never written to), install, then compile.
  docker run --rm --platform "${platform}" \
    -v "${REPO_ROOT}:/src:ro" \
    -v "${OUT_DIR}:/out" \
    -e HUSKY=0 \
    "${BUN_IMAGE}" bash -c '
      set -euo pipefail
      mkdir -p /build
      cp -a /src/package.json /src/pnpm-lock.yaml /src/pnpm-workspace.yaml \
            /src/tsconfig.json /build/
      cp -a /src/source /build/source
      cp -a /src/assets /build/assets 2>/dev/null || true
      cd /build
      export HUSKY=0
      bun install
      # Ink optional dependency needed by the compiled bundle.
      bun install react-devtools-core 2>/dev/null || true
      bun build source/cli.tsx --compile --outfile /out/'"${out_name}"'
      /out/'"${out_name}"' --version
    '

  echo "Built: ${out_path} ($(du -sh "${out_path}" | cut -f1))"
}

for arch in ${ARCHES}; do
  build_one "${arch}"
done
