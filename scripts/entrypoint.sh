#!/bin/sh
# Minimal entrypoint to gate the orchestrator behind preflight checks.
# Exits non-zero if preflight fails, so Docker will restart the container.

set -e

echo "[entrypoint] running preflight checks..."
node /app/dist/offchain/tools/preflight.js || {
  echo "[entrypoint] preflight failed — refusing to start orchestrator" >&2
  exit 1
}

echo "[entrypoint] preflight ok — starting orchestrator"
exec node /app/dist/offchain/orchestrator.js
