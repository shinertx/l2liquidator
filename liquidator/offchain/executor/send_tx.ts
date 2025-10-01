import { Address, BaseError, ContractFunctionRevertedError, createPublicClient, http } from 'viem';
import { arbitrum, optimism, base, polygon } from 'viem/chains';
import { wallet } from './mev_protect';
import { encodePlan } from './build_tx';
import LiquidatorAbi from './Liquidator.abi.json';
import { instrument } from '../infra/instrument';

const HEALTH_FACTOR_ERROR = 'HealthFactorNotBelowThreshold';
const HEALTH_FACTOR_SELECTOR = '0x930bb771';

const CHAINS: Record<number, any> = { 42161: arbitrum, 10: optimism, 8453: base, 137: polygon };

function isHealthFactorError(err: unknown): boolean {
  if (err instanceof BaseError) {
    const revert = err.walk((error) => error instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const errorName = revert.data?.errorName ?? (revert as any).errorName;
      if (errorName === HEALTH_FACTOR_ERROR) {
        return true;
      }

      const signature =
        (revert.data as any)?.errorSignature ??
        (revert.data as any)?.signature ??
        (revert as any).signature;
      if (signature === HEALTH_FACTOR_SELECTOR) {
        return true;
      }

      const raw = (revert.data as any)?.data ?? (revert as any).data;
      if (typeof raw === 'string' && raw.startsWith(HEALTH_FACTOR_SELECTOR)) {
        return true;
      }
    }
  }
  return false;
}

export async function sendLiquidation(
  chainId: number,
  chainRpc: string,
  pk: `0x${string}`,
  contract: Address,
  planArgs: Parameters<typeof encodePlan>[0],
  privateRpc?: string,
) {
  const writeRpc = privateRpc ?? chainRpc;
  const w = wallet(writeRpc, pk);
  const pub = createPublicClient({ transport: http(chainRpc) });

  const data = {
    abi: LiquidatorAbi,
    address: contract,
    ...encodePlan(planArgs),
  } as const;

  // Estimate then send
  const gas = await instrument('rpc', 'estimateContractGas', async () => {
    try {
      return await pub.estimateContractGas({ account: w.account, ...data });
    } catch (err) {
      if (isHealthFactorError(err)) {
        throw new Error(HEALTH_FACTOR_ERROR);
      }
      throw err;
    }
  });

  return instrument('rpc', 'writeContract', async () => {
    try {
      const chain = CHAINS[chainId];
      if (!chain) throw new Error(`Unsupported chainId for sender: ${chainId}`);
      return await w.writeContract({ ...data, gas, chain });
    } catch (err) {
      if (isHealthFactorError(err)) {
        throw new Error(HEALTH_FACTOR_ERROR);
      }
      throw err;
    }
  });
}
