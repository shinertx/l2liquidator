import { Address, getAddress } from 'viem';
import type { AppConfig, ChainCfg } from './config';
import { instrument, metricTargetFromRpc } from './instrument';
import { log } from './logger';
import { getPublicClient } from './rpc_clients';

const PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export async function getPoolFromProvider(chain: ChainCfg): Promise<Address> {
  const target = metricTargetFromRpc(chain.rpc, 'provider');
  const client = getPublicClient(chain);
  const provider = getAddress(chain.aaveProvider);
  return instrument('rpc', 'getPoolFromProvider', async () => {
    const pool = await client.readContract({ abi: PROVIDER_ABI, address: provider, functionName: 'getPool' });
    return pool as Address;
  }, { target });
}

export async function logPoolsAtBoot(cfg: AppConfig): Promise<void> {
  for (const chain of cfg.chains) {
    if (!chain.enabled || !('aaveProvider' in chain) || !chain.aaveProvider) continue;
    try {
  const pool = await getPoolFromProvider(chain);
      log.info({ chainId: chain.id, provider: chain.aaveProvider, pool }, 'aave-provider-pool');
    } catch (err) {
      log.warn({ chainId: chain.id, provider: chain.aaveProvider, err: (err as Error).message }, 'aave-provider-pool-failed');
    }
  }
}
