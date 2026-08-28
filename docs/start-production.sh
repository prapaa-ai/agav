#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

export NODE_ENV="production"
export APP_ENV="production"
export PORT="${PORT:-3000}"

if ! command -v node >/dev/null 2>&1; then
  log "ERROR: node is not installed or not on PATH"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  log "ERROR: dependencies are missing. Run npm install first."
  exit 1
fi

if [[ ! -f package.json ]]; then
  log "ERROR: package.json not found in $ROOT_DIR"
  exit 1
fi

if [[ -f .next/BUILD_ID ]]; then
  log "Build found. Starting production server on port $PORT..."
else
  log "WARNING: .next build artifacts not found. Did you run npm run build?"
fi

if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  log "ERROR: port $PORT is already in use"
  exit 1
fi

log "Starting server from $ROOT_DIR"
exec npm run start -- --port "$PORT"
