import '../infra/env';
import { getAddress } from 'viem';
import { loadConfig } from '../infra/config';
import { getPoolFromProvider } from '../infra/aave_provider';
import { getPublicClient } from '../infra/rpc_clients';

const POOL_ABI = [
  { type: 'function', name: 'getReservesList', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
] as const;

const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

const PROVIDER_ABI = [
  { type: 'function', name: 'getPriceOracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const ORACLE_ABI = [
  { type: 'function', name: 'getSourceOfAsset', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'address' }] },
] as const;

async function main() {
  const cfg = loadConfig();
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
  const pool = await getPoolFromProvider(chain);
  const client = getPublicClient(chain);
    const registry = await client.readContract({ address: getAddress(chain.aaveProvider), abi: PROVIDER_ABI, functionName: 'getPriceOracle' });
    console.log(`\nChain ${chain.id} oracle ${registry}`);
    const reserves = await client.readContract({ address: pool, abi: POOL_ABI, functionName: 'getReservesList' }) as `0x${string}`[];
    for (const asset of reserves) {
      try {
        const [symbol, decimals, source] = await Promise.all([
          client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'symbol' }) as Promise<string>,
          client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
          client.readContract({ address: registry as `0x${string}`, abi: ORACLE_ABI, functionName: 'getSourceOfAsset', args: [asset] }) as Promise<string>,
        ]);
        console.log(`  ${symbol.padEnd(7)} ${asset} decimals=${decimals} feed=${source}`);
      } catch (err) {
        console.log(`  ${asset} failed: ${(err as Error).message}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});