#!/usr/bin/env bash
#
# Package everything needed to run the agav benchmark on a native amd64 VM into a
# single tarball, so the (private) agav source never has to leave this machine.
#
# The bundle contains benchmarks/ (adapter package, run/verify/upload scripts,
# tasks.txt) plus the PREBUILT agav binaries in agav-agent/bin/. It deliberately
# excludes the local .venv (rebuilt on the VM) and any jobs/ output.
#
# On the VM you only need Docker + uv; build-binary.sh will detect the prebuilt
# binary and skip building (the agav source is not shipped).
#
# Usage:
#   benchmarks/package-for-vm.sh              # -> ./agav-benchmarks-vm.tgz
#   OUT=/tmp/foo.tgz benchmarks/package-for-vm.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT="${OUT:-${REPO_ROOT}/agav-benchmarks-vm.tgz}"

# The amd64 VM runs amd64 containers, so the x64 binary is mandatory. Build it
# first if we have the source (no-op if already up to date); otherwise require it.
BIN_X64="${SCRIPT_DIR}/agav-agent/bin/agav-linux-x64"
if [[ ! -f "${BIN_X64}" ]]; then
  if [[ -d "${REPO_ROOT}/source" ]]; then
    echo "Prebuilt x64 binary missing; building it from local source..."
    ARCHES="x64" "${SCRIPT_DIR}/agav-agent/build-binary.sh"
  else
    echo "error: ${BIN_X64} not found and no agav source to build it from." >&2
    echo "       Run this on a machine with the agav checkout (or build-binary.sh) first." >&2
    exit 1
  fi
fi

echo "Packaging benchmarks/ -> ${OUT}"
# Bundle benchmarks/ (with a top-level 'benchmarks/' path on extraction),
# excluding the venv, job output, and python build cruft.
tar \
  --exclude='benchmarks/.venv' \
  --exclude='benchmarks/jobs' \
  --exclude='benchmarks/**/__pycache__' \
  --exclude='benchmarks/**/*.egg-info' \
  --exclude='benchmarks/**/.pytest_cache' \
  --exclude='benchmarks/agav-benchmarks-vm.tgz' \
  -C "${REPO_ROOT}" -czf "${OUT}" benchmarks

size="$(du -sh "${OUT}" | cut -f1)"
echo "-------------------------------------------------------------"
echo "Bundle : ${OUT} (${size})"
echo
echo "Next (on an amd64 Linux VM with Docker + uv installed):"
echo "  scp ${OUT} user@<vm>:~/"
echo "  ssh user@<vm>"
echo "  tar -xzf agav-benchmarks-vm.tgz && cd benchmarks"
echo "  uv venv .venv && source .venv/bin/activate && uv pip install -e agav-agent"
echo "  export OPENAI_API_KEY=sk-...            # gpt-5.5 key"
echo "  cd .. && EXTRA='-k 1' ./benchmarks/run-tasks.sh --all   # smoke test first"
echo "  ./benchmarks/verify-run.sh"
echo "  ./benchmarks/run-tasks.sh --all         # real -k 5 run"
echo "  harbor auth login && PUBLIC=1 ./benchmarks/upload.sh"
