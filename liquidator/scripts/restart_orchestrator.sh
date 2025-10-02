#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/orchestrator.pid"
CMD="npm run dev"

mkdir -p "$LOG_DIR"

if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" || true)"
  if [[ -n "$OLD_PID" ]] && ps -p "$OLD_PID" > /dev/null 2>&1; then
    echo "Stopping existing orchestrator (pid $OLD_PID)…"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
      echo "Process still alive, forcing kill." >&2
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
  fi
fi

pkill -f "ts-node --transpile-only offchain/orchestrator.ts" >/dev/null 2>&1 || true

echo "Starting orchestrator via $CMD"
nohup $CMD > "$LOG_DIR/live_console.log" 2>&1 &
NEW_PID=$!
echo $NEW_PID > "$PID_FILE"
echo "Orchestrator started (pid $NEW_PID). Logs: $LOG_DIR/live_console.log"
