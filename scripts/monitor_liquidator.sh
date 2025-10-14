# Simple liquidator monitoring script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$ROOT_DIR/logs/orchestrator.pid"

# Check if process is running
if [[ -f "$PID_FILE" ]]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [[ -n "$PID" ]] && ps -p "$PID" > /dev/null 2>&1; then
        echo "$(date): Liquidator is running (PID: $PID)"
        exit 0
    fi
fi

echo "$(date): Liquidator not running, attempting restart..."
cd "$ROOT_DIR"
bash scripts/restart_orchestrator.sh
