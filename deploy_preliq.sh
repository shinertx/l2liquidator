#!/bin/bash

# Pre-Liquidation Alpha Deployment Script
# This activates the pre-liquidation system in DRY-RUN mode first

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  PRE-LIQUIDATION ALPHA - DEPLOYMENT                        ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Check environment
echo "🔍 Checking Environment..."
if ! grep -q "PRELIQ_ENABLED=1" .env 2>/dev/null; then
    echo "export PRELIQ_ENABLED=1" >> .env
    echo "   ✅ PRELIQ_ENABLED=1 added to .env"
else
    echo "   ✅ PRELIQ_ENABLED=1 already set"
fi

# Check build
echo ""
echo "🔨 Building..."
npm run build > /dev/null 2>&1 && echo "   ✅ Build successful" || (echo "   ❌ Build failed" && exit 1)

# Check if dry-run mode
if grep -q "dryRun: true" config.yaml; then
    echo ""
    echo "⚠️  DRY-RUN MODE ENABLED (recommended for first deployment)"
    echo "   System will discover and score offers but NOT execute"
    echo "   Monitor logs to verify discovery is working"
    DRY_RUN=true
else
    echo ""
    echo "⚠️  LIVE MODE - Transactions will be submitted!"
    read -p "   Continue? (yes/no): " confirm
    if [ "$confirm" != "yes" ]; then
        echo "   Deployment cancelled"
        exit 0
    fi
    DRY_RUN=false
fi

# Restart Docker containers
echo ""
echo "🐳 Restarting Docker Containers..."
docker-compose restart worker 2>/dev/null || docker-compose up -d

# Wait for startup
echo ""
echo "⏳ Waiting for worker to start (10 seconds)..."
sleep 10

# Check logs
echo ""
echo "📊 Checking Logs (last 30 lines)..."
docker logs --tail 30 l2liquidator-worker-1 2>/dev/null | grep -E "(preliq|Pre-Liquidation|boot)" || echo "   (No preliq logs yet - may take a minute to initialize)"

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  DEPLOYMENT COMPLETE                                       ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo "STATUS: 🟡 DRY-RUN MODE ACTIVE"
    echo ""
    echo "MONITOR LOGS:"
    echo "  docker logs -f l2liquidator-worker-1 | grep preliq"
    echo ""
    echo "LOOK FOR:"
    echo "  ✅ '🎯 Pre-Liquidation Alpha ENABLED'"
    echo "  ✅ 'preliq-executing' (would-execute messages)"
    echo "  ✅ 'preliq-rejected' (with reasons)"
    echo ""
    echo "TO GO LIVE:"
    echo "  1. Verify offers are being discovered"
    echo "  2. Set dryRun: false in config.yaml"
    echo "  3. Deploy PreLiquidation contracts (update addresses)"
    echo "  4. Add ODOS_API_KEY and ONEINCH_API_KEY to .env"
    echo "  5. Restart: docker-compose restart worker"
else
    echo "STATUS: 🟢 LIVE MODE ACTIVE"
    echo ""
    echo "MONITOR:"
    echo "  docker logs -f l2liquidator-worker-1"
    echo "  http://localhost:9464/metrics (Prometheus)"
    echo ""
    echo "METRICS:"
    echo "  preliq_attempt_total"
    echo "  preliq_success_total"
    echo "  preliq_profit_usd"
    echo ""
    echo "ALERTS:"
    echo "  - Revert rate >5% → pause and investigate"
    echo "  - Negative PnL → check swap routing"
fi

echo ""
echo "Read FINAL_SUMMARY.md for complete deployment guide"
echo ""
