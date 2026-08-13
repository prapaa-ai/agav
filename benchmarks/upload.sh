#!/usr/bin/env bash
#
# Upload a Harbor job's results to the Harbor Hub, attributed to our org by
# default. Harbor has no persistent "default org" setting and `harbor run` takes
# no org at all — the org is only ever attached at UPLOAD time via --share-org.
# So this wrapper bakes that default in: every upload is shared with `prapaa`
# unless overridden.
#
# Usage:
#   ./upload.sh                       # upload the most recent job dir (jobs/*)
#   ./upload.sh jobs/2026-08-03__...  # upload a specific job dir
#   PUBLIC=1 ./upload.sh <job_dir>    # publish to the public leaderboard
#   ORG="teamA teamB" ./upload.sh ... # share with other/multiple orgs
#   ORG="" ./upload.sh <job_dir>      # upload with no org share (owner only)
#
# Visibility defaults to PRIVATE so nothing lands on the public leaderboard by
# accident. Set PUBLIC=1 for a real leaderboard submission.
#
# Environment overrides:
#   ORG      Org(s) to share with (space-separated)  (default: prapaa)
#   PUBLIC   1 -> --public, else --private           (default: unset -> private)
#   HARBOR   harbor executable                        (default: auto-detected)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ORG="${ORG-prapaa}"          # default org; ORG="" disables sharing
PUBLIC="${PUBLIC:-}"

# Resolve the harbor executable: prefer one on PATH, else the repo venv.
HARBOR="${HARBOR:-}"
if [[ -z "${HARBOR}" ]]; then
  if command -v harbor >/dev/null 2>&1; then
    HARBOR="harbor"
  elif [[ -x "${REPO_ROOT}/.venv/bin/harbor" ]]; then
    HARBOR="${REPO_ROOT}/.venv/bin/harbor"
  else
    echo "error: 'harbor' not found on PATH or in ${REPO_ROOT}/.venv/bin." >&2
    echo "       Install it with:  uv tool install harbor" >&2
    exit 127
  fi
fi

# Job dir: first non-flag arg, else the most recent under jobs/.
JOB_DIR="${1:-}"
if [[ -z "${JOB_DIR}" ]]; then
  JOB_DIR="$(ls -dt "${REPO_ROOT}"/jobs/*/ 2>/dev/null | head -1 || true)"
  if [[ -z "${JOB_DIR}" ]]; then
    echo "error: no job dir given and none found under ${REPO_ROOT}/jobs/." >&2
    echo "       Run a benchmark first (./run-tasks.sh) or pass a job dir." >&2
    exit 1
  fi
  JOB_DIR="${JOB_DIR%/}"
  echo "No job dir given; using most recent: ${JOB_DIR}"
fi
if [[ ! -d "${JOB_DIR}" ]]; then
  echo "error: job dir not found: ${JOB_DIR}" >&2
  exit 1
fi

# Must be authenticated to upload.
if ! "${HARBOR}" auth status >/dev/null 2>&1; then
  echo "error: not authenticated. Run:  ${HARBOR} auth login" >&2
  exit 1
fi

# Assemble flags.
upload_flags=()
if [[ -n "${PUBLIC}" ]]; then
  upload_flags+=(--public)
else
  upload_flags+=(--private)
fi
for org in ${ORG}; do
  upload_flags+=(--share-org "${org}")
done

echo "Harbor     : ${HARBOR}"
echo "Job dir    : ${JOB_DIR}"
echo "Visibility : $([[ -n "${PUBLIC}" ]] && echo public || echo private)"
echo "Share orgs : ${ORG:-<none>}"
echo "-------------------------------------------------------------"

exec "${HARBOR}" upload "${JOB_DIR}" "${upload_flags[@]}"
