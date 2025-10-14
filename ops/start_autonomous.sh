#!/bin/bash
# Master startup script for L2 Liquidator autonomous operation
# Starts all systems in the correct order with health checks

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/startup_$(date -u +%Y%m%dT%H%M%SZ).log"

log() {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"
}

error() {
    log "ERROR: $*"
    exit 1
}

check_dependencies() {
    log "Checking dependencies..."
    
    command -v docker >/dev/null 2>&1 || error "Docker is not installed"
    command -v node >/dev/null 2>&1 || error "Node.js is not installed"
    command -v npm >/dev/null 2>&1 || error "npm is not installed"
    
    if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
        error ".env file not found"
    fi
    
    log "✓ All dependencies available"
}

start_docker_infrastructure() {
    log "Starting Docker infrastructure..."
    
    cd "$PROJECT_ROOT"
    docker compose up -d
    
    log "Waiting for PostgreSQL to be ready..."
    for i in {1..30}; do
        if docker exec l2liquidator-db-1 pg_isready -U liquidator -d liquidator >/dev/null 2>&1; then
            log "✓ PostgreSQL is ready"
            break
        fi
        if [[ $i -eq 30 ]]; then
            error "PostgreSQL failed to become ready"
        fi
        sleep 2
    done
    
    log "Waiting for Redis to be ready..."
    for i in {1..30}; do
        if docker exec l2liquidator-redis-1 redis-cli ping >/dev/null 2>&1; then
            log "✓ Redis is ready"
            break
        fi
        if [[ $i -eq 30 ]]; then
            error "Redis failed to become ready"
        fi
        sleep 2
    done
    
    log "✓ Docker infrastructure started"
}

start_orchestrator() {
    log "Starting L2 Liquidator Orchestrator..."
    
    cd "$PROJECT_ROOT"
    
    # Kill any existing processes
    pkill -f "orchestrator.ts" || true
    sleep 2
    
    # Start orchestrator
    npm run dev > "logs/orchestrator_$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 &
    local pid=$!
    echo "$pid" > "$PROJECT_ROOT/orchestrator.pid"
    
    log "✓ Orchestrator started with PID $pid"
    
    # Wait for it to initialize
    sleep 10
}

start_fabric() {
    log "Starting Long-Tail Arbitrage Fabric..."
    
    cd "$PROJECT_ROOT"
    
    # Kill any existing processes
    pkill -f "arb_fabric/runner.ts" || true
    sleep 2
    
    # Start fabric
    npm run fabric > "logs/fabric_$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 &
    local pid=$!
    echo "$pid" > "$PROJECT_ROOT/fabric.pid"
    
    log "✓ Fabric started with PID $pid"
    
    # Wait for it to initialize
    sleep 10
}

start_health_monitor() {
    log "Starting health monitor..."
    
    cd "$PROJECT_ROOT"
    
    # Kill any existing health monitor
    pkill -f "health_monitor.sh" || true
    sleep 2
    
    # Start health monitor in background
    "$SCRIPT_DIR/health_monitor.sh" > "logs/health_monitor_$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 &
    local pid=$!
    echo "$pid" > "$PROJECT_ROOT/health_monitor.pid"
    
    log "✓ Health monitor started with PID $pid"
}

verify_systems() {
    log "Verifying all systems..."
    
    local orchestrator_pid=$(cat "$PROJECT_ROOT/orchestrator.pid" 2>/dev/null || echo "")
    if [[ -n "$orchestrator_pid" ]] && kill -0 "$orchestrator_pid" 2>/dev/null; then
        log "✓ Orchestrator running (PID: $orchestrator_pid)"
    else
        log "⚠ Orchestrator may have issues"
    fi
    
    local fabric_pid=$(cat "$PROJECT_ROOT/fabric.pid" 2>/dev/null || echo "")
    if [[ -n "$fabric_pid" ]] && kill -0 "$fabric_pid" 2>/dev/null; then
        log "✓ Fabric running (PID: $fabric_pid)"
    else
        log "⚠ Fabric may have issues"
    fi
    
    if docker ps | grep -q "l2liquidator-worker-1.*healthy"; then
        log "✓ Worker container healthy"
    else
        log "⚠ Worker container status unknown"
    fi
    
    if docker ps | grep -q "l2liquidator-risk-engine-1.*healthy"; then
        log "✓ Risk engine container healthy"
    else
        log "⚠ Risk engine container status unknown"
    fi
}

show_status() {
    log "=== L2 Liquidator System Status ==="
    log ""
    log "🎯 Primary Systems:"
    log "  • Orchestrator: Hunting across Arbitrum, Optimism, Base, Polygon"
    log "  • Fabric: Monitoring 9 DEX pairs for arbitrage"
    log "  • Worker: Processing liquidations (Docker)"
    log "  • Risk Engine: Calculating profitability (Docker)"
    log ""
    log "🗄️  Infrastructure:"
    log "  • PostgreSQL: localhost:5432"
    log "  • Redis: localhost:6380"
    log "  • Prometheus: localhost:9090"
    log "  • Grafana: localhost:3000"
    log ""
    log "📊 Metrics Endpoints:"
    log "  • Orchestrator: http://localhost:9664/metrics"
    log "  • Fabric: http://localhost:9470/metrics"
    log "  • Worker: http://localhost:9464/metrics"
    log ""
    log "📁 Log Files:"
    log "  • Orchestrator: logs/orchestrator*.log"
    log "  • Fabric: logs/fabric*.log"
    log "  • Health Monitor: logs/health_monitor*.log"
    log ""
    log "✅ All systems operational and autonomous"
    log ""
}

main() {
    log "=== Starting L2 Liquidator Autonomous System ==="
    
    check_dependencies
    start_docker_infrastructure
    start_orchestrator
    start_fabric
    start_health_monitor
    
    sleep 5
    verify_systems
    show_status
    
    log "=== Startup Complete ==="
}

main "$@"
