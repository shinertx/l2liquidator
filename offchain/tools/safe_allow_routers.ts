import '../infra/env';
import { Address, createPublicClient, encodeFunctionData, getAddress, http } from 'viem';
import { loadConfig, type AppConfig, type ChainCfg } from '../infra/config';
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

type SafeTx = {
  to: Address;
  value: string; // decimal string
  data: `0x${string}`;
  operation: 0 | 1; // 0=CALL, 1=DELEGATECALL
  description: string;
  meta?: Record<string, unknown>;
};

function addIfValid(out: Set<string>, val: unknown) {
  if (typeof val !== 'string') return;
  if (!val.startsWith('0x') || val.length !== 42) return;
  try {
    const chk = getAddress(val as Address);
    out.add(chk);
  } catch {}
}

function routersForChain(cfg: AppConfig, chain: ChainCfg): Address[] {
  const routers = new Set<string>();
  const dex = cfg.dexRouters?.[chain.id];
  if (dex) {
    for (const k of ['uniV3', 'camelotV2', 'velodrome', 'aerodrome']) {
      addIfValid(routers, (dex as any)[k]);
    }
  }
  addIfValid(routers, chain.uniV3Router);
  return Array.from(routers) as Address[];
}

async function main() {
  const cfg = loadConfig();
  const which = process.argv[2]?.toLowerCase();
  const chains = cfg.chains.filter((c) => c.enabled && (!which || c.name.toLowerCase() === which || String(c.id) === which));
  if (chains.length === 0) {
    console.error('Usage: node safe_allow_routers.js <chainName|chainId>. Enabled chains found:', cfg.chains.filter(c=>c.enabled).map(c=>`${c.name}(${c.id})`).join(', '));
    process.exit(1);
  }

  const payloads: Record<string, SafeTx[]> = {};

  for (const chain of chains) {
    const liq = cfg.contracts?.liquidator?.[chain.id];
    if (!liq) {
      log.warn({ chainId: chain.id }, 'safe-allow-skip-no-contract');
      continue;
    }
    const client = createPublicClient({ transport: http(chain.rpc) });
    const routers = routersForChain(cfg, chain);
    const txs: SafeTx[] = [];
    for (const router of routers) {
      try {
        const allowed = await client.readContract({ address: liq, abi: ROUTER_ADMIN_ABI, functionName: 'allowedRouters', args: [router] });
        if (allowed) continue;
      } catch (err) {
        log.warn({ chain: chain.id, router, err: (err as Error).message }, 'safe-allow-check-failed');
        continue;
      }
      const data = encodeFunctionData({
        abi: ROUTER_ADMIN_ABI,
        functionName: 'setRouterAllowed',
        args: [router, true],
      });
      txs.push({
        to: liq as Address,
        value: '0',
        data,
        operation: 0,
        description: `Allow router ${router} on ${chain.name}`,
        meta: { chainId: chain.id, chainName: chain.name, router },
      });
    }
    payloads[`${chain.name}(${chain.id})`] = txs;
  }

  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), payloads }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
