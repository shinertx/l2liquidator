import '../infra/env';
import { createPublicClient, http } from 'viem';
import { loadConfig, chainById } from '../infra/config';
import { getPoolFromProvider } from '../infra/aave_provider';

const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

const POOL_ABI = [
  { type: 'function', name: 'getReservesList', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
] as const;

async function main() {
  const cfg = loadConfig();
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    const poolAddr = await getPoolFromProvider(chain.rpc, chain.aaveProvider);
    const client = createPublicClient({ transport: http(chain.rpc) });
    const reserves = await client.readContract({ address: poolAddr, abi: POOL_ABI, functionName: 'getReservesList' }) as `0x${string}`[];
    console.log(`\nChain ${chain.id} (${chain.name}) pool ${poolAddr}`);
    for (const asset of reserves) {
      try {
        const symbol = await client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'symbol' });
        const decimals = await client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'decimals' });
        console.log(`  ${asset} -> ${symbol} (${decimals})`);
      } catch (err) {
        console.log(`  ${asset} -> failed (${(err as Error).message})`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});