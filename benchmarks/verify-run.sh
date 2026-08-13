#!/usr/bin/env bash
#
# Verify a Harbor job produced valid ATIF trajectories (and a reward) for every
# trial. Use this after ./run-tasks.sh to confirm the agav adapter emitted a
# leaderboard-eligible trajectory.json per trial BEFORE uploading.
#
# For each trial dir it checks:
#   - agent/agav.txt              (raw agav log)
#   - agent/agav-trajectory.json  (agav's native transcript)
#   - agent/trajectory.json       (Harbor ATIF — the one CI/judge audits)
# and validates the ATIF file against Harbor's own Trajectory model (strict).
# It also prints each trial's reward from result.json, and totals up token usage
# + estimated $ cost across the whole job (with a projection to a full 89x5 run).
#
# Usage:
#   ./verify-run.sh                 # verify the most recent job under jobs/
#   ./verify-run.sh jobs/<job-dir>  # verify a specific job dir
#
# Cost rates default to gpt-5.5 ($/1M tokens); override any via env vars, e.g.
# P_OUT=45 for long-context output. Short-context: P_IN/P_CACHED/P_OUT; the
# long-context tier is shown too via P_IN_LONG/P_CACHED_LONG/P_OUT_LONG.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Resolve a python that can import harbor (prefer the repo venv).
PY="${REPO_ROOT}/.venv/bin/python"
if [[ ! -x "${PY}" ]]; then PY="python3"; fi

# gpt-5.5 pricing ($ per 1M tokens). Cached input is a subset of input billed at
# the cached rate; gpt-5.5 has no separate cache-write charge. Override via env.
P_IN="${P_IN:-5.00}";        P_CACHED="${P_CACHED:-0.50}";        P_OUT="${P_OUT:-30.00}"
P_IN_LONG="${P_IN_LONG:-10.00}"; P_CACHED_LONG="${P_CACHED_LONG:-1.00}"; P_OUT_LONG="${P_OUT_LONG:-45.00}"

# Full-board size for the cost projection (Terminal-Bench 2.1: 89 tasks x 5 trials).
FULL_RUN_TRIALS="${FULL_RUN_TRIALS:-445}"

JOB_DIR="${1:-}"
if [[ -z "${JOB_DIR}" ]]; then
  JOB_DIR="$(ls -dt "${REPO_ROOT}"/jobs/*/ 2>/dev/null | head -1 || true)"
  [[ -z "${JOB_DIR}" ]] && { echo "error: no job dir found under ${REPO_ROOT}/jobs/. Run ./run-tasks.sh first." >&2; exit 1; }
  JOB_DIR="${JOB_DIR%/}"
  echo "No job dir given; using most recent: ${JOB_DIR}"
fi
[[ -d "${JOB_DIR}" ]] || { echo "error: job dir not found: ${JOB_DIR}" >&2; exit 1; }

echo "Job dir : ${JOB_DIR}"
echo "-------------------------------------------------------------"

