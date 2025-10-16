import { createPublicClient, getAddress, http } from 'viem';
import { loadConfig, liquidatorForChain } from '../infra/config';

const ALLOWED_ROUTERS_ABI = [
  {
    type: 'function',
    name: 'allowedRouters',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

type RouterResult = {
  chainId: number;
  chainName: string;
  routerName: string;
  routerAddress: `0x${string}`;
  allowed: boolean | 'error';
  error?: string;
};

function extractRouters(entry: Record<string, unknown> | undefined): Array<[string, `0x${string}`]> {
  if (!entry) return [];
  const pairs: Array<[string, `0x${string}`]> = [];
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'tokens' || key.endsWith('Factory')) continue;
    if (typeof value === 'string' && value.startsWith('0x') && value.length === 42) {
      try {
        pairs.push([key, getAddress(value)]);
      } catch (err) {
        throw new Error(`invalid address for router "${key}": ${value} (${(err as Error).message})`);
      }
    }
  }
  return pairs;
}

async function checkRouters(): Promise<RouterResult[]> {
  const cfg = loadConfig();
  const entries = cfg.dexRouters ?? {};
  const results: RouterResult[] = [];

  for (const chain of cfg.chains) {
    if (!chain.enabled) continue;
    const chainRouters = (entries as Record<number | string, Record<string, unknown> | undefined>)[chain.id] ??
      (entries as Record<number | string, Record<string, unknown> | undefined>)[String(chain.id)];
    const routers = extractRouters(chainRouters);
    if (routers.length === 0) continue;

    const rpcUrl = chain.rpc;
    if (!rpcUrl || rpcUrl.includes('\u0000MISSING')) {
      throw new Error(`chain ${chain.id} (${chain.name}) is missing RPC env`);
    }

    const liquidator = liquidatorForChain(cfg, chain.id);
    if (!liquidator) {
      throw new Error(`no liquidator address configured for chain ${chain.id}`);
    }

    const client = createPublicClient({ transport: http(rpcUrl) });

    for (const [name, address] of routers) {
      try {
        const allowed = await client.readContract({
          address: liquidator,
          abi: ALLOWED_ROUTERS_ABI,
          functionName: 'allowedRouters',
          args: [address],
        });
        results.push({ chainId: chain.id, chainName: chain.name, routerName: name, routerAddress: address, allowed });
      } catch (error) {
        const err = error as Error;
        results.push({
          chainId: chain.id,
          chainName: chain.name,
          routerName: name,
          routerAddress: address,
          allowed: 'error',
          error: err.message,
        });
      }
    }
  }

  return results;
}

(async () => {
  try {
    const rows = await checkRouters();
    const byChain = rows.reduce<Record<number, RouterResult[]>>((acc, row) => {
      acc[row.chainId] = acc[row.chainId] ?? [];
      acc[row.chainId].push(row);
      return acc;
    }, {});

    for (const [chainIdStr, items] of Object.entries(byChain)) {
      const [{ chainName }] = items;
      console.log(`\nChain ${chainIdStr} (${chainName})`);
      for (const item of items) {
        if (item.allowed === 'error') {
          console.log(`  ${item.routerName.padEnd(12)} ${item.routerAddress} -> ERROR ${item.error}`);
        } else {
          console.log(`  ${item.routerName.padEnd(12)} ${item.routerAddress} -> ${item.allowed ? 'allowed' : 'BLOCKED'}`);
        }
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
})();
