import { Address, BaseError, getAddress, keccak256, stringToBytes } from 'viem';
import type { AppConfig, ChainCfg } from './config';
import { instrument, metricTargetFromRpc } from './instrument';
import { log } from './logger';
import { getPublicClient, getRealtimeClient, type ManagedClient } from './rpc_clients';

const PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getAddress',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const POOL_ID = keccak256(stringToBytes('POOL'));

export async function getPoolFromProvider(chain: ChainCfg): Promise<Address> {
  const target = metricTargetFromRpc(chain.rpc, 'provider');
  const provider = getAddress(chain.aaveProvider);
  const clients: Array<{ client: ManagedClient; transport: 'http' | 'ws' }> = [
    { client: getPublicClient(chain), transport: 'http' },
  ];

  try {
    const realtime = getRealtimeClient(chain);
    if (realtime.kind === 'ws') {
      clients.push({ client: realtime.client, transport: 'ws' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ chainId: chain.id, err: message }, 'aave-provider-realtime-client-unavailable');
  }

  return instrument(
    'rpc',
    'getPoolFromProvider',
    async () => {
      let lastError: Error | null = null;
      for (const { client, transport } of clients) {
        try {
          const pool = await client.readContract({ abi: PROVIDER_ABI, address: provider, functionName: 'getPool' });
          if (transport === 'ws') {
            log.info({ chainId: chain.id, provider: chain.aaveProvider, transport }, 'aave-provider-pool-ws-success');
          }
          return pool as Address;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          log.debug(
            { chainId: chain.id, provider: chain.aaveProvider, transport, err: lastError.message },
            'aave-provider-getPool-error',
          );
          try {
            const pool = await client.readContract({
              abi: PROVIDER_ABI,
              address: provider,
              functionName: 'getAddress',
              args: [POOL_ID],
            });
            log.warn({ chainId: chain.id, provider: chain.aaveProvider, transport }, 'aave-provider-pool-fallback');
            return pool as Address;
          } catch (fallbackErr) {
            lastError = fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
            log.debug(
              { chainId: chain.id, provider: chain.aaveProvider, transport, err: lastError.message },
              'aave-provider-pool-fallback-error',
            );
            // Continue to next transport if available.
          }
        }
      }
      throw lastError ?? new Error('failed to resolve Aave pool address');
    },
    { target },
  );
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