fail=0
trials=0
sum_p=0   # total input (prompt) tokens, includes cached
sum_c=0   # total cached input tokens (subset of sum_p)
sum_o=0   # total output (completion) tokens
for trial in "${JOB_DIR}"/*/; do
  [[ -f "${trial}result.json" ]] || continue   # only real trial dirs
  trials=$((trials + 1))
  name="$(basename "${trial}")"
  agent_dir="${trial}agent"

  # Reward (from result.json) + token totals (from the ATIF trajectory.json),
  # emitted as one tab-separated line: reward<TAB>prompt<TAB>cached<TAB>completion.
  stats="$("${PY}" - "${trial}result.json" "${agent_dir}/trajectory.json" <<'PY' 2>/dev/null || printf '?\t0\t0\t0\n'
import json, sys

def load(path):
    try:
        return json.load(open(path))
    except Exception:
        return {}

res = load(sys.argv[1])
# Harbor stores reward at verifier_result.rewards.reward; fall back to older shapes.
r = (res.get("verifier_result") or {}).get("rewards", {}).get("reward")
if r is None:
    r = res.get("reward", (res.get("metrics") or {}).get("reward"))

fm = (load(sys.argv[2]).get("final_metrics")) or {}
p = fm.get("total_prompt_tokens") or 0
c = fm.get("total_cached_tokens") or 0
o = fm.get("total_completion_tokens") or 0
print(f"{r if r is not None else '?'}\t{p}\t{c}\t{o}")
PY
)"
  IFS=$'\t' read -r reward p_tok c_tok o_tok <<<"${stats}"
  # Coerce token fields to integers (guard blanks / non-numeric / missing file).
  [[ "${p_tok:-}" =~ ^[0-9]+$ ]] || p_tok=0
  [[ "${c_tok:-}" =~ ^[0-9]+$ ]] || c_tok=0
  [[ "${o_tok:-}" =~ ^[0-9]+$ ]] || o_tok=0
  reward="${reward:-?}"
  sum_p=$(( sum_p + p_tok ))
  sum_c=$(( sum_c + c_tok ))
  sum_o=$(( sum_o + o_tok ))
  tok="tok in=${p_tok}/out=${o_tok}/cached=${c_tok}"

  miss=()
  [[ -f "${agent_dir}/agav.txt" ]]             || miss+=("agav.txt")
  [[ -f "${agent_dir}/agav-trajectory.json" ]] || miss+=("agav-trajectory.json")
  [[ -f "${agent_dir}/trajectory.json" ]]      || miss+=("trajectory.json")

  atif_ok="—"
  if [[ -f "${agent_dir}/trajectory.json" ]]; then
    if "${PY}" - "${agent_dir}/trajectory.json" <<'PY' >/dev/null 2>&1
import sys
from harbor.models.trajectories import Trajectory
Trajectory.model_validate_json(open(sys.argv[1]).read())
PY
    then atif_ok="valid"; else atif_ok="INVALID"; fail=1; fi
  fi

  if [[ ${#miss[@]} -gt 0 || "${atif_ok}" == "INVALID" ]]; then
    fail=1
    echo "  ✗ ${name}  reward=${reward}  ATIF=${atif_ok}  ${tok}  missing: ${miss[*]:-none}"
  else
    echo "  ✓ ${name}  reward=${reward}  ATIF=${atif_ok}  ${tok}"
  fi
done

echo "-------------------------------------------------------------"
[[ ${trials} -eq 0 ]] && { echo "error: no trials with result.json under ${JOB_DIR}" >&2; exit 1; }

# --- token + cost summary ---------------------------------------------------
# fresh (uncached) input = total prompt tokens minus the cached subset.
fresh=$(( sum_p - sum_c )); (( fresh < 0 )) && fresh=0
awk -v prompt="${sum_p}" -v fresh="${fresh}" -v cached="${sum_c}" -v out="${sum_o}" \
    -v trials="${trials}" -v full="${FULL_RUN_TRIALS}" \
    -v pin="${P_IN}"   -v pc="${P_CACHED}"   -v pout="${P_OUT}" \
    -v pinL="${P_IN_LONG}" -v pcL="${P_CACHED_LONG}" -v poutL="${P_OUT_LONG}" 'BEGIN {
  short = fresh/1e6*pin  + cached/1e6*pc  + out/1e6*pout;
  long  = fresh/1e6*pinL + cached/1e6*pcL + out/1e6*poutL;
  per   = (trials > 0) ? short/trials : 0;
  perL  = (trials > 0) ? long/trials  : 0;
  printf "Tokens  : input=%d (fresh=%d + cached=%d)  output=%d  total=%d\n", prompt, fresh, cached, out, prompt+out;
  printf "Cost    : short-ctx $%.2f   |   long-ctx $%.2f   (gpt-5.5 rates, %d trial(s))\n", short, long, trials;
  printf "Per-tr. : short-ctx $%.4f  |   long-ctx $%.4f\n", per, perL;
  printf "Project : full %d-trial run -> short-ctx $%.2f   |   long-ctx $%.2f\n", full, per*full, perL*full;
}'
echo "-------------------------------------------------------------"

if [[ ${fail} -ne 0 ]]; then
  echo "RESULT: problems found (see ✗ above). Do NOT submit until every trial has a valid ATIF trajectory."
  exit 1
fi
echo "RESULT: all ${trials} trial(s) have a valid ATIF trajectory.json ✅"
