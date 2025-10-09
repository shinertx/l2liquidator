#!/usr/bin/env ts-node
import '../infra/env';
import { createPublicClient, http } from 'viem';
import { loadConfig, chainById } from '../infra/config';
import { executorAddressForChain } from '../infra/accounts';
import LiquidatorAbi from '../executor/Liquidator.abi.json';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: ts-node inspect_liquidator.ts <chainName|chainId>');
    process.exit(1);
  }
  const cfg = loadConfig();
  const chain = (() => {
    const asNum = Number(arg);
    if (Number.isFinite(asNum)) return chainById(cfg, asNum);
    return cfg.chains.find((c) => c.name.toLowerCase() === arg.toLowerCase());
  })();
  if (!chain) throw new Error('Unknown chain ' + arg);

  const contract = cfg.contracts?.liquidator?.[chain.id];
  if (!contract) throw new Error('No liquidator address for chain ' + chain.id);
  const client = createPublicClient({ transport: http(chain.rpc) });
  const bot = executorAddressForChain(chain);
  if (!bot) throw new Error('No executor key configured for ' + chain.name);

  const uniV3 = chain.uniV3Router as `0x${string}`;

  const owner = await client.readContract({ address: contract as `0x${string}`, abi: LiquidatorAbi as any, functionName: 'owner', args: [] });
  const isExec = await client.readContract({ address: contract as `0x${string}`, abi: LiquidatorAbi as any, functionName: 'executors', args: [bot] });
  const routerAllowed = await client.readContract({ address: contract as `0x${string}`, abi: LiquidatorAbi as any, functionName: 'allowedRouters', args: [uniV3] });

  console.log(JSON.stringify({ chain: chain.name, contract, owner, bot, isExec, uniV3, routerAllowed }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
