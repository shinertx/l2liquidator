import { HttpTransport, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export function wallet(chainRpc: string, pk: `0x${string}`) {
  const account = privateKeyToAccount(pk);
  return createWalletClient({ chain: undefined as any, account, transport: http(chainRpc) as HttpTransport });
}
