#!/bin/bash

# Quick Reference: Pre-Liquidation Alpha Operations
# Common commands for monitoring and managing the pre-liq system

cat << 'EOF'

╔════════════════════════════════════════════════════════════════╗
║          PRE-LIQUIDATION ALPHA - QUICK REFERENCE               ║
╚════════════════════════════════════════════════════════════════╝

🔍 MONITORING COMMANDS
─────────────────────────────────────────────────────────────────

# Watch all logs in real-time
docker logs -f l2liquidator-worker-1

# Filter for pre-liquidation only
docker logs -f l2liquidator-worker-1 | grep -E "(preliq|Pre-Liquidation)"

# Last 100 lines
docker logs --tail 100 l2liquidator-worker-1

# Check if system enabled
docker logs l2liquidator-worker-1 | grep "Pre-Liquidation Alpha"

# Monitor metrics
curl -s http://localhost:9464/metrics | grep preliq

# Watch metrics live
watch -n 5 'curl -s http://localhost:9464/metrics | grep preliq'


📊 METRICS QUERIES
─────────────────────────────────────────────────────────────────

# Attempts per chain
curl -s http://localhost:9464/metrics | grep preliq_attempt_total

# Success rate
curl -s http://localhost:9464/metrics | grep preliq_success_total

# Profit tracking
curl -s http://localhost:9464/metrics | grep preliq_profit_usd

# Rejection reasons
curl -s http://localhost:9464/metrics | grep preliq_rejected_total

# All pre-liq metrics
curl -s http://localhost:9464/metrics | grep "^preliq"


🔧 MANAGEMENT COMMANDS
─────────────────────────────────────────────────────────────────

# Restart worker
docker restart l2liquidator-worker-1

# Check container status
docker ps --filter name=l2liquidator-worker

# Check health
curl http://localhost:9464/ready

# View environment
docker exec l2liquidator-worker-1 env | grep PRELIQ

# Verify build
npm run build

# Run verification script
bash scripts/verify_preliq_complete.sh


📝 CONFIGURATION COMMANDS
─────────────────────────────────────────────────────────────────

# Check if enabled
grep PRELIQ_ENABLED .env

# Check API keys
grep -E "(ODOS|ONEINCH)_API_KEY" .env

# View config
cat config.yaml | grep -A 5 "risk:"

# Check dry-run mode
grep "dryRun:" config.yaml


🚀 DEPLOYMENT COMMANDS
─────────────────────────────────────────────────────────────────

# Enable pre-liquidation
echo "export PRELIQ_ENABLED=1" >> .env
docker restart l2liquidator-worker-1

# Disable pre-liquidation
sed -i 's/PRELIQ_ENABLED=1/PRELIQ_ENABLED=0/' .env
docker restart l2liquidator-worker-1

# Update factory addresses (after contract deployment)
vim offchain/indexer/morpho_preliq_indexer.ts  # lines 11-15
npm run build
docker restart l2liquidator-worker-1

# Add API keys
vim .env  # Add ODOS_API_KEY and ONEINCH_API_KEY
docker restart l2liquidator-worker-1


🔍 DEBUGGING COMMANDS
─────────────────────────────────────────────────────────────────

# Check for errors
docker logs l2liquidator-worker-1 | grep -i error | tail -20

# Check startup sequence
docker logs l2liquidator-worker-1 | grep -E "(boot|launching)"

# Verify contract addresses
grep -A 3 "PRELIQ_FACTORY" offchain/indexer/morpho_preliq_indexer.ts

# Check compiled output
ls -lh dist/offchain/indexer/morpho_preliq_indexer.js
ls -lh dist/offchain/executor/preliq_executor.js
ls -lh dist/offchain/pipeline/preliq_scorer.js

# Test build
npm run build 2>&1 | grep -E "(error|warning)"


📈 PERFORMANCE TRACKING
─────────────────────────────────────────────────────────────────

# Capture rate (attempts / total opportunities)
# Manual calculation from logs and metrics

# Profit per liquidation
curl -s http://localhost:9464/metrics | grep preliq_profit_usd

# Success rate
# success_total / attempt_total

# Average execution time
docker logs l2liquidator-worker-1 | grep "preliq-executing" | tail -10


🎯 STATUS CHECKS
─────────────────────────────────────────────────────────────────

# Is system enabled?
docker logs l2liquidator-worker-1 | grep "Pre-Liquidation Alpha ENABLED"

# Are contracts deployed?
grep "0x000000000000" offchain/indexer/morpho_preliq_indexer.ts
# If found → contracts NOT deployed yet

# Are API keys set?
grep -E "(ODOS|ONEINCH)_API_KEY=.+" .env
# Should show keys, not empty

# Is worker healthy?
docker ps --filter name=l2liquidator-worker --format "{{.Status}}"
# Should show "Up" and "healthy"


📚 DOCUMENTATION
─────────────────────────────────────────────────────────────────

cat DEPLOYMENT_STATUS.md      # Current deployment status
cat FINAL_SUMMARY.md           # Complete overview
cat PRELIQ_COMPLETE.md         # Production guide
cat PRELIQ_PRODUCTION_READY.md # Architecture details

bash scripts/verify_preliq_complete.sh  # Run verification


═══════════════════════════════════════════════════════════════════

CURRENT STATUS: Run 'cat DEPLOYMENT_STATUS.md' for latest status

EOF
