#!/usr/bin/env bash
#
# Run Terminal-Bench 2.1 tasks (by name, or the whole board with --all) via Harbor.
#
# This script is self-contained in the benchmarks/ folder and does not touch
# anything else in the repo. It only shells out to `harbor`.
#
# Usage:
#   ./run-tasks.sh                        # runs every task listed in tasks.txt
#   ./run-tasks.sh task-a task-b          # runs the task names you pass as args
#   ./run-tasks.sh --all                  # runs the WHOLE dataset (all 89 tasks)
#   ./run-tasks.sh -m gpt-5.5 task-a      # -m/--model and -a/--agent are flags
#   AGENT=oracle ./run-tasks.sh task-a    # env vars also work (flags win)
#
# --all is the leaderboard-submission mode: it drops the per-task filter and runs
# every task in the dataset with 5 trials each (-k 5, the Terminal-Bench 2.1
# minimum). Override the trial count via EXTRA, e.g. EXTRA="-k 1" for a cheap
# full-board smoke test. --all cannot be combined with explicit task names.
#
# RESUMABLE runs: set JOB_NAME to pin the output dir (jobs/<JOB_NAME>). If the run
# is interrupted, re-run the IDENTICAL command and harbor skips completed trials
# and finishes the rest. Example:
#   JOB_NAME=tb21-agav-full ./run-tasks.sh --all      # resume-safe -k 5 run
# Use a DIFFERENT JOB_NAME for the -k 1 smoke test (configs must match to resume).
#
# A --model without a provider prefix defaults to openai/ (e.g. gpt-5.5 ->
# openai/gpt-5.5). Task names may be bare (auto-matched as */name).
#
# Environment overrides:
#   AGENT    Harbor agent to use            (default: agav)
#            AGENT=agav benchmarks the agav CLI (a locally-built binary is
#            uploaded into each container; built automatically via build-binary.sh).
#            Set AGENT=oracle to sanity-check a task with its known-good solution.
#   MODEL    Model identifier for the agent (default: openai/gpt-5.5)
#   DATASET  Dataset identifier             (default: terminal-bench/terminal-bench-2-1)
#   EXTRA    Extra flags passed to harbor   (default: empty), e.g. EXTRA="-n 2"
#
# Prerequisites:
#   - Docker running
#   - Harbor installed:  uv tool install harbor   (or: pipx install harbor)
#   - To benchmark agav (AGENT=agav): install the adapter into Harbor's env first:
#       uv pip install -e benchmarks/agav-agent
#     and export the provider key, e.g. ANTHROPIC_API_KEY. See benchmarks/README.md.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASKS_FILE="${SCRIPT_DIR}/tasks.txt"

AGENT="${AGENT:-agav}"
MODEL="${MODEL:-openai/gpt-5.5}"
DATASET="${DATASET:-terminal-bench/terminal-bench-2-1}"
EXTRA="${EXTRA:-}"
ALL="${ALL:-}"
# Pin a job name to make a run RESUMABLE: harbor stores it at jobs/<JOB_NAME> and,
# if interrupted, re-running the IDENTICAL command skips completed trials and only
# runs the rest. Unset -> harbor uses a fresh timestamp each run (not resumable).
JOB_NAME="${JOB_NAME:-}"

# --- parse args: -m/--model, -a/--agent are flags; the rest are task names --
# Any non-flag args override tasks.txt. Flags override the MODEL/AGENT env vars.
tasks=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -m|--model)
      MODEL="${2:-}"; shift 2 ;;
    --model=*)
      MODEL="${1#*=}"; shift ;;
    -a|--agent)
      AGENT="${2:-}"; shift 2 ;;
    --agent=*)
      AGENT="${1#*=}"; shift ;;
    --all)
      ALL=1; shift ;;
    --)
      shift; while [[ "$#" -gt 0 ]]; do tasks+=("$1"); shift; done ;;
    -*)
      echo "error: unknown flag '$1'. Supported: -m/--model, -a/--agent, --all." >&2
      exit 2 ;;
    *)
      tasks+=("$1"); shift ;;
  esac
done

# --all runs the whole dataset (no per-task filter). It's mutually exclusive with
# naming tasks, so a stray arg can't silently narrow a "full board" submission.
if [[ -n "${ALL}" && "${#tasks[@]}" -gt 0 ]]; then
  echo "error: --all runs the whole dataset and cannot be combined with task names (${tasks[*]})." >&2
  exit 2
fi

# A model without a provider prefix defaults to the openai provider.
if [[ -n "${MODEL}" && "${MODEL}" != */* ]]; then
  MODEL="openai/${MODEL}"
fi

# No task args given -> fall back to tasks.txt (unless --all runs everything).
if [[ -z "${ALL}" && "${#tasks[@]}" -eq 0 ]]; then
  if [[ ! -f "${TASKS_FILE}" ]]; then
    echo "error: no tasks given and ${TASKS_FILE} not found" >&2
    exit 1
  fi
  while IFS= read -r line; do
    line="${line%%#*}"                 # strip inline/full-line comments
    line="$(echo "${line}" | xargs)"   # trim surrounding whitespace
    [[ -z "${line}" ]] && continue
    tasks+=("${line}")
  done < "${TASKS_FILE}"
fi

if [[ -z "${ALL}" && "${#tasks[@]}" -eq 0 ]]; then
  echo "error: no task names to run. Add names to tasks.txt, pass them as arguments," >&2
  echo "       or use --all to run the whole dataset." >&2
  echo "example: ./run-tasks.sh some-task-name" >&2
  exit 1
fi

# --- preflight checks ------------------------------------------------------
if ! command -v harbor >/dev/null 2>&1; then
  echo "error: 'harbor' not found. Install it with:  uv tool install harbor" >&2
  exit 127
fi
if ! docker info >/dev/null 2>&1; then
  echo "error: Docker does not appear to be running. Start Docker and retry." >&2
  exit 1
fi

# Provider API key must be set on the host: the agav adapter only forwards a
# key into the container if it exists here. A missing key otherwise surfaces as
# an opaque NonZeroAgentExitCodeError for every task. The 'oracle' agent replays
# the reference solution and needs no model key, so skip the check for it.
if [[ "${AGENT}" != "oracle" ]]; then
  provider="${MODEL%%/*}"
  case "${provider}" in
    google|google-gemini|googleai) provider="gemini" ;;
  esac
  case "${provider}" in
    anthropic)      required_keys=("ANTHROPIC_API_KEY") ;;
    openai)         required_keys=("OPENAI_API_KEY") ;;
    gemini)         required_keys=("GEMINI_API_KEY") ;;
    ollama)         required_keys=() ;;  # local; no API key needed
    *)              required_keys=() ;;  # unknown provider: let the agent decide
  esac
  for key in "${required_keys[@]}"; do
    if [[ -z "${!key:-}" ]]; then
      echo "error: \$${key} is not set, but model '${MODEL}' (provider '${provider}') needs it." >&2
      echo "       Export it and retry, e.g.:  export ${key}=\"sk-...\"" >&2
      exit 1
    fi
  done
fi

# --- build the --include-task-name flags -----------------------------------
# Harbor matches the FULL task name (e.g. "terminal-bench/fix-git") with fnmatch.
# So a bare name like "fix-git" is auto-wrapped into a "*/fix-git" glob. Names
# that already contain "/" or a glob char (* ? [) are passed through untouched.
# In --all mode there are no task names, so include_flags stays empty and harbor
# runs the whole dataset. (Guard the loop for set -u + bash 3.2 empty arrays.)
include_flags=()
for t in ${tasks[@]+"${tasks[@]}"}; do
  if [[ "${t}" == */* || "${t}" == *[\*\?\[]* ]]; then
    pattern="${t}"
  else
    pattern="*/${t}"
  fi
  include_flags+=(--include-task-name "${pattern}")
done

# Full-board runs need >=5 trials/task for the leaderboard; default to -k 5 unless
# the caller already set a trial count via EXTRA (e.g. EXTRA="-k 1" for a smoke test).
trials_flags=()
if [[ -n "${ALL}" && " ${EXTRA} " != *" -k "* && " ${EXTRA} " != *" --n-attempts "* ]]; then
  trials_flags=(-k 5)
fi

# Pin the job name (resumable run) when JOB_NAME is set. Don't also pass one via
# EXTRA, or harbor gets a duplicate --job-name.
job_name_flags=()
if [[ -n "${JOB_NAME}" ]]; then
  job_name_flags=(--job-name "${JOB_NAME}")
fi

# --- select built-in agent vs the agav custom-agent import path ------------
# `--agent` (`-a`) accepts both built-in names and "module:Class" import paths.
agent_flags=()
if [[ "${AGENT}" == "agav" ]]; then
  agent_flags=(-a "agav_terminal_bench:AgavAgent")
  # agav's repo is private, so we can't clone it in-container. Build a local
  # single-file binary (cached; rebuilt only when sources change) which the
  # adapter uploads into each task container.
  echo "Ensuring agav binary is built (build-binary.sh)..."
  "${SCRIPT_DIR}/agav-agent/build-binary.sh"
  echo "-------------------------------------------------------------"
else
  agent_flags=(-a "${AGENT}")
fi

echo "Dataset : ${DATASET}"
echo "Agent   : ${AGENT}"
echo "Model   : ${MODEL}"
if [[ -n "${ALL}" ]]; then
  echo "Tasks   : (all — whole dataset)${trials_flags[@]+ ${trials_flags[*]}}"
else
  echo "Tasks   : ${tasks[*]}"
fi
if [[ -n "${JOB_NAME}" ]]; then
  echo "Job     : ${JOB_NAME} (resumable — re-run the same command to continue)"
fi
echo "-------------------------------------------------------------"

# shellcheck disable=SC2086  # EXTRA is intentionally word-split
harbor run \
  -d "${DATASET}" \
  "${agent_flags[@]}" \
  -m "${MODEL}" \
  ${include_flags[@]+"${include_flags[@]}"} \
  ${trials_flags[@]+"${trials_flags[@]}"} \
  ${job_name_flags[@]+"${job_name_flags[@]}"} \
  ${EXTRA}
