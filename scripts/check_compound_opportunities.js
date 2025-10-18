#!/usr/bin/env node
/**
 * Check Compound V3 liquidation opportunities on Arbitrum and Base
 */

const COMPOUND_SUBGRAPH_ARB = 'https://api.goldsky.com/api/public/project_clp5vhx9b3hgn01tt1kqt5lke/subgraphs/compound-v3-arbitrum/1.1.3/gn';
const COMPOUND_SUBGRAPH_BASE = 'https://api.goldsky.com/api/public/project_clp5vhx9b3hgn01tt1kqt5lke/subgraphs/compound-v3-base/1.1.3/gn';

const query = `
  query GetCompoundAccounts($first: Int!) {
    accounts(
      first: $first
      orderBy: collateralBalanceUsd
      orderDirection: desc
      where: { borrowBalanceUsd_gt: "0" }
    ) {
      id
      address
      market {
        id
        symbol
        baseToken {
          symbol
          decimals
        }
      }
      collateralBalance
      collateralBalanceUsd
      borrowBalance
      borrowBalanceUsd
      supplyBalance
      health
    }
  }
`;

async function checkCompoundChain(chainName, subgraphUrl) {
  try {
    console.log(`\n🔍 Checking Compound V3 on ${chainName}...\n`);

    const response = await fetch(subgraphUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          first: 1000,
        },
      }),
    });

    const result = await response.json();

    if (result.errors) {
      console.error(`❌ GraphQL errors on ${chainName}:`, JSON.stringify(result.errors, null, 2));
      return {
        liquidatable: 0,
        near: 0,
        risky: 0,
        healthy: 0,
      };
    }

    const accounts = result.data?.accounts || [];
    console.log(`📊 Total accounts with borrows: ${accounts.length}\n`);

    let liquidatable = 0;
    let nearLiquidation = 0;
    let risky = 0;
    let healthy = 0;

    const liquidatableDetails = [];
    const nearDetails = [];

    accounts.forEach(account => {
      // In Compound V3, health < 1.0 means undercollateralized
      const health = parseFloat(account.health || '0');
      const borrowUsd = parseFloat(account.borrowBalanceUsd || '0');
      const collateralUsd = parseFloat(account.collateralBalanceUsd || '0');

      // Skip if no real position
      if (borrowUsd === 0) return;

      const accountInfo = {
        address: account.address,
        health: health.toFixed(6),
        market: account.market?.symbol || 'Unknown',
        baseToken: account.market?.baseToken?.symbol || 'Unknown',
        borrowedUSD: borrowUsd.toFixed(2),
        collateralUSD: collateralUsd.toFixed(2),
      };

      if (health < 1.0) {
        liquidatable++;
        liquidatableDetails.push(accountInfo);
      } else if (health < 1.05) {
        nearLiquidation++;
        nearDetails.push(accountInfo);
      } else if (health < 1.2) {
        risky++;
      } else {
        healthy++;
      }
    });

    // Show liquidatable positions
    if (liquidatableDetails.length > 0) {
      console.log(`🔴 LIQUIDATABLE ACCOUNTS (Health < 1.0): ${liquidatableDetails.length}\n`);
      liquidatableDetails.forEach((acc, idx) => {
        console.log(`${idx + 1}. ${acc.address}`);
        console.log(`   Health: ${acc.health}`);
        console.log(`   Market: ${acc.market} (${acc.baseToken})`);
        console.log(`   Borrowed: $${acc.borrowedUSD}`);
        console.log(`   Collateral: $${acc.collateralUSD}`);
        console.log('');
      });
    } else {
      console.log(`🔴 LIQUIDATABLE ACCOUNTS (Health < 1.0): 0\n`);
    }

    // Show near-liquidation accounts (limit to 10)
    if (nearDetails.length > 0 && nearDetails.length <= 10) {
      console.log(`🟡 NEAR LIQUIDATION (1.0 ≤ Health < 1.05): ${nearDetails.length}\n`);
      nearDetails.forEach((acc, idx) => {
        console.log(`${idx + 1}. ${acc.address}`);
        console.log(`   Health: ${acc.health}`);
        console.log(`   Market: ${acc.market}`);
        console.log(`   Borrowed: $${acc.borrowedUSD}`);
        console.log('');
      });
    } else if (nearDetails.length > 0) {
      console.log(`🟡 NEAR LIQUIDATION (1.0 ≤ Health < 1.05): ${nearDetails.length}`);
      console.log(`   (Too many to display individually)\n`);
    }

    console.log(`\n📈 ${chainName.toUpperCase()} SUMMARY:`);
    console.log(`   🔴 Liquidatable (Health < 1.0): ${liquidatable}`);
    console.log(`   🟡 Near Liquidation (1.0 ≤ Health < 1.05): ${nearLiquidation}`);
    console.log(`   🟠 Risky (1.05 ≤ Health < 1.2): ${risky}`);
    console.log(`   🟢 Healthy (Health ≥ 1.2): ${healthy}`);
    console.log(`   📊 Total accounts checked: ${liquidatable + nearLiquidation + risky + healthy}\n`);

    if (liquidatable === 0 && nearLiquidation === 0) {
      console.log(`✅ ${chainName} market is healthy - no immediate opportunities\n`);
    } else {
      console.log(`🎯 ${chainName} OPPORTUNITIES DETECTED!`);
      console.log(`💰 Potential liquidations available\n`);
    }

    return {
      liquidatable,
      near: nearLiquidation,
      risky,
      healthy,
    };
  } catch (error) {
    console.error(`❌ Error fetching Compound V3 data from ${chainName}:`, error.message);
    return {
      liquidatable: 0,
      near: 0,
      risky: 0,
      healthy: 0,
    };
  }
}

async function checkAllCompoundMarkets() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🏦 COMPOUND V3 LIQUIDATION OPPORTUNITY SCAN`);
  console.log(`${'='.repeat(60)}`);

  const arbResults = await checkCompoundChain('Arbitrum', COMPOUND_SUBGRAPH_ARB);
  
  console.log(`\n${'-'.repeat(60)}\n`);
  
  const baseResults = await checkCompoundChain('Base', COMPOUND_SUBGRAPH_BASE);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 TOTAL COMPOUND V3 SUMMARY (Both Chains)`);
  console.log(`${'='.repeat(60)}\n`);
  
  const total = {
    liquidatable: arbResults.liquidatable + baseResults.liquidatable,
    near: arbResults.near + baseResults.near,
    risky: arbResults.risky + baseResults.risky,
    healthy: arbResults.healthy + baseResults.healthy,
  };

  console.log(`   🔴 Total Liquidatable: ${total.liquidatable}`);
  console.log(`   🟡 Total Near Liquidation: ${total.near}`);
  console.log(`   🟠 Total Risky: ${total.risky}`);
  console.log(`   🟢 Total Healthy: ${total.healthy}`);
  console.log(`   📊 Total Accounts: ${total.liquidatable + total.near + total.risky + total.healthy}\n`);

  if (total.liquidatable > 0 || total.near > 0) {
    console.log(`🎯 COMPOUND V3 HAS OPPORTUNITIES!`);
    console.log(`💰 Total liquidatable + near: ${total.liquidatable + total.near}\n`);
  } else {
    console.log(`✅ All Compound V3 markets are healthy`);
    console.log(`💡 Opportunities typically appear during:\n`);
    console.log(`   - Market volatility (price swings)`);
    console.log(`   - Interest rate changes`);
    console.log(`   - Oracle update delays\n`);
  }
}

checkAllCompoundMarkets();
