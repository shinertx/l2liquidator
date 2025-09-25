#!/usr/bin/env bash
set -u -o pipefail
# Note: we intentionally do NOT use 'set -e' for this wrapper so orchestrator crashes don't kill the 12h loop.

# 12 hour dry-run wrapper that ensures dryRun stays enabled and captures logs with rotation
DURATION_SECONDS=$((12*60*60))
START_TS=$(date +%s)
END_TS=$((START_TS + DURATION_SECONDS))

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
LOG_DIR="${REPO_ROOT}/logs"
mkdir -p "$LOG_DIR"
LOG_FILE_BASE="${LOG_DIR}/dryrun_$(date -u +%Y%m%dT%H%M%SZ)"
MAIN_LOG="${LOG_FILE_BASE}.log"
JSON_LOG="${LOG_FILE_BASE}.jsonl"
PID_FILE="${LOG_FILE_BASE}.pid"

# Safety check: refuse to run if config has dryRun: false
if ! grep -qE 'dryRun:\s*true' "${REPO_ROOT}/config.yaml"; then
  echo "[FATAL] config.yaml risk.dryRun is not true. Aborting to prevent live executions." >&2
  exit 1
fi

echo "[INFO] Starting 12h dry-run session. Logs: $MAIN_LOG (human) and $JSON_LOG (raw)."
echo "[INFO] End timestamp (UTC): $(date -u -d @${END_TS} +%Y-%m-%dT%H:%M:%SZ)"

# Trap for clean exit
cleanup() {
  if [[ -f "$PID_FILE" ]]; then rm -f "$PID_FILE"; fi
  echo "[INFO] Dry-run wrapper exiting." | tee -a "$MAIN_LOG"
}
trap cleanup EXIT INT TERM

# Run orchestrator with env expansion and tee logs.
# We assume scripts/dev_env.sh exists next to this script.
(
  cd "$REPO_ROOT" || exit 1
  # Rotate if > 20MB (very simple rotation check)
  rotate_if_needed() {
    local file="$1"
    local max_size=$((20*1024*1024))
    if [[ -f "$file" ]]; then
      local size
      size=$(stat -c%s "$file")
      if (( size > max_size )); then
        mv "$file" "${file%.log}_$(date -u +%H%M%S).log"
      fi
    fi
  }
  export DRYRUN_WRAPPER=1
  while true; do
    NOW=$(date +%s)
    if (( NOW >= END_TS )); then
      echo "[INFO] Reached 12h limit, stopping." | tee -a "$MAIN_LOG"
      break
    fi
    # Single run instance (long-lived process) - break loop after it exits.
  ./scripts/dev_env.sh 2>&1 | while IFS= read -r line; do
      ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
      echo "[$ts] $line" | tee -a "$MAIN_LOG"
      # Attempt to extract JSON lines produced by pino (if already JSON) and append raw
      if [[ "$line" == \{*\} ]]; then
        echo "$line" >> "$JSON_LOG"
      fi
      rotate_if_needed "$MAIN_LOG"
    done
    # If orchestrator exits early, sleep briefly then decide whether to restart.
  echo "[WARN] Orchestrator process exited early (exit code $?) ; sleeping 15s then evaluating restart." | tee -a "$MAIN_LOG"
    sleep 15
  done
) &
CHILD_PID=$!
echo $CHILD_PID > "$PID_FILE"
echo "[INFO] Orchestrator PID: $CHILD_PID" | tee -a "$MAIN_LOG"

# Wait until duration expires or child exits
while kill -0 $CHILD_PID 2>/dev/null; do
  NOW=$(date +%s)
  if (( NOW >= END_TS )); then
    echo "[INFO] Sending SIGTERM to orchestrator after 12h." | tee -a "$MAIN_LOG"
    kill -TERM $CHILD_PID || true
    break
  fi
  sleep 30
done

wait $CHILD_PID || true
