import type { Chain, PublicClient, Transport } from 'viem';
import type { TokenInfo } from '../infra/config';
import { log } from '../infra/logger';

type RpcClient = PublicClient<Transport, Chain | undefined, any>;

const FEED_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

const LEGACY_FEED_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'latestAnswer',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'int256' }],
  },
  {
    type: 'function',
    name: 'latestTimestamp',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export type OracleObservation = {
  priceUsd?: number;
  updatedAt?: number;
  stale: boolean;
  error?: string;
};

export async function fetchOraclePriceUsd(client: RpcClient, token: TokenInfo): Promise<OracleObservation> {
  if (!token.chainlinkFeed) {
    return { stale: true, error: 'missing-feed' };
  }
  try {
    const decimals = (await client.readContract({
      address: token.chainlinkFeed,
      abi: FEED_ABI,
      functionName: 'decimals',
      args: [],
    })) as number;
    try {
      const [, answer, , updatedAt, answeredInRound] = (await client.readContract({
        address: token.chainlinkFeed,
        abi: FEED_ABI,
        functionName: 'latestRoundData',
        args: [],
      })) as [bigint, bigint, bigint, bigint, bigint];
      const stale =
        answer <= 0n ||
        updatedAt === 0n ||
        answeredInRound === 0n ||
        answeredInRound < 0n ||
        Number(updatedAt) === 0;
      const priceUsd = stale ? undefined : Number(answer) / 10 ** decimals;
      return { priceUsd, updatedAt: Number(updatedAt), stale };
    } catch (roundDataErr) {
      const answer = (await client.readContract({
        address: token.chainlinkFeed,
        abi: LEGACY_FEED_ABI,
        functionName: 'latestAnswer',
        args: [],
      })) as bigint;
      const updatedAt = (await client.readContract({
        address: token.chainlinkFeed,
        abi: LEGACY_FEED_ABI,
        functionName: 'latestTimestamp',
        args: [],
      })) as bigint;
      const stale = answer <= 0n || updatedAt === 0n;
      const priceUsd = stale ? undefined : Number(answer) / 10 ** decimals;
      return {
        priceUsd,
        updatedAt: Number(updatedAt),
        stale,
        error: roundDataErr instanceof Error ? roundDataErr.message : String(roundDataErr),
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ feed: token.chainlinkFeed, err: message }, 'fabric-oracle-read-failed');
    return { stale: true, error: message };
  }
}
