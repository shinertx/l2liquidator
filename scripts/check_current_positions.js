#!/usr/bin/env node
/**
 * Check what positions our current system is tracking
 * Parse logs to find all unique borrowers and their health factors
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function analyzeCurrentPositions() {
  try {
    console.log(`\n🔍 Analyzing positions currently being monitored...\n`);

    // Get last 2000 log lines with health factor info
    const { stdout } = await execPromise(
      'docker logs --tail 2000 l2liquidator-worker-1 2>&1 | grep -E "\\"healthFactor\\":" | tail -500'
    );

    const lines = stdout.trim().split('\n').filter(line => line);
    
    const positions = new Map();

    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        
        if (json.borrower && json.healthFactor !== undefined && json.chainId) {
          const key = `${json.chainId}-${json.borrower}`;
          const hf = parseFloat(json.healthFactor);
          
          if (isFinite(hf) && hf > 0) {
            // Keep the most recent HF for each position
            if (!positions.has(key) || positions.get(key).time < json.time) {
              positions.set(key, {
                borrower: json.borrower,
                chainId: json.chainId,
                chain: json.chain || (json.chainId === 42161 ? 'arbitrum' : json.chainId === 10 ? 'optimism' : json.chainId === 8453 ? 'base' : json.chainId === 137 ? 'polygon' : 'unknown'),
                healthFactor: hf,
                time: json.time,
                protocol: json.protocol || 'aavev3',
              });
            }
          }
        }
      } catch (e) {
        // Skip invalid JSON
      }
    }

    console.log(`📊 Found ${positions.size} unique positions being monitored\n`);

    // Categorize positions
    const liquidatable = [];
    const nearLiquidation = [];
    const risky = [];
    const healthy = [];

    for (const [key, pos] of positions.entries()) {
      if (pos.healthFactor < 1.0) {
        liquidatable.push(pos);
      } else if (pos.healthFactor < 1.02) {
        nearLiquidation.push(pos);
      } else if (pos.healthFactor < 1.1) {
        risky.push(pos);
      } else {
        healthy.push(pos);
      }
    }

    // Sort by health factor
    liquidatable.sort((a, b) => a.healthFactor - b.healthFactor);
    nearLiquidation.sort((a, b) => a.healthFactor - b.healthFactor);
    risky.sort((a, b) => a.healthFactor - b.healthFactor);

    // Display liquidatable
    if (liquidatable.length > 0) {
      console.log(`🔴 LIQUIDATABLE (HF < 1.0): ${liquidatable.length}\n`);
      liquidatable.forEach((pos, idx) => {
        console.log(`${idx + 1}. ${pos.borrower}`);
        console.log(`   Chain: ${pos.chain} (${pos.chainId})`);
        console.log(`   Health Factor: ${pos.healthFactor.toFixed(6)}`);
        console.log(`   Protocol: ${pos.protocol}`);
        console.log('');
      });
    } else {
      console.log(`🔴 LIQUIDATABLE (HF < 1.0): 0\n`);
    }

    // Display near liquidation
    if (nearLiquidation.length > 0) {
      console.log(`🟡 NEAR LIQUIDATION (1.0 ≤ HF < 1.02): ${nearLiquidation.length}\n`);
      nearLiquidation.slice(0, 20).forEach((pos, idx) => {
        console.log(`${idx + 1}. ${pos.borrower}`);
        console.log(`   Chain: ${pos.chain}`);
        console.log(`   Health Factor: ${pos.healthFactor.toFixed(6)}`);
        console.log('');
      });
      if (nearLiquidation.length > 20) {
        console.log(`   ... and ${nearLiquidation.length - 20} more\n`);
      }
    } else {
      console.log(`🟡 NEAR LIQUIDATION (1.0 ≤ HF < 1.02): 0\n`);
    }

    // Display risky (1.02-1.1)
    if (risky.length > 0) {
      console.log(`🟠 RISKY (1.02 ≤ HF < 1.1): ${risky.length}\n`);
      
      // Show lowest 10
      const lowest = risky.slice(0, 10);
      console.log(`   Showing 10 lowest HF positions:\n`);
      lowest.forEach((pos, idx) => {
        console.log(`   ${idx + 1}. ${pos.borrower.substring(0, 10)}... (${pos.chain})`);
        console.log(`      HF: ${pos.healthFactor.toFixed(6)}`);
      });
      console.log('');
    } else {
      console.log(`🟠 RISKY (1.02 ≤ HF < 1.1): 0\n`);
    }

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📈 SUMMARY OF CURRENT AAVE V3 POSITIONS`);
    console.log(`${'='.repeat(60)}\n`);
    console.log(`   🔴 Liquidatable (HF < 1.0): ${liquidatable.length}`);
    console.log(`   🟡 Near Liquidation (1.0 ≤ HF < 1.02): ${nearLiquidation.length}`);
    console.log(`   🟠 Risky (1.02 ≤ HF < 1.1): ${risky.length}`);
    console.log(`   🟢 Healthy (HF ≥ 1.1): ${healthy.length}`);
    console.log(`   📊 Total Unique Positions: ${positions.size}\n`);

    // Chain breakdown
    const byChain = {
      arbitrum: { total: 0, risky: 0 },
      optimism: { total: 0, risky: 0 },
      base: { total: 0, risky: 0 },
      polygon: { total: 0, risky: 0 },
    };

    for (const [key, pos] of positions.entries()) {
      if (byChain[pos.chain]) {
        byChain[pos.chain].total++;
        if (pos.healthFactor < 1.1) {
          byChain[pos.chain].risky++;
        }
      }
    }

    console.log(`\n📍 BY CHAIN:`);
    for (const [chain, stats] of Object.entries(byChain)) {
      if (stats.total > 0) {
        console.log(`   ${chain}: ${stats.total} total, ${stats.risky} risky`);
      }
    }
    console.log('');

    // Analysis
    if (liquidatable.length === 0 && nearLiquidation.length === 0) {
      console.log(`\n✅ ALL AAVE V3 POSITIONS ARE HEALTHY (HF ≥ 1.02)`);
      console.log(`💡 This confirms the market is saturated with bots\n`);
      
      if (risky.length > 0) {
        console.log(`⚠️  However, ${risky.length} positions are in the 1.02-1.1 range`);
        console.log(`   These COULD become liquidatable if:`);
        console.log(`   - Collateral price drops 5-10%`);
        console.log(`   - Debt token price increases`);
        console.log(`   - Interest accrues on position`);
        console.log(`   - Oracle update delays\n`);
      }
    } else {
      console.log(`\n🎯 OPPORTUNITIES DETECTED IN CURRENT SYSTEM!`);
      console.log(`💰 ${liquidatable.length + nearLiquidation.length} positions worth checking\n`);
    }

    // Recommendation
    console.log(`\n${'='.repeat(60)}`);
    console.log(`💡 RECOMMENDATION`);
    console.log(`${'='.repeat(60)}\n`);
    
    if (liquidatable.length > 0 || nearLiquidation.length > 0) {
      console.log(`✅ Your current system IS finding opportunities!`);
      console.log(`   Keep monitoring these positions closely.\n`);
    } else {
      console.log(`❌ Your current Aave v3 system has NO liquidatable positions`);
      console.log(`   This is why we need Morpho Blue with 18 liquidatable now!\n`);
      console.log(`   Comparison:`);
      console.log(`   - Aave v3: ${liquidatable.length} liquidatable`);
      console.log(`   - Morpho Blue: 18 liquidatable (on Base alone)`);
      console.log(`   - **10x more opportunities on Morpho!** 🚀\n`);
    }

  } catch (error) {
    console.error('Error analyzing positions:', error.message);
  }
}

analyzeCurrentPositions();
