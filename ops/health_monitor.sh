#!/bin/bash
# Autonomous Health Monitor for L2 Liquidator Systems
# This script continuously monitors all systems and auto-recovers from failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/health_monitor.log"
ALERT_WEBHOOK="${ALERT_WEBHOOK_URL:-${DISCORD_WEBHOOK_URL:-}}"
CHECK_INTERVAL="${HEALTH_CHECK_INTERVAL:-60}"

log() {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"
}

alert() {
    local message="$1"
    log "ALERT: $message"
    
    if [[ -n "$ALERT_WEBHOOK" ]]; then
        curl -s -X POST "$ALERT_WEBHOOK" \
            -H "Content-Type: application/json" \
            -d "{\"content\": \"🚨 **L2 Liquidator Alert**\n$message\"}" || true
    fi
}

check_process() {
    local name="$1"
    local pid_file="$2"
    
    if [[ ! -f "$pid_file" ]]; then
        log "WARN: $name PID file not found: $pid_file"
        return 1
    fi
    
    local pid=$(cat "$pid_file")
    if ! kill -0 "$pid" 2>/dev/null; then
        log "ERROR: $name process (PID $pid) is not running"
        return 1
    fi
    
    log "OK: $name (PID $pid) is running"
    return 0
}

check_docker_container() {
    local name="$1"
    
    if ! docker ps --format '{{.Names}}' | grep -q "^${name}$"; then
        log "ERROR: Docker container $name is not running"
        return 1
    fi
    
    local health_raw
    health_raw=$(docker inspect --format='{{.State.Health.Status}}' "$name" 2>/dev/null) || health_raw="none"
    local health
    health=$(echo "$health_raw" | tr -d '\r\n')
    if [[ -z "$health" ]] || [[ "$health" == "<no value>" ]]; then
        health="none"
    fi

    if [[ "$health" == "healthy" ]] || [[ "$health" == "none" ]]; then
        log "OK: Docker container $name is running (health: $health)"
        return 0
    else
        log "ERROR: Docker container $name is unhealthy: $health"
        return 1
    fi
}

check_database() {
    if ! docker exec l2liquidator-db-1 pg_isready -U liquidator -d liquidator >/dev/null 2>&1; then
        log "ERROR: PostgreSQL database is not ready"
        return 1
    fi
    log "OK: PostgreSQL database is ready"
    return 0
}

check_redis() {
    if ! docker exec l2liquidator-redis-1 redis-cli -p 6380 ping >/dev/null 2>&1; then
        log "ERROR: Redis is not responding"
        return 1
    fi
    log "OK: Redis is responding"
    return 0
}

check_metrics_endpoint() {
    local name="$1"
    local port="$2"
    
    if ! curl -sf "http://localhost:$port/metrics" >/dev/null; then
        log "WARN: $name metrics endpoint on port $port is not responding"
        return 1
    fi
    log "OK: $name metrics endpoint on port $port is responding"
    return 0
}

restart_orchestrator() {
    log "Attempting to restart orchestrator..."
    alert "Orchestrator health check failed - attempting auto-restart"

    if command -v systemctl >/dev/null 2>&1 && systemctl status l2liquidator-orchestrator.service >/dev/null 2>&1; then
        systemctl restart l2liquidator-orchestrator.service || true
        sleep 5
    else
        cd "$PROJECT_ROOT"
        pkill -f "orchestrator.ts" || true
        sleep 5
    PROM_PORT=9664 npm run dev > "logs/orchestrator_auto_$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 &
        local new_pid=$!
        echo "$new_pid" > "$PROJECT_ROOT/orchestrator.pid"
    fi

    log "Orchestrator restart command issued"
    alert "Orchestrator restart command issued"
}

restart_fabric() {
    log "Attempting to restart fabric..."
    alert "Fabric health check failed - attempting auto-restart"

    if command -v systemctl >/dev/null 2>&1 && systemctl status l2liquidator-fabric.service >/dev/null 2>&1; then
        systemctl restart l2liquidator-fabric.service || true
        sleep 5
    else
        cd "$PROJECT_ROOT"
        pkill -f "arb_fabric/runner.ts" || true
        sleep 5
        npm run fabric > "logs/fabric_auto_$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 &
        local new_pid=$!
        echo "$new_pid" > "$PROJECT_ROOT/fabric.pid"
    fi

    log "Fabric restart command issued"
    alert "Fabric restart command issued"
}

restart_docker_compose() {
    log "Attempting to restart Docker Compose services..."
    alert "Docker infrastructure health check failed - attempting restart"

    if command -v systemctl >/dev/null 2>&1 && systemctl status l2liquidator-stack.service >/dev/null 2>&1; then
        systemctl restart l2liquidator-stack.service || true
    else
        cd "$PROJECT_ROOT"
        docker compose restart
    fi
    sleep 10

    log "Docker infrastructure restart command issued"
    alert "Docker infrastructure restart command issued"
}

main() {
    log "=== L2 Liquidator Health Monitor Started ==="
    log "Check interval: ${CHECK_INTERVAL}s"
    
    local consecutive_failures=0
    local max_consecutive_failures=3
    
    while true; do
        log "--- Health Check Cycle ---"
        
        local all_healthy=true
        
        # Check Docker infrastructure
        if ! check_docker_container "l2liquidator-db-1"; then
            all_healthy=false
            consecutive_failures=$((consecutive_failures + 1))
            if [[ $consecutive_failures -ge $max_consecutive_failures ]]; then
                restart_docker_compose
                consecutive_failures=0
            fi
        elif ! check_docker_container "l2liquidator-redis-1"; then
            all_healthy=false
            consecutive_failures=$((consecutive_failures + 1))
            if [[ $consecutive_failures -ge $max_consecutive_failures ]]; then
                restart_docker_compose
                consecutive_failures=0
            fi
        elif ! check_database; then
            all_healthy=false
        elif ! check_redis; then
            all_healthy=false
        fi
        
        # Check orchestrator
        if ! check_process "Orchestrator" "$PROJECT_ROOT/orchestrator.pid"; then
            all_healthy=false
            restart_orchestrator
        fi
        
        # Check fabric
        if ! check_process "Fabric" "$PROJECT_ROOT/fabric.pid"; then
            all_healthy=false
            restart_fabric
        fi
        
        # Check Docker containers
        check_docker_container "l2liquidator-worker-1" || all_healthy=false
        check_docker_container "l2liquidator-risk-engine-1" || all_healthy=false
        
        # Check metrics endpoints
        check_metrics_endpoint "Orchestrator" "9664" || true
        check_metrics_endpoint "Fabric" "9470" || true
        
        if [[ "$all_healthy" == true ]]; then
            consecutive_failures=0
            log "✓ All systems healthy"
        else
            log "⚠ Some systems require attention"
        fi
        
        sleep "$CHECK_INTERVAL"
    done
}

# Trap signals for graceful shutdown
trap 'log "Health monitor shutting down..."; exit 0' SIGTERM SIGINT

# Start monitoring
main
