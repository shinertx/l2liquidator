import { Address, createPublicClient, http } from 'viem';
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
  const routers = new Set<Address>();

  for (const market of cfg.markets) {
    if (!market.enabled || market.chainId !== chain.id) continue;
    const { options } = buildRouteOptions(cfg, chain, market.debtAsset, market.collateralAsset);
    for (const option of options) {
      routers.add(option.router);
    }
  }

  const dex = cfg.dexRouters?.[chain.id];
  const pushMaybe = (value: unknown) => {
    if (typeof value !== 'string') return;
    if (!value.startsWith('0x') || value.length !== 42) return;
    routers.add(value as Address);
  };

  if (dex) {
    for (const value of Object.values(dex)) {
      if (typeof value === 'object' && value !== null) {
        for (const nested of Object.values(value)) {
          pushMaybe(nested);
        }
      } else {
        pushMaybe(value);
      }
    }
  }

  pushMaybe(chain.uniV3Router);

  return Array.from(routers);
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
