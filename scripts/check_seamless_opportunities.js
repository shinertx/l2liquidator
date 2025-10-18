#!/usr/bin/env node
/**
 * Check Seamless Protocol liquidation opportunities on Base
 * Seamless uses the same subgraph as Aave v3
 */

const SEAMLESS_SUBGRAPH_URL = 'https://api.studio.thegraph.com/query/52746/seamless-protocol/version/latest';

const query = `
  query GetSeamlessPositions($first: Int!, $healthFactorMax: String!) {
    users(
      first: $first
      orderBy: totalCollateralUSD
      orderDirection: desc
      where: { borrowedReservesCount_gt: 0 }
    ) {
      id
      borrowedReservesCount
      reserves {
        id
        currentATokenBalance
        currentTotalDebt
        reserve {
          symbol
          decimals
          underlyingAsset
          price {
            priceInEth
          }
        }
      }
    }
    userReserves(
      first: $first
      where: {
        scaledVariableDebt_gt: "0"
        user_: { borrowedReservesCount_gt: 0 }
      }
      orderBy: currentTotalDebt
      orderDirection: desc
    ) {
      id
      currentTotalDebt
      currentATokenBalance
      scaledVariableDebt
      user {
        id
      }
      reserve {
        symbol
        decimals
        underlyingAsset
        usageAsCollateralEnabled
        liquidationThreshold
        price {
          priceInEth
        }
      }
    }
  }
`;

function calculateHealthFactor(userReserves, ethPrice = 3900) {
  let totalCollateralUSD = 0;
  let totalDebtUSD = 0;

  for (const reserve of userReserves) {
    const decimals = parseInt(reserve.reserve.decimals);
    const priceInEth = parseFloat(reserve.reserve.price?.priceInEth || '0');
    const priceUSD = priceInEth * ethPrice;

    // Collateral
    if (reserve.currentATokenBalance && parseFloat(reserve.currentATokenBalance) > 0) {
      const collateralAmount = parseFloat(reserve.currentATokenBalance) / Math.pow(10, decimals);
      const collateralValueUSD = collateralAmount * priceUSD;
      const liqThreshold = parseFloat(reserve.reserve.liquidationThreshold || '0') / 10000;
      
      if (reserve.reserve.usageAsCollateralEnabled && liqThreshold > 0) {
        totalCollateralUSD += collateralValueUSD * liqThreshold;
      }
    }

    // Debt
    if (reserve.currentTotalDebt && parseFloat(reserve.currentTotalDebt) > 0) {
      const debtAmount = parseFloat(reserve.currentTotalDebt) / Math.pow(10, decimals);
      totalDebtUSD += debtAmount * priceUSD;
    }
  }

  if (totalDebtUSD === 0) return Infinity;
  return totalCollateralUSD / totalDebtUSD;
}

async function checkSeamlessOpportunities() {
  try {
    console.log(`\n🔍 Checking Seamless Protocol on Base...\n`);

    const response = await fetch(SEAMLESS_SUBGRAPH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          first: 1000,
          healthFactorMax: '1.5',
        },
      }),
    });

    const result = await response.json();

    if (result.errors) {
      console.error('❌ GraphQL errors:', JSON.stringify(result.errors, null, 2));
      return;
    }

    const users = result.data?.users || [];
    console.log(`📊 Total users with borrows: ${users.length}\n`);

    let liquidatable = 0;
    let nearLiquidation = 0;
    let risky = 0;
    let healthy = 0;

    const liquidatableDetails = [];
    const nearDetails = [];

    for (const user of users) {
      if (!user.reserves || user.reserves.length === 0) continue;

      const hf = calculateHealthFactor(user.reserves);
      
      if (!isFinite(hf)) continue;

      // Calculate total borrowed USD
      let totalBorrowedUSD = 0;
      let totalCollateralUSD = 0;
      
      for (const reserve of user.reserves) {
        const decimals = parseInt(reserve.reserve.decimals);
        const priceInEth = parseFloat(reserve.reserve.price?.priceInEth || '0');
        const priceUSD = priceInEth * 3900; // Assume ETH at $3900

        if (reserve.currentTotalDebt) {
          const debtAmount = parseFloat(reserve.currentTotalDebt) / Math.pow(10, decimals);
          totalBorrowedUSD += debtAmount * priceUSD;
        }
        
        if (reserve.currentATokenBalance) {
          const collAmount = parseFloat(reserve.currentATokenBalance) / Math.pow(10, decimals);
          totalCollateralUSD += collAmount * priceUSD;
        }
      }

      const positionInfo = {
        address: user.id,
        hf: hf.toFixed(6),
        totalBorrowed: totalBorrowedUSD.toFixed(2),
        totalCollateral: totalCollateralUSD.toFixed(2),
        reserves: user.reserves.length,
      };

      if (hf < 1.0) {
        liquidatable++;
        liquidatableDetails.push(positionInfo);
      } else if (hf < 1.05) {
        nearLiquidation++;
        nearDetails.push(positionInfo);
      } else if (hf < 1.2) {
        risky++;
      } else {
        healthy++;
      }
    }

    // Show liquidatable positions
    if (liquidatableDetails.length > 0) {
      console.log(`🔴 LIQUIDATABLE POSITIONS (HF < 1.0): ${liquidatableDetails.length}\n`);
      liquidatableDetails.forEach((pos, idx) => {
        console.log(`${idx + 1}. ${pos.address}`);
        console.log(`   Health Factor: ${pos.hf}`);
        console.log(`   Total Borrowed: $${pos.totalBorrowed}`);
        console.log(`   Total Collateral: $${pos.totalCollateral}`);
        console.log(`   Number of reserves: ${pos.reserves}`);
        console.log('');
      });
    } else {
      console.log(`🔴 LIQUIDATABLE POSITIONS (HF < 1.0): 0\n`);
    }

    // Show near-liquidation positions (limit to 10)
    if (nearDetails.length > 0 && nearDetails.length <= 10) {
      console.log(`🟡 NEAR LIQUIDATION (1.0 ≤ HF < 1.05): ${nearDetails.length}\n`);
      nearDetails.forEach((pos, idx) => {
        console.log(`${idx + 1}. ${pos.address}`);
        console.log(`   Health Factor: ${pos.hf}`);
        console.log(`   Total Borrowed: $${pos.totalBorrowed}`);
        console.log('');
      });
    } else if (nearDetails.length > 0) {
      console.log(`🟡 NEAR LIQUIDATION (1.0 ≤ HF < 1.05): ${nearDetails.length}`);
      console.log(`   (Too many to display individually)\n`);
    }

    console.log(`\n📈 SUMMARY:`);
    console.log(`   🔴 Liquidatable (HF < 1.0): ${liquidatable}`);
    console.log(`   🟡 Near Liquidation (1.0 ≤ HF < 1.05): ${nearLiquidation}`);
    console.log(`   🟠 Risky (1.05 ≤ HF < 1.2): ${risky}`);
    console.log(`   🟢 Healthy (HF ≥ 1.2): ${healthy}`);
    console.log(`   📊 Total positions checked: ${liquidatable + nearLiquidation + risky + healthy}\n`);

    if (liquidatable === 0 && nearLiquidation === 0) {
      console.log(`✅ Market is healthy - no immediate opportunities`);
      console.log(`💡 This is normal for Seamless (newer protocol, less leverage)\n`);
    } else {
      console.log(`🎯 OPPORTUNITIES DETECTED!`);
      console.log(`💰 Potential liquidations available\n`);
    }
  } catch (error) {
    console.error('❌ Error fetching Seamless data:', error.message);
  }
}

checkSeamlessOpportunities();
