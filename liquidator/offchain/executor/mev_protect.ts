import { HttpTransport, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Map chainId -> env var for private lane endpoint
function privateEnvForChain(chainId: number): string | undefined {
  switch (chainId) {
    case 1:
      return process.env.PRIVTX_ETH;
    case 42161:
      return process.env.PRIVTX_ARB;
    case 10:
      return process.env.PRIVTX_OP;
    case 8453:
      return process.env.PRIVTX_BASE;
    case 137:
      return process.env.PRIVTX_POLYGON;
    default:
      return undefined;
  }
}

export function isPrivateConfigured(chainId: number): boolean {
  const url = privateEnvForChain(chainId);
  return typeof url === 'string' && url.trim().length > 0;
}

export function resolveWriteRpc(chainId: number, defaultRpc: string): string {
  const priv = privateEnvForChain(chainId);
  if (priv && priv.trim().length > 0) return priv.trim();
  return defaultRpc;
}

export function wallet(chainId: number, defaultRpc: string, pk: `0x${string}`) {
  const account = privateKeyToAccount(pk);
  const rpc = resolveWriteRpc(chainId, defaultRpc);
  return createWalletClient({ chain: undefined as any, account, transport: http(rpc) as HttpTransport });
}

export function flashbotsStatusUrl(txHash: `0x${string}` | string, chainId: number): string | undefined {
  if (chainId !== 1 || !isPrivateConfigured(1)) return undefined;
  // Not all Protect txs show here immediately; still useful pointer.
  return `https://protect.flashbots.net/tx/${txHash}`;
}
