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

if [[ -f "$REPO_ROOT/.env" ]]; then
  set +u
  source "$REPO_ROOT/.env"
  set -u
fi
PROM_PORT=${PROM_PORT:-9464}

if ss -ltn | awk '{print $4}' | grep -qE "[:\.]${PROM_PORT}\\$"; then
  echo "[FATAL] Port ${PROM_PORT} already in use. Another orchestrator (e.g. docker compose worker) is running." >&2
  echo "[FATAL] Stop the other process or set PROM_PORT to an unused port before rerunning." >&2
  exit 1
fi

echo "[INFO] Starting 12h dry-run session. Logs: $MAIN_LOG (human) and $JSON_LOG (raw)."
echo "[INFO] End timestamp (UTC): $(date -u -d @${END_TS} +%Y-%m-%dT%H:%M:%SZ)"

CHILD_PID=0
cleanup() {
  if [[ ${CHILD_PID:-0} -ne 0 ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
  fi
  if [[ -f "$PID_FILE" ]]; then rm -f "$PID_FILE"; fi
  echo "[INFO] Dry-run wrapper exiting." | tee -a "$MAIN_LOG"
}
trap cleanup EXIT INT TERM

(
  export DRYRUN_WRAPPER=1

  rotate_if_needed() {
    local file="$1"
    local max_size=$((20*1024*1024))
    if [[ -f "$file" ]]; then
      local size
      size=$(stat -c%s "$file")
      if (( size > max_size )); then
        local suffix rotated
        suffix="$(date -u +%H%M%S)"
        if [[ "$file" == *.* ]]; then
          rotated="${file%.*}_${suffix}.${file##*.}"
        else
          rotated="${file}_${suffix}"
        fi
        mv "$file" "$rotated"
      fi
    fi
  }

  RUN_PID=0
  log_pipe=""

  terminate_child() {
    if [[ $RUN_PID -ne 0 ]] && kill -0 "$RUN_PID" 2>/dev/null; then
      kill -TERM "$RUN_PID" 2>/dev/null || true
    fi
    if [[ -n "$log_pipe" && -p "$log_pipe" ]]; then
      rm -f "$log_pipe"
      log_pipe=""
    fi
  }
  trap terminate_child INT TERM

  while true; do
    NOW=$(date +%s)
    if (( NOW >= END_TS )); then
      echo "[INFO] Reached 12h limit, stopping." | tee -a "$MAIN_LOG"
      break
    fi

    log_pipe="${LOG_FILE_BASE}.pipe"
    rm -f "$log_pipe"
    mkfifo "$log_pipe"

    stdbuf -oL -eL ./scripts/dev_env.sh >"$log_pipe" 2>&1 &
    RUN_PID=$!
    echo "$RUN_PID" > "$PID_FILE"
    echo "[INFO] Orchestrator PID: $RUN_PID" | tee -a "$MAIN_LOG"

    while IFS= read -r line || [[ -n "$line" ]]; do
      ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
      printf '[%s] %s\n' "$ts" "$line" | tee -a "$MAIN_LOG"
      if [[ "$line" == \{*\} ]]; then
        printf '%s\n' "$line" >> "$JSON_LOG"
        rotate_if_needed "$JSON_LOG"
      fi
      rotate_if_needed "$MAIN_LOG"
    done < "$log_pipe"

    wait "$RUN_PID"
    EXIT_CODE=$?
    RUN_PID=0
    rm -f "$log_pipe"
    log_pipe=""

    NOW=$(date +%s)
    if (( NOW >= END_TS )); then
      echo "[INFO] Reached 12h limit after orchestrator exit." | tee -a "$MAIN_LOG"
      break
    fi

    echo "[WARN] Orchestrator process exited early (exit code $EXIT_CODE) ; sleeping 15s then evaluating restart." | tee -a "$MAIN_LOG"
    sleep 15
  done
) &
CHILD_PID=$!

# Wait until duration expires or child exits
while kill -0 "$CHILD_PID" 2>/dev/null; do
  NOW=$(date +%s)
  if (( NOW >= END_TS )); then
    echo "[INFO] Sending SIGTERM to orchestrator after 12h." | tee -a "$MAIN_LOG"
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    break
  fi
  sleep 30
done

wait "$CHILD_PID" || true
