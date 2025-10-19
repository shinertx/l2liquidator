import { Address, BaseError, ContractFunctionRevertedError, Hex, createPublicClient, http } from 'viem';
import { arbitrum, optimism, base, polygon } from 'viem/chains';
import { wallet } from './mev_protect';
import type { BundlerCall } from './preliq_executor';
import { instrument, metricTargetFromRpc } from '../infra/instrument';
import { withNonceLock } from '../infra/nonce_lock';

const BUNDLER_ABI = [
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'to', type: 'address' },
          { name: 'data', type: 'bytes' },
          { name: 'value', type: 'uint256' },
          { name: 'skipRevert', type: 'bool' },
          { name: 'callbackHash', type: 'bytes32' },
        ],
      },
    ],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
] as const;

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

export async function sendPreLiqBundle(
  chainId: number,
  publicRpc: string,
  pk: `0x${string}`,
  bundler: Address,
  bundle: BundlerCall[],
  privateRpc?: string,
): Promise<Hex> {
  const writeRpc = privateRpc ?? publicRpc;
  const w = wallet(writeRpc, pk, privateRpc);
  const pub = createPublicClient({ transport: http(publicRpc) });

  const publicTarget = metricTargetFromRpc(publicRpc, 'public');
  const writeTarget = metricTargetFromRpc(writeRpc, privateRpc ? 'private' : 'public');

  const gas = await instrument('rpc', 'estimateContractGas', async () => {
    try {
      return await pub.estimateContractGas({
        account: w.account,
        address: bundler,
        abi: BUNDLER_ABI,
        functionName: 'multicall',
        args: [bundle],
      });
    } catch (err) {
      if (isHealthFactorError(err)) {
        throw new Error(HEALTH_FACTOR_ERROR);
      }
      throw err;
    }
  }, { target: publicTarget });

  const accountAddress = w.account.address.toLowerCase();

  return withNonceLock(chainId, accountAddress, async () => {
    const nonce = await instrument('rpc', 'getTransactionCount', async () => {
      return await pub.getTransactionCount({
        address: w.account.address,
        blockTag: 'pending',
      });
    }, { target: publicTarget });

    const txHash = await instrument('rpc', 'writeContract', async () => {
      try {
        const chain = CHAINS[chainId];
        if (!chain) throw new Error(`Unsupported chainId for sender: ${chainId}`);
        return await w.writeContract({
          chain,
          account: w.account,
          address: bundler,
          abi: BUNDLER_ABI,
          functionName: 'multicall',
          args: [bundle],
          gas,
          nonce,
        });
      } catch (err) {
        if (isHealthFactorError(err)) {
          throw new Error(HEALTH_FACTOR_ERROR);
        }
        throw err;
      }
    }, { target: writeTarget });

    await instrument('rpc', 'waitForTransactionReceipt', async () => {
      return await pub.waitForTransactionReceipt({
        hash: txHash,
        pollingInterval: 1000,
        timeout: 120_000,
      });
    }, { target: publicTarget });

    return txHash;
  });
}
