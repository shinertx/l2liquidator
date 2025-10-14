#!/bin/bash
# Performance optimizer - monitors and tunes system for maximum profit capture
# Auto-adjusts gas limits, slippage, concurrency based on market conditions

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/optimizer.log"
METRICS_PORT=9664

log() {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"
}

get_metric() {
    local metric_name="$1"
    curl -s "http://localhost:$METRICS_PORT/metrics" | grep "^$metric_name" | awk '{print $2}' | head -1
}

optimize_gas_limits() {
    log "Analyzing gas usage patterns..."
    
    # Get recent execution metrics
    local avg_gas_used=$(get_metric "liquidator_gas_used_avg" || echo "0")
    local max_gas_used=$(get_metric "liquidator_gas_used_max" || echo "0")
    
    if [[ "$avg_gas_used" != "0" ]] && [[ "$max_gas_used" != "0" ]]; then
        # Calculate optimal gas limit (1.2x max observed)
        local optimal_limit=$(echo "$max_gas_used * 1.2" | bc | cut -d'.' -f1)
        log "Optimal gas limit calculated: $optimal_limit (avg: $avg_gas_used, max: $max_gas_used)"
        
        # TODO: Update config dynamically
    fi
}

analyze_success_rate() {
    log "Analyzing execution success rate..."
    
    local attempts=$(get_metric "liquidator_attempts_total" || echo "0")
    local successes=$(get_metric "liquidator_executions_total" || echo "0")
    
    if [[ "$attempts" != "0" ]] && [[ "$attempts" -gt 10 ]]; then
        local success_rate=$(echo "scale=2; ($successes / $attempts) * 100" | bc)
        log "Success rate: ${success_rate}% ($successes/$attempts)"
        
        if (( $(echo "$success_rate < 50" | bc -l) )); then
            log "⚠️  Low success rate - consider adjusting parameters"
        elif (( $(echo "$success_rate > 80" | bc -l) )); then
            log "✅ High success rate - system performing well"
        fi
    fi
}

analyze_profitability() {
    log "Analyzing profitability metrics..."
    
    local total_profit=$(get_metric "liquidator_profit_usd_total" || echo "0")
    local total_gas_cost=$(get_metric "liquidator_gas_cost_usd_total" || echo "0")
    
    if [[ "$total_profit" != "0" ]] && [[ "$total_gas_cost" != "0" ]]; then
        local net_profit=$(echo "$total_profit - $total_gas_cost" | bc)
        local profit_margin=$(echo "scale=2; ($net_profit / $total_profit) * 100" | bc)
        
        log "Total profit: \$$total_profit"
        log "Total gas cost: \$$total_gas_cost"
        log "Net profit: \$$net_profit (margin: ${profit_margin}%)"
    fi
}

check_chain_health() {
    local chain="$1"
    
    # Check WebSocket connection health
    local ws_errors=$(grep -c "ws-closed" "$PROJECT_ROOT/logs/orchestrator"*.log 2>/dev/null | tail -1 || echo "0")
    
    if [[ "$ws_errors" -gt 5 ]]; then
        log "⚠️  $chain: High WebSocket error count ($ws_errors) - may need RPC failover"
    fi
}

optimize_concurrency() {
    log "Analyzing concurrency settings..."
    
    # Check if we're CPU or I/O bound
    local cpu_usage=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1 || echo "0")
    
    log "CPU usage: ${cpu_usage}%"
    
    if (( $(echo "$cpu_usage > 80" | bc -l) )); then
        log "⚠️  High CPU usage - may need to reduce concurrency"
    elif (( $(echo "$cpu_usage < 30" | bc -l) )); then
        log "💡 Low CPU usage - could increase concurrency for more throughput"
    fi
}

main() {
    log "=== L2 Liquidator Performance Optimizer ==="
    
    while true; do
        log "--- Optimization Cycle ---"
        
        optimize_gas_limits
        analyze_success_rate
        analyze_profitability
        
        check_chain_health "Arbitrum"
        check_chain_health "Optimism"
        check_chain_health "Base"
        check_chain_health "Polygon"
        
        optimize_concurrency
        
        log "Cycle complete, sleeping for 300s..."
        sleep 300
    done
}

trap 'log "Optimizer shutting down..."; exit 0' SIGTERM SIGINT

main
