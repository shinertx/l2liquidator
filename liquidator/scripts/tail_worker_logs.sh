#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

LOG_FILE="logs/live.log"

if [ ! -f "$LOG_FILE" ]; then
  echo "Log file $LOG_FILE not found yet. Waiting for worker to write logs..." >&2
  until [ -f "$LOG_FILE" ]; do
    sleep 1
  done
fi

echo "Tailing $LOG_FILE (Ctrl+C to exit)"
exec tail -F "$LOG_FILE"
