import { Address, createPublicClient, http, getAddress } from 'viem';
import type { AppConfig } from './config';
import { instrument } from './instrument';

const PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export async function getPoolFromProvider(rpc: string, provider: Address): Promise<Address> {
  return instrument('rpc', 'getPoolFromProvider', async () => {
    const client = createPublicClient({ transport: http(rpc) });
    const normalized = getAddress(provider);
    const pool = await client.readContract({ abi: PROVIDER_ABI, address: normalized, functionName: 'getPool' });
    return pool as Address;
  });
}

export async function logPoolsAtBoot(cfg: AppConfig): Promise<void> {
  for (const chain of cfg.chains) {
    if (!chain.enabled || !('aaveProvider' in chain) || !chain.aaveProvider) continue;
    try {
      const pool = await getPoolFromProvider(chain.rpc, chain.aaveProvider as Address);
      // eslint-disable-next-line no-console
      console.log('[aave] provider', { chainId: chain.id, provider: chain.aaveProvider, pool });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[aave] failed to resolve pool', { chainId: chain.id, provider: chain.aaveProvider, err: (err as Error).message });
    }
  }
}