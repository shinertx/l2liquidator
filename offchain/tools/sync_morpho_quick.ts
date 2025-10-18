#!/usr/bin/env ts-node
/**
 * Quick-add missing Morpho Blue tokens to Base chain config
 * Extracts tokens from orchestrator logs and adds them to config.yaml
 * 
 * Usage: npm run sync:morpho:quick
 */

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

const CONFIG_PATH = path.resolve(__dirname, '../../config.yaml');

// Tokens extracted from orchestrator logs on Base (8453)
const MISSING_MORPHO_TOKENS_BASE = {
  // USD Stablecoins & Derivatives
  'jEUR': { address: '0x4154550f4Db74Dc38d1FE98e1F3F28ed6daD627d', decimals: 18 },
  'stEUR': { address: '0x004626A008B1aCdC4c74ab51644093b155e59A23', decimals: 18 },
  'EURA': { address: '0xA61BeB4A3d02decb01039e378237032B351125B4', decimals: 18 },
  'USDz': { address: '0x04D5ddf5f3a8939889F11E97f8c4BB48317F1938', decimals: 18 },
  'wUSDM': { address: '0x57F5E098CaD7A3D1Eed53991D4d66C45C9AF7812', decimals: 18 },
  'wUSD+': { address: '0xd95ca61CE9aAF2143E81Ef5462C0c2325172E028', decimals: 6 },
  'satUSD': { address: '0x70654AaD8B7734dc319d0C3608ec7B32e03FA162', decimals: 18 },
  'eUSD': { address: '0xCfA3Ef56d303AE4fAabA0592388F19d7C3399FB4', decimals: 18 },
  'USR': { address: '0x35E5dB674D8e93a03d814FA0ADa70731efe8a4b9', decimals: 18 },
  'mTBILL': { address: '0xDD629E5241CbC5919847783e6C96B2De4754e438', decimals: 18 },
  'verUSDC': { address: '0x59aaF835D34b1E3dF2170e4872B785f11E2a964b', decimals: 6 },
  'FUSDC': { address: '0x2c28AC6AA2F17e8DFa3E2561338c6357EAD53c32', decimals: 6 },
  
  // LSTs
  'msETH': { address: '0x7Ba6F01772924a82D9626c126347A28299E98c98', decimals: 18 },
  'wsuperOETHb': { address: '0x7FcD174E80f264448ebeE8c88a7C4476AAF58Ea6', decimals: 18 },
  'bsdETH': { address: '0xCb327b99fF831bF8223cCEd12B1338FF3aA322Ff', decimals: 18 },
  'rETH': { address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', decimals: 18 },
  
  // Governance & Memecoins
  'AERO': { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18 },
  'TOSHI': { address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', decimals: 18 },
  'DEGEN': { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', decimals: 18 },
  'KTA': { address: '0xc0634090F2Fe6c6d75e61Be2b949464aBB498973', decimals: 18 },
  'doginme': { address: '0x6921B130D297cc43754afba22e5EAc0FBf8Db75b', decimals: 18 },
  
  // Other
  'mBASIS': { address: '0x1C2757c1FeF1038428b5bEF062495ce94BBe92b2', decimals: 18 },
  'uSOL': { address: '0x9B8Df6E244526ab5F6e6400d331DB28C8fdDdb55', decimals: 18 },
  'wbCOIN': { address: '0xDEc933e2392AD908263e70A386fbF34e703Ffe8F', decimals: 18 },
  'sAMM-USDC/cUSDO': { address: '0x5feDe9d65714907381A76AA9bF949219dD1c5023', decimals: 18 },
  
  // Pendle PTs
  'PT-USR-24APR2025': { address: '0xec443e7E0e745348E500084892C89218B3ba4683', decimals: 18 },
  'PT-USR-25SEP2025': { address: '0xa6F0A4D18B6f6DdD408936e81b7b3A8BEFA18e77', decimals: 18 },
  'PT-LBTC-29MAY2025': { address: '0x5d746848005507DA0b1717C137A10C30AD9ee307', decimals: 8 },
  'PT-cUSDO-15JUL2025': { address: '0x1155d1731B495BF22f016e13cAfb6aFA53BD8a28', decimals: 18 },
  'LP-USR-24APR2025': { address: '0xE15578523937ed7F08E8F7a1Fa8a021E07025a08', decimals: 18 },
  'LP-USR-25SEP2025': { address: '0x715509Bde846104cF2cCeBF6fdF7eF1BB874Bc45', decimals: 18 },
  'WWFUSDC': { address: '0xfDF73F61146B9050FFe4b755364B9CAC670ea5b2', decimals: 6 },
};

// Policy classification
const STABLES = new Set(['JEUR', 'STEUR', 'EURA', 'USDZ', 'WUSDM', 'WUSD+', 'SATURSD', 'EUSD', 'USR', 'MTBILL', 'VERUSDC', 'FUSDC']);
const LSTS = new Set(['MSETH', 'WSUPEROETHB', 'BSDETH', 'RETH']);
const GOVERNANCE = new Set(['AERO']);
const MAJORS = new Set<string>([]);

const DEFAULT_POLICIES: Record<'stable' | 'lst' | 'major' | 'governance' | 'other', { floorBps: number; gapCapBps: number; slippageBps: number }> = {
  stable: { floorBps: 30, gapCapBps: 50, slippageBps: 50 },
  lst: { floorBps: 30, gapCapBps: 70, slippageBps: 30 },
  major: { floorBps: 30, gapCapBps: 60, slippageBps: 30 },
  governance: { floorBps: 40, gapCapBps: 90, slippageBps: 40 },
  other: { floorBps: 50, gapCapBps: 110, slippageBps: 60 },
};

function classifyToken(symbol: string): 'stable' | 'lst' | 'major' | 'governance' | 'other' {
  const upper = symbol.toUpperCase();
  if (STABLES.has(upper)) return 'stable';
  if (LSTS.has(upper)) return 'lst';
  if (MAJORS.has(upper)) return 'major';
  if (GOVERNANCE.has(upper)) return 'governance';
  return 'other';
}

async function main() {
  console.log('🚀 Quick Morpho Blue Token Sync for Base');
  console.log('==========================================\n');

  // Read config
  const configYaml = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = YAML.parse(configYaml) as any;

  // Find Base chain
  const baseChain = config.chains.find((c: any) => c.id === 8453);
  if (!baseChain) {
    console.error('❌ Base chain (8453) not found in config');
    process.exit(1);
  }

  let tokensAdded = 0;
  let policiesAdded = 0;

  // Add tokens to Base chain
  for (const [symbol, tokenData] of Object.entries(MISSING_MORPHO_TOKENS_BASE)) {
    const existing = baseChain.tokens[symbol];
    if (!existing) {
      baseChain.tokens[symbol] = {
        address: tokenData.address,
        decimals: tokenData.decimals,
      };
      tokensAdded++;
      
      // Add asset policy
      if (!config.assets[symbol]) {
        const category = classifyToken(symbol);
        const policy = DEFAULT_POLICIES[category];
        config.assets[symbol] = policy;
        policiesAdded++;
        console.log(`  ✅ ${symbol.padEnd(25)} ${tokenData.address} (${category})`);
      } else {
        console.log(`  ℹ️  ${symbol.padEnd(25)} ${tokenData.address} (policy exists)`);
      }
    } else {
      console.log(`  ⏭️  ${symbol.padEnd(25)} already in config`);
    }
  }

  // Write back to config
  const updatedYaml = YAML.stringify(config, { indent: 2, lineWidth: 0 });
  fs.writeFileSync(CONFIG_PATH, updatedYaml);

  console.log(`\n✅ Added ${tokensAdded} tokens and ${policiesAdded} policies to Base chain`);
  console.log('\n📋 Next Steps:');
  console.log('   1. Review config.yaml changes: git diff config.yaml');
  console.log('   2. Restart orchestrator: docker compose restart worker');
  console.log('   3. Monitor liquidations: docker logs -f l2liquidator-worker-1 | grep -E "liquidation|executed|profit"');
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
