#!/usr/bin/env ts-node
/**
 * Quick test to verify ETH-denominated oracle feeds now convert to USD
 */
import { createPublicClient, http } from 'viem';
import { loadConfig, chainById } from './offchain/infra/config';
import { oraclePriceUsd, oraclePriceDetails } from './offchain/indexer/price_watcher';

async function main() {
  const cfg = loadConfig();
  
  // Test rsETH on Arbitrum (ETH-denominated feed)
  const arbChain = chainById(cfg, 42161)!;
  const rsETH = arbChain.tokens.rsETH;
  const weth = arbChain.tokens.WETH;
  
  console.log('\n=== Testing Oracle ETH→USD Conversion ===\n');
  
  const client = createPublicClient({
    transport: http(arbChain.rpc),
  });
  
  // Get WETH/USD price (baseline)
  console.log('1. Fetching WETH/USD price...');
  const wethPrice = await oraclePriceUsd(client, weth, arbChain);
  console.log(`   WETH/USD: $${wethPrice?.toFixed(2) ?? 'MISSING'}`);
  
  // Get rsETH details (should now return USD)
  console.log('\n2. Fetching rsETH price (ETH-denominated feed)...');
  const rsETHDetails = await oraclePriceDetails(client, rsETH);
  console.log(`   Raw feed answer: ${rsETHDetails.rawAnswer}`);
  console.log(`   Feed decimals: ${rsETHDetails.decimals}`);
  console.log(`   feedDenomination: ${rsETH.feedDenomination ?? 'usd'}`);
  
  const rsETHPrice = await oraclePriceUsd(client, rsETH, arbChain);
  console.log(`   rsETH/USD: $${rsETHPrice?.toFixed(2) ?? 'MISSING'}`);
  
  if (rsETHPrice && wethPrice) {
    const ratio = rsETHPrice / wethPrice;
    console.log(`   rsETH/ETH ratio: ${ratio.toFixed(4)}`);
    console.log(`   ✅ Conversion working! rsETH price is ${ratio > 1 ? 'higher' : 'lower'} than ETH`);
  } else {
    console.log(`   ❌ FAILED: Price is still missing!`);
  }
  
  // Test Base weETH
  console.log('\n3. Fetching Base weETH price (ETH-denominated feed)...');
  const baseChain = chainById(cfg, 8453)!;
  const weETH = baseChain.tokens.weETH;
  const baseClient = createPublicClient({
    transport: http(baseChain.rpc),
  });
  
  const weETHPrice = await oraclePriceUsd(baseClient, weETH, baseChain);
  console.log(`   weETH/USD: $${weETHPrice?.toFixed(2) ?? 'MISSING'}`);
  
  // Test Polygon wstETH
  console.log('\n4. Fetching Polygon wstETH price (ETH-denominated feed)...');
  const polyChain = chainById(cfg, 137)!;
  const wstETH = polyChain.tokens.wstETH;
  const polyClient = createPublicClient({
    transport: http(polyChain.rpc),
  });
  
  const wstETHPrice = await oraclePriceUsd(polyClient, wstETH, polyChain);
  console.log(`   wstETH/USD: $${wstETHPrice?.toFixed(2) ?? 'MISSING'}`);
  
  console.log('\n=== Test Complete ===\n');
}

main().catch(console.error);
