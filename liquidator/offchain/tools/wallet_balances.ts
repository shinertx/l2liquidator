import '../infra/env';
import { createPublicClient, formatEther, http, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base, optimism, polygon } from 'viem/chains';

const CHAINS: Array<{
  id: number;
  name: string;
  rpcEnv: string;
  pkEnv: string;
  chain: Chain;
}> = [
  { id: 42161, name: 'arbitrum', rpcEnv: 'RPC_ARB', pkEnv: 'WALLET_PK_ARB', chain: arbitrum },
  { id: 10, name: 'optimism', rpcEnv: 'RPC_OP', pkEnv: 'WALLET_PK_OP', chain: optimism },
  { id: 8453, name: 'base', rpcEnv: 'RPC_BASE', pkEnv: 'WALLET_PK_BASE', chain: base },
  { id: 137, name: 'polygon', rpcEnv: 'RPC_POLYGON', pkEnv: 'WALLET_PK_POLYGON', chain: polygon },
];

async function main() {
  const results = [] as Array<{
    name: string;
    chainId: number;
    address: `0x${string}`;
    balance: string;
  }>;

  for (const { id, name, rpcEnv, pkEnv, chain } of CHAINS) {
    const rpc = process.env[rpcEnv];
    const pk = process.env[pkEnv];
    if (!rpc) {
      throw new Error(`Missing RPC endpoint for ${name} (${rpcEnv})`);
    }
    if (!pk) {
      throw new Error(`Missing private key for ${name} (${pkEnv})`);
    }
    const account = privateKeyToAccount(pk as `0x${string}`);
    const client = createPublicClient({ chain, transport: http(rpc) });
    const balance = await client.getBalance({ address: account.address });
    results.push({ name, chainId: id, address: account.address, balance: formatEther(balance) });
  }

  for (const entry of results) {
    console.log(JSON.stringify(entry));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
