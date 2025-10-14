import '../infra/env';
import { createPublicClient, getAddress, http } from 'viem';
import { loadConfig } from '../infra/config';

const PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getPriceOracle',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

const ORACLE_ABI = [
  {
    type: 'function',
    name: 'getSourceOfAsset',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'address' }],
  },
] as const;

async function main() {
  const cfg = loadConfig();
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    const client = createPublicClient({ transport: http(chain.rpc) });
    if (!chain.aaveProvider) {
      console.log(`Chain ${chain.id} missing aaveProvider`);
      continue;
    }
    try {
      const oracle = await client.readContract({
        address: getAddress(chain.aaveProvider),
        abi: PROVIDER_ABI,
        functionName: 'getPriceOracle',
      });
      console.log(`\nChain ${chain.id} (${chain.name}) oracle: ${oracle}`);
      for (const [symbol, token] of Object.entries(chain.tokens)) {
        try {
          const source = await client.readContract({
            address: getAddress(oracle as string),
            abi: ORACLE_ABI,
            functionName: 'getSourceOfAsset',
            args: [getAddress(token.address)],
          });
          console.log(`  ${symbol}: ${source}`);
        } catch (err) {
          console.log(`  ${symbol}: failed (${(err as Error).message})`);
        }
      }
    } catch (err) {
      console.log(`Failed to load oracle for chain ${chain.id}: ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});