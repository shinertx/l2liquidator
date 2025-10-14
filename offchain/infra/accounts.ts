import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { ChainCfg } from './config';

const executorCache = new Map<string, Address>();

export function privateKeyForChain(chain: ChainCfg): `0x${string}` | undefined {
  // Prefer the new, dynamic format
  const key = `WALLET_PK_${chain.name.toUpperCase()}`;
  const pk = process.env[key] as `0x${string}` | undefined;
  if (pk) return pk;

  // Fallback for existing aliases from the .env structure
  switch (chain.name.toLowerCase()) {
    case 'arbitrum':
      return process.env.WALLET_PK_ARB as `0x${string}` | undefined;
    case 'optimism':
    case 'op':
      return process.env.WALLET_PK_OP as `0x${string}` | undefined;
    case 'base':
      return process.env.WALLET_PK_BASE as `0x${string}` | undefined;
    case 'polygon':
      return process.env.WALLET_PK_POLYGON as `0x${string}` | undefined;
    default:
      return undefined;
  }
}

export function executorAddressForChain(chain: ChainCfg): Address | undefined {
  const pk = privateKeyForChain(chain);
  if (!pk) return undefined;

  const cached = executorCache.get(pk);
  if (cached) return cached;

  const address = privateKeyToAccount(pk).address;
  executorCache.set(pk, address);
  return address;
}
