import { Address, createPublicClient, http } from 'viem';
import { wallet } from './mev_protect';
import { encodePlan } from './build_tx';
import LiquidatorAbi from './Liquidator.abi.json';

export async function sendLiquidation(
  chainRpc: string,
  pk: `0x${string}`,
  contract: Address,
  planArgs: Parameters<typeof encodePlan>[0]
) {
  const w = wallet(chainRpc, pk);
  const pub = createPublicClient({ transport: http(chainRpc) });

  const data = {
    abi: LiquidatorAbi,
    address: contract,
    ...encodePlan(planArgs),
  } as const;

  // Estimate then send
  const gas = await pub.estimateContractGas({ account: w.account, ...data });
  const hash = await w.writeContract({ ...data, gas, chain: undefined });
  return hash;
}
