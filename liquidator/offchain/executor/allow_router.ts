import { Address, createPublicClient, getAddress, http } from 'viem';
import { wallet } from './mev_protect';
import { AppConfig, ChainCfg } from '../infra/config';
import { buildRouteOptions } from '../util/routes';
import { log } from '../infra/logger';

const ROUTER_ADMIN_ABI = [
  {
    type: 'function',
    name: 'allowedRouters',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'setRouterAllowed',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'router', type: 'address' },
      { name: 'allowed', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

type Params = {
  cfg: AppConfig;
  chain: ChainCfg;
  contract: Address;
  pk: `0x${string}`;
};

function collectRouters(cfg: AppConfig, chain: ChainCfg): Address[] {
  const routers = new Set<string>();

  const addIfValid = (val: unknown) => {
    if (typeof val !== 'string') return;
    if (!val.startsWith('0x') || val.length !== 42) return;
    try {
      const chk = getAddress(val as Address);
      routers.add(chk);
    } catch {
      // skip invalid checksum/address
    }
  };

  for (const market of cfg.markets) {
    if (!market.enabled || market.chainId !== chain.id) continue;
    const { options } = buildRouteOptions(cfg, chain, market.debtAsset, market.collateralAsset);
    for (const option of options) {
      addIfValid(option.router);
    }
  }

  const dex = cfg.dexRouters?.[chain.id];
  // Only include known router address fields; ignore tokens/factories/etc.
  if (dex) {
    const knownRouterKeys = ['uniV3', 'camelotV2', 'velodrome', 'aerodrome'] as const;
    for (const k of knownRouterKeys) {
      const v = (dex as any)[k];
      addIfValid(v);
    }
  }

  addIfValid(chain.uniV3Router);

  return Array.from(routers) as Address[];
}

export async function ensureRoutersAllowed({ cfg, chain, contract, pk }: Params): Promise<void> {
  if (!chain.enabled) return;
  const routers = collectRouters(cfg, chain);
  if (!routers.length) return;

  const client = createPublicClient({ transport: http(chain.rpc) });
  const ownerWallet = wallet(chain.rpc, pk);
  let nextNonce = await client.getTransactionCount({
    address: ownerWallet.account.address,
    blockTag: 'pending',
  });

  for (const router of routers) {
    try {
      const allowed = await client.readContract({
        abi: ROUTER_ADMIN_ABI,
        address: contract,
        functionName: 'allowedRouters',
        args: [router],
      });
      if (allowed) continue;
    } catch (err) {
      log.warn({ chain: chain.id, router, err: (err as Error).message }, 'router-allow-check-failed');
      continue;
    }

    try {
      log.info({ chain: chain.id, router }, 'router-allow-start');
      const hash = await ownerWallet.writeContract({
        abi: ROUTER_ADMIN_ABI,
        address: contract,
        functionName: 'setRouterAllowed',
        args: [router, true],
        chain: undefined,
        nonce: nextNonce,
      });
      nextNonce += 1;
      await client.waitForTransactionReceipt({ hash });
      log.info({ chain: chain.id, router, hash }, 'router-allow-ok');
    } catch (err) {
      log.error({ chain: chain.id, router, err: (err as Error).message }, 'router-allow-failed');
      nextNonce = await client.getTransactionCount({
        address: ownerWallet.account.address,
        blockTag: 'pending',
      });
    }
  }
}
