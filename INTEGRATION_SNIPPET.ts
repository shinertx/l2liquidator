// Quick integration snippet for orchestrator.ts
// Add this after the standard Morpho Blue indexer is running

import { pollPreLiqOffers } from './indexer/morpho_preliq_indexer';
import { scorePreLiq } from './pipeline/preliq_scorer';
import { executePreLiquidation } from './executor/preliq_executor';
import { startLiquidityMonitor } from './tools/public_allocator_probe';

// Start liquidity intelligence monitoring
startLiquidityMonitor([8453, 42161, 10]); // Base, Arbitrum, Optimism

// Start pre-liq offer discovery
pollPreLiqOffers(cfg, async (candidate) => {
  const score = await scorePreLiq(candidate, candidate.chainId, candidate.morpho?.uniqueKey || '');
  
  if (score.accepted) {
    console.log(`[PreLiq] Executing profitable pre-liquidation: ${score.netProfitUsd?.toFixed(2)} USD`);
    
    if (!cfg.dryRun) {
      await executePreLiquidation(candidate, cfg);
    } else {
      console.log('[PreLiq] DRY RUN - would execute pre-liquidation');
    }
  } else {
    console.log(`[PreLiq] Skipped: ${score.reason}`);
  }
});

console.log('[PreLiq] Pre-Liquidation Alpha system initialized ✅');
