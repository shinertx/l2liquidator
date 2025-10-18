#!/usr/bin/env ts-node
/**
 * Auto-sync Morpho Blue markets to config.yaml
 * 
 * Extracts active market pairs from orchestrator logs and adds them to config
 * 
 * Usage: npm run sync:morpho:markets
 */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { execSync } from 'child_process';

const CONFIG_PATH = path.resolve(__dirname, '../../config.yaml');

type MarketPair = {
  debtAsset: string;
  collateralAsset: string;
  chainId: number;
  count: number;
  minHealthFactor: number;
  maxHealthFactor: number;
};

function extractMarketsFromLogs(): MarketPair[] {
  console.log('📊 Analyzing orchestrator logs for Morpho Blue markets...\n');

  try {
    // Get market pairs from logs
    const command = `docker logs l2liquidator-worker-1 2>&1 | grep -E "morphoblue|morpho" | jq -r 'select(.candidate or .market) | "\\(.candidate.chainId // .market.chainId)|\\(.candidate.debt.symbol // .market.debt.symbol)|\\(.candidate.collateral.symbol // .market.collateral.symbol)|\\(.candidate.healthFactor // .market.healthFactor)"' 2>/dev/null | grep -v "null" | sort | uniq`;
    
    const output = execSync(command, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const lines = output.trim().split('\n').filter(l => l);

    const marketMap = new Map<string, MarketPair>();

    for (const line of lines) {
      const [chainIdStr, debtAsset, collateralAsset, hfStr] = line.split('|');
      if (!chainIdStr || !debtAsset || !collateralAsset || !hfStr) continue;

      const chainId = parseInt(chainIdStr);
      const hf = parseFloat(hfStr);
      if (isNaN(chainId) || isNaN(hf)) continue;

      const key = `${chainId}:${debtAsset}/${collateralAsset}`;
      const existing = marketMap.get(key);

      if (existing) {
        existing.count++;
        existing.minHealthFactor = Math.min(existing.minHealthFactor, hf);
        existing.maxHealthFactor = Math.max(existing.maxHealthFactor, hf);
      } else {
        marketMap.set(key, {
          chainId,
          debtAsset,
          collateralAsset,
          count: 1,
          minHealthFactor: hf,
          maxHealthFactor: hf,
        });
      }
    }

    return Array.from(marketMap.values())
      .sort((a, b) => b.count - a.count); // Sort by frequency

  } catch (err) {
    console.error('❌ Failed to extract markets from logs:', (err as Error).message);
    return [];
  }
}

function updateConfig(markets: MarketPair[], minCandidates = 5, dryRun = false) {
  console.log(`\n📝 Updating config.yaml (dry run: ${dryRun})...\n`);

  // Read config
  const configYaml = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = YAML.parse(configYaml) as any;

  if (!config.markets) {
    config.markets = [];
  }

  // Find existing Morpho Blue markets
  const existingMarkets = new Set<string>();
  for (const market of config.markets) {
    if (market.protocol === 'morphoblue') {
      const key = `${market.chainId}:${market.debtAsset}/${market.collateralAsset}`;
      existingMarkets.add(key);
    }
  }

  let addedCount = 0;
  let skippedCount = 0;

  // Add new markets
  for (const market of markets) {
    if (market.count < minCandidates) {
      skippedCount++;
      continue;
    }

    const key = `${market.chainId}:${market.debtAsset}/${market.collateralAsset}`;
    
    if (existingMarkets.has(key)) {
      console.log(`  ⏭️  ${key.padEnd(40)} (already exists)`);
      continue;
    }

    const newMarket = {
      protocol: 'morphoblue',
      chainId: market.chainId,
      debtAsset: market.debtAsset,
      collateralAsset: market.collateralAsset,
      enabled: true,
    };

    if (!dryRun) {
      // Find insertion point (after last morphoblue market)
      let insertIndex = config.markets.findIndex((m: any) => m.protocol !== 'morphoblue' && config.markets.slice(0, config.markets.indexOf(m)).some((pm: any) => pm.protocol === 'morphoblue'));
      if (insertIndex === -1) {
        // No morphoblue markets yet, insert at beginning
        insertIndex = 0;
      }
      config.markets.splice(insertIndex, 0, newMarket);
    }

    addedCount++;
    console.log(`  ✅ ${key.padEnd(40)} (${market.count} candidates, HF ${market.minHealthFactor.toFixed(3)}-${market.maxHealthFactor.toFixed(3)})`);
  }

  if (skippedCount > 0) {
    console.log(`\n  ℹ️  Skipped ${skippedCount} markets with <${minCandidates} candidates`);
  }

  // Write back to config
  if (!dryRun && addedCount > 0) {
    const updatedYaml = YAML.stringify(config, { indent: 2, lineWidth: 0 });
    fs.writeFileSync(CONFIG_PATH, updatedYaml);
    console.log(`\n✅ Added ${addedCount} new Morpho Blue markets to config.yaml`);
  } else if (dryRun) {
    console.log(`\n  (Dry run - would add ${addedCount} markets)`);
  } else {
    console.log(`\n  ℹ️  No new markets to add`);
  }

  return addedCount;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const minCandidates = parseInt(process.argv.find(arg => arg.startsWith('--min='))?.split('=')[1] || '5');

  console.log('🚀 Morpho Blue Market Auto-Sync Tool');
  console.log('=====================================');
  console.log(`   Min candidates threshold: ${minCandidates}`);
  console.log(`   Dry run: ${dryRun}\n`);

  const markets = extractMarketsFromLogs();
  
  if (markets.length === 0) {
    console.log('❌ No markets found in logs. Is the orchestrator running?');
    process.exit(1);
  }

  console.log(`📈 Found ${markets.length} unique market pairs in logs`);
  console.log(`\nTop 10 by candidate count:`);
  for (const market of markets.slice(0, 10)) {
    const key = `${market.chainId}:${market.debtAsset}/${market.collateralAsset}`;
    console.log(`   ${market.count.toString().padStart(4)} - ${key}`);
  }

  const added = updateConfig(markets, minCandidates, dryRun);

  if (!dryRun && added > 0) {
    console.log('\n📋 Next Steps:');
    console.log('   1. Review changes: git diff config.yaml');
    console.log('   2. Restart orchestrator: docker compose restart worker');
    console.log('   3. Monitor liquidations: docker logs -f l2liquidator-worker-1 | grep -E "simulating|executing|profit"');
  }
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
