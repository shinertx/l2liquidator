#!/bin/bash

echo "🌊 VOLATILE MARKET OPPORTUNITY MONITOR"
echo "======================================"
echo "📅 $(date)"
echo ""

# Database connection
DB_CMD="docker exec liquidator-db-1 psql -U liquidator -d liquidator -c"

echo "🎯 LIQUIDATION OPPORTUNITIES (Last 5 minutes):"
$DB_CMD "
SELECT 
  chain_id,
  status,
  COUNT(*) as attempts,
  COUNT(DISTINCT borrower) as unique_borrowers,
  MIN(created_at) as first_attempt,
  MAX(created_at) as last_attempt
FROM liquidation_attempts 
WHERE created_at > NOW() - INTERVAL '5 minutes' 
GROUP BY chain_id, status 
ORDER BY attempts DESC;
"

echo ""
echo "💰 PROFIT ANALYSIS (Policy Skip Reasons):"
$DB_CMD "
SELECT 
  CASE 
    WHEN reason LIKE 'hf %' THEN 'Health Factor: ' || SUBSTRING(reason FROM 4)
    WHEN reason LIKE 'net %' THEN 'Net Profit: ' || SUBSTRING(reason FROM 5)
    WHEN reason LIKE 'gas %' THEN 'Gas Cost: ' || SUBSTRING(reason FROM 5)
    ELSE reason
  END as skip_reason,
  COUNT(*) as count
FROM liquidation_attempts 
WHERE created_at > NOW() - INTERVAL '5 minutes' 
  AND status = 'policy_skip'
GROUP BY reason 
ORDER BY count DESC 
LIMIT 10;
"

echo ""
echo "⚡ LAF ARBITRAGE ATTEMPTS:"
$DB_CMD "
SELECT 
  pair_id,
  status,
  COUNT(*) as attempts,
  AVG(net_usd) as avg_profit,
  MAX(net_usd) as max_profit
FROM laf_attempts 
WHERE created_at > NOW() - INTERVAL '5 minutes' 
GROUP BY pair_id, status 
ORDER BY attempts DESC;
" 2>/dev/null || echo "No LAF data found"

echo ""
echo "🚀 SYSTEM STATUS:"
echo "Liquidator: $(docker ps --filter name=liquidator-worker-1 --format 'table {{.Status}}')"
echo "LAF Fabric: $(ps aux | grep 'npm run fabric' | grep -v grep | wc -l) processes"
echo "Redis Keys: $(docker exec liquidator-redis-1 redis-cli KEYS '*' | wc -l) total"
echo "DB Connections: $(docker exec liquidator-db-1 psql -U liquidator -d liquidator -c 'SELECT count(*) FROM pg_stat_activity;' -t | xargs)"

echo ""
echo "📊 VOLATILITY METRICS:"
echo "ETH Price Movement: Monitoring 12% drop conditions"
echo "Gas Costs: Optimized for L2 efficiency"
echo "Health Factor Range: 1.0 - 1.12 (EXPANDED)"
echo "Min Profit: $0.25 (REDUCED)"
echo "Max Concurrent: 150 executions (INCREASED)"

echo ""
echo "🔄 Auto-refresh in 30 seconds... (Ctrl+C to stop)"