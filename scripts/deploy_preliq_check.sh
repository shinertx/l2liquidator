#!/bin/bash
# Production Readiness Deployment Script for Pre-Liquidation Alpha

set -e

echo "🚀 Pre-Liquidation Alpha - Production Deployment"
echo "================================================"
echo ""

# Step 1: Verify Build
echo "📦 Step 1: Building TypeScript..."
npm run build
echo "✅ Build successful"
echo ""

# Step 2: Environment Check
echo "🔍 Step 2: Checking environment variables..."
REQUIRED_VARS=("RPC_BASE" "RPC_ARB" "RPC_OP" "WALLET_PK_BASE" "WALLET_PK_ARB" "WALLET_PK_OP")
MISSING=()

for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var}" ]; then
    MISSING+=("$var")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "❌ Missing environment variables: ${MISSING[*]}"
  exit 1
fi
echo "✅ All required environment variables present"
echo ""

# Step 3: Contract Deployment Status
echo "📋 Step 3: Pre-Liquidation Contract Status..."
echo ""
echo "⚠️  WARNING: Pre-Liquidation contracts NOT YET DEPLOYED"
echo ""
echo "Required deployments:"
echo "  1. PreLiquidationFactory (Base, Arbitrum, Optimism)"
echo "  2. PreLiquidation offer template contract"
echo "  3. Update addresses in offchain/indexer/morpho_preliq_indexer.ts"
echo ""
echo "Current status: SKELETON COMPLETE, awaiting contract deployment"
echo ""

# Step 4: Check Database
echo "🗄️  Step 4: Checking database connection..."
if command -v psql &> /dev/null; then
  if psql $DATABASE_URL -c "SELECT 1;" &> /dev/null; then
    echo "✅ Database connection successful"
  else
    echo "⚠️  Database connection failed (may be normal if using Docker)"
  fi
else
  echo "⚠️  psql not installed, skipping DB check"
fi
echo ""

# Step 5: Check Redis
echo "📮 Step 5: Checking Redis connection..."
if command -v redis-cli &> /dev/null; then
  if redis-cli ping &> /dev/null; then
    echo "✅ Redis connection successful"
  else
    echo "⚠️  Redis connection failed (may be normal if using Docker)"
  fi
else
  echo "⚠️  redis-cli not installed, skipping Redis check"
fi
echo ""

# Step 6: Docker Status
echo "🐳 Step 6: Checking Docker containers..."
if command -v docker &> /dev/null; then
  docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "(worker|db|redis|risk-engine)"
  echo ""
else
  echo "⚠️  Docker not available"
  echo ""
fi

# Step 7: Implementation Status
echo "📊 Step 7: Implementation Status Summary..."
echo ""
echo "✅ COMPLETED:"
echo "  • Morpho Blue liquidator deployed to Base (0x6700a690...)"
echo "  • 22 Morpho Blue markets configured"
echo "  • 32 tokens with metadata"
echo "  • Standard liquidations operational"
echo "  • Pre-liquidation indexer skeleton (morpho_preliq_indexer.ts)"
echo "  • Pre-liquidation executor skeleton (preliq_executor.ts)"
echo "  • Pre-liquidation scorer skeleton (preliq_scorer.ts)"
echo "  • Public Allocator probe skeleton (public_allocator_probe.ts)"
echo "  • Morpho contract addresses mapped"
echo "  • Odos/1inch router addresses configured"
echo ""
echo "⏳ IN PROGRESS:"
echo "  • PreLiquidation contract deployment"
echo "  • CREATE2 address computation"
echo "  • Event monitoring integration"
echo "  • Bundler3 multicall encoding"
echo "  • Odos/1inch API integration"
echo "  • Oracle price fetching"
echo "  • Transaction execution with Timeboost"
echo ""
echo "🎯 NEXT STEPS:"
echo "  1. Deploy PreLiquidationFactory contracts"
echo "  2. Update PRELIQ_FACTORY addresses in morpho_preliq_indexer.ts"
echo "  3. Implement CREATE2 computation"
echo "  4. Add Odos/1inch API keys to environment"
echo "  5. Wire pre-liq pipeline into orchestrator"
echo "  6. Run dry-run tests"
echo "  7. Gradual production rollout"
echo ""

# Step 8: File Inventory
echo "📁 Step 8: Pre-Liquidation File Inventory..."
echo ""
ls -lh offchain/indexer/morpho_preliq_indexer.ts offchain/executor/preliq_executor.ts offchain/pipeline/preliq_scorer.ts offchain/tools/public_allocator_probe.ts 2>/dev/null | awk '{print $9, "→", $5}'
echo ""

echo "================================================"
echo "✅ Pre-Liquidation Alpha - Ready for Next Phase"
echo "================================================"
echo ""
echo "Phase 1: Skeleton Implementation ✅ COMPLETE"
echo "Phase 2: Contract Deployment → IN PROGRESS"
echo "Phase 3: Integration & Testing → PENDING"
echo "Phase 4: Production Deployment → PENDING"
echo ""
echo "To proceed:"
echo "  1. Deploy contracts: forge create PreLiquidationFactory --broadcast"
echo "  2. Update addresses: vim offchain/indexer/morpho_preliq_indexer.ts"
echo "  3. Test: npm run dev (dry-run mode)"
echo "  4. Deploy: docker-compose up -d"
echo ""
