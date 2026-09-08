#!/usr/bin/env bash
# Verify releases.agav.dev serves R2 as primary with GitHub Releases fallback.
#
#   docs/deploy/verify-releases-mirror.sh [tag]
#   e.g. docs/deploy/verify-releases-mirror.sh v0.2.1
#
# Checks, against the live domain:
#   1. DNS resolves and TLS is valid.
#   2. A known release asset is served (200) with an X-Agav-Origin header of
#      either "r2" (mirrored) or "github-fallback" (not yet mirrored). Both are
#      correct; the header proves the request went through the mirror Worker.
#   3. The per-asset .sha256 the installer verifies is served (200).
#   4. A genuinely missing asset returns 404 (real miss — not in R2 or GitHub).
#   5. Cross-check: the bytes served match GitHub's raw asset (fallback origin
#      of truth), so R2 and GitHub agree.
#
# Exit 0 only if all checks pass. Safe to run repeatedly.

set -uo pipefail

TAG="${1:-v0.2.1}"
HOST="https://releases.agav.dev"
GH="https://github.com/prapaa-ai/agav/releases/download/${TAG}"
ASSET="agav-darwin-arm64.gz"
SHA="${ASSET}.sha256"
MISSING="this-asset-does-not-exist.gz"

pass=0
fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }

echo "== releases.agav.dev mirror verification (${TAG}) =="

# 1. DNS + TLS
if curl -sfI --max-time 15 "${HOST}/" >/dev/null 2>&1 \
   || [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${HOST}/" 2>/dev/null)" != "000" ]; then
  ok "DNS resolves and TLS handshake succeeds"
else
  bad "cannot reach ${HOST} (DNS/TLS) — is the Worker + custom domain deployed?"
  echo ""
  echo "${pass} passed, ${fail} failed"
  exit 1
fi

# 2. Primary/fallback asset serves 200 with the mirror header
read -r code origin < <(curl -s -o /dev/null \
  -w '%{http_code} %header{x-agav-origin}\n' -L --max-time 60 "${HOST}/${TAG}/${ASSET}")
if [ "$code" = "200" ] && { [ "$origin" = "r2" ] || [ "$origin" = "github-fallback" ]; }; then
  ok "asset served (HTTP ${code}, origin=${origin})"
else
  bad "asset not served correctly (HTTP ${code}, origin='${origin}')"
fi

# 3. Per-asset checksum served
code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 30 "${HOST}/${TAG}/${SHA}")
if [ "$code" = "200" ]; then ok ".sha256 served (HTTP ${code})"; else bad ".sha256 not served (HTTP ${code})"; fi

# 4. Missing asset -> 404
code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 30 "${HOST}/${TAG}/${MISSING}")
if [ "$code" = "404" ]; then ok "missing asset returns 404"; else bad "missing asset returned ${code}, expected 404"; fi

# 5. Bytes match GitHub (source of truth)
mirror_sum=$(curl -sL --max-time 90 "${HOST}/${TAG}/${ASSET}" | shasum -a 256 | awk '{print $1}')
github_sum=$(curl -sL --max-time 90 "${GH}/${ASSET}" | shasum -a 256 | awk '{print $1}')
if [ -n "$mirror_sum" ] && [ "$mirror_sum" = "$github_sum" ]; then
  ok "mirror bytes match GitHub (${mirror_sum})"
else
  bad "byte mismatch: mirror=${mirror_sum:-none} github=${github_sum:-none}"
fi

echo ""
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
