import { HttpTransport, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export function wallet(chainRpc: string, pk: `0x${string}`, privateRpc?: string) {
  const account = privateKeyToAccount(pk);
  const transport = privateRpc ? http(privateRpc) : http(chainRpc);

  return createWalletClient({ chain: undefined as any, account, transport: transport as HttpTransport });
}
