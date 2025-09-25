import type { Address, Chain, PublicClient, Transport } from 'viem';
import { createPublicClient, http } from 'viem';

const FEED_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { type: 'uint80', name: 'roundId' },
      { type: 'int256', name: 'answer' },
      { type: 'uint256', name: 'startedAt' },
      { type: 'uint256', name: 'updatedAt' },
      { type: 'uint80', name: 'answeredInRound' },
    ],
  },
] as const;

type RpcClient = PublicClient<Transport, Chain | undefined, any>;

async function readFeedUsd(client: RpcClient, feed?: Address, maxStalenessMs = 15_000): Promise<number | undefined> {
  if (!feed) return undefined;
  try {
    const decimals = (await client.readContract({ address: feed, abi: FEED_ABI, functionName: 'decimals' })) as number;
    const result = (await client.readContract({ address: feed, abi: FEED_ABI, functionName: 'latestRoundData' })) as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    const answer = result[1];
    const updatedAt = result[3];
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (answer <= 0n || updatedAt === 0n || now - updatedAt > BigInt(Math.floor(maxStalenessMs / 1000))) return undefined;
    return Number(answer) / 10 ** decimals;
  } catch {
    return undefined;
  }
}

export async function estimateGasUsd(
  client: RpcClient,
  chain: { id: number; name: string; rpc: string; tokens: Record<string, { chainlinkFeed?: Address }> },
  gasUnitsHint: bigint = 550_000n
): Promise<number> {
  let weiPerGas: bigint;
  try {
    const fees = await client.estimateFeesPerGas();
    const maxFeePerGas = (fees as any).maxFeePerGas as bigint | undefined;
    const gasPrice = (fees as any).gasPrice as bigint | undefined;
    if (maxFeePerGas && maxFeePerGas > 0n) {
      weiPerGas = maxFeePerGas;
    } else if (gasPrice && gasPrice > 0n) {
      weiPerGas = gasPrice;
    } else {
      weiPerGas = await client.getGasPrice();
    }
  } catch {
    weiPerGas = await client.getGasPrice();
  }

  const wethFeed = chain.tokens?.WETH?.chainlinkFeed as Address | undefined;
  const nativeUsd = await readFeedUsd(client, wethFeed);

  const gasEth = Number(weiPerGas) / 1e18 * Number(gasUnitsHint);
  if (nativeUsd && nativeUsd > 0) {
    return gasEth * nativeUsd;
  }

  return Math.max(0.2, gasEth * 2000);
}
