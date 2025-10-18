#!/usr/bin/env node
/**
 * Check Morpho Blue liquidation opportunities on Base
 */

const MORPHO_GRAPHQL_URL = 'https://blue-api.morpho.org/graphql';

// Query for positions with HF < 1.1 (includes liquidatable and near-liquidation)
const query = `
  query MarketPositionScan($first: Int!, $chainIds: [Int!], $hf: Float!) {
    marketPositions(
      first: $first
      where: { chainId_in: $chainIds, healthFactor_lte: $hf }
    ) {
      items {
        id
        healthFactor
        user {
          address
        }
        market {
          uniqueKey
          lltv
          loanAsset {
            symbol
            address
          }
          collateralAsset {
            symbol
            address
          }
        }
        state {
          borrowAssets
          collateral
          borrowShares
        }
      }
    }
  }
`;

async function checkMorphoOpportunities() {
  try {
    console.log(`\n🔍 Checking Morpho Blue on Base (Chain ID: 8453)...\n`);

    const response = await fetch(MORPHO_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          first: 500,
          chainIds: [8453], // Base
          hf: 1.1, // Check all positions with HF below 1.1
        },
      }),
    });

    const result = await response.json();

    if (result.errors) {
      console.error('❌ GraphQL errors:', JSON.stringify(result.errors, null, 2));
      return;
    }

    const positions = result.data?.marketPositions?.items || [];
    console.log(`📊 Total positions found with HF ≤ 1.1: ${positions.length}\n`);

    let liquidatable = 0;
    let nearLiquidation = 0;
    let risky = 0;

    const liquidatableDetails = [];
    const nearDetails = [];

    positions.forEach(pos => {
      const hf = parseFloat(pos.healthFactor);
      const borrowAmount = BigInt(pos.state.borrowAssets || '0');
      const collateralAmount = BigInt(pos.state.collateral || '0');

      const positionInfo = {
        address: pos.user.address,
        hf: hf.toFixed(6),
        market: `${pos.market.collateralAsset?.symbol || '?'}/${pos.market.loanAsset?.symbol || '?'}`,
        lltv: pos.market.lltv ? `${(parseFloat(pos.market.lltv) * 100).toFixed(2)}%` : 'N/A',
        borrowed: borrowAmount.toString(),
        collateral: collateralAmount.toString(),
        uniqueKey: pos.market.uniqueKey,
      };

      if (hf < 1.0) {
        liquidatable++;
        liquidatableDetails.push(positionInfo);
      } else if (hf < 1.02) {
        nearLiquidation++;
        nearDetails.push(positionInfo);
      } else {
        risky++;
      }
    });

    // Show liquidatable positions
    if (liquidatableDetails.length > 0) {
      console.log(`🔴 LIQUIDATABLE POSITIONS (HF < 1.0): ${liquidatableDetails.length}\n`);
      liquidatableDetails.forEach((pos, idx) => {
        console.log(`${idx + 1}. ${pos.address}`);
        console.log(`   Health Factor: ${pos.hf}`);
        console.log(`   Market: ${pos.market} (LLTV: ${pos.lltv})`);
        console.log(`   Borrowed: ${pos.borrowed}`);
        console.log(`   Collateral: ${pos.collateral}`);
        console.log(`   UniqueKey: ${pos.uniqueKey}`);
        console.log('');
      });
    } else {
      console.log(`🔴 LIQUIDATABLE POSITIONS (HF < 1.0): 0\n`);
    }

    // Show near-liquidation positions
    if (nearDetails.length > 0 && nearDetails.length <= 10) {
      console.log(`🟡 NEAR LIQUIDATION (1.0 ≤ HF < 1.02): ${nearDetails.length}\n`);
      nearDetails.forEach((pos, idx) => {
        console.log(`${idx + 1}. ${pos.address}`);
        console.log(`   Health Factor: ${pos.hf}`);
        console.log(`   Market: ${pos.market} (LLTV: ${pos.lltv})`);
        console.log('');
      });
    } else if (nearDetails.length > 0) {
      console.log(`🟡 NEAR LIQUIDATION (1.0 ≤ HF < 1.02): ${nearDetails.length}`);
      console.log(`   (Too many to display individually)\n`);
    }

    console.log(`\n📈 SUMMARY:`);
    console.log(`   🔴 Liquidatable (HF < 1.0): ${liquidatable}`);
    console.log(`   🟡 Near Liquidation (1.0 ≤ HF < 1.02): ${nearLiquidation}`);
    console.log(`   � Risky (1.02 ≤ HF < 1.1): ${risky}`);
    console.log(`   📊 Total positions checked: ${positions.length}\n`);

    if (liquidatable === 0 && nearLiquidation === 0) {
      console.log(`✅ Market is healthy - no immediate opportunities`);
      console.log(`💡 Opportunities appear when:`);
      console.log(`   - Collateral price drops suddenly`);
      console.log(`   - Debt token price increases`);
      console.log(`   - Interest accrues on leveraged positions`);
      console.log(`   - Oracle updates lag DEX prices\n`);
    } else {
      console.log(`🎯 OPPORTUNITIES DETECTED!`);
      console.log(`💰 Potential liquidations available now or soon\n`);
    }
  } catch (error) {
    console.error('❌ Error fetching Morpho data:', error.message);
  }
}

checkMorphoOpportunities();
