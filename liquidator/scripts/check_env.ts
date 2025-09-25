import { config as loadEnv } from 'dotenv';
import path from 'path';
import { createPublicClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

loadEnv();
loadEnv({ path: path.resolve(__dirname, '../../.env') });

function expand(value: string | undefined) {
  if (!value) return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
}

const configs = [
  {
    label: 'Arbitrum',
    rpc: expand(process.env.RPC_ARB),
    pk: process.env.WALLET_PK_ARB,
    expectedChainId: Number(process.env.CHAIN_ID_ARB ?? 42161),
  },
  {
    label: 'Optimism',
    rpc: expand(process.env.RPC_OP),
    pk: process.env.WALLET_PK_OP,
    expectedChainId: Number(process.env.CHAIN_ID_OP ?? 10),
  },
];

async function main() {
  for (const cfg of configs) {
    if (!cfg.rpc) {
      console.warn(`[${cfg.label}] missing RPC URL`);
      continue;
    }
    if (!cfg.pk) {
      console.warn(`[${cfg.label}] missing private key`);
      continue;
    }

    const account = privateKeyToAccount(cfg.pk as `0x${string}`);
    const client = createPublicClient({ transport: http(cfg.rpc) });

    try {
      const chainId = await client.getChainId();
      const balance = await client.getBalance({ address: account.address });
      const match = cfg.expectedChainId ? chainId === cfg.expectedChainId : true;
      const status = match ? 'ok' : `chain-mismatch (expected ${cfg.expectedChainId}, got ${chainId})`;

      console.log(`\n[${cfg.label}] ${status}`);
      console.log(`  address: ${account.address}`);
      console.log(`  balance: ${formatEther(balance)} native`);
    } catch (err) {
      console.error(`\n[${cfg.label}] failed:`, (err as Error).message);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
