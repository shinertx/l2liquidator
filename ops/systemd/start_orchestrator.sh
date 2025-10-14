#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/home/benjaminjones/l2liquidator"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$ROOT_DIR/orchestrator.pid"
TS_NODE="$ROOT_DIR/node_modules/.bin/ts-node"
SCRIPT="offchain/orchestrator.ts"

mkdir -p "$LOG_DIR"
trap 'rm -f "$PID_FILE"' EXIT

echo "$$" > "$PID_FILE"
exec "$TS_NODE" --transpile-only "$SCRIPT"
