import { createPublicClient, http } from 'viem';

const SEQUENCER_FEED_ABI = [
  {
    name: 'latestRoundData',
    type: 'function',
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

const clients = new Map<string, ReturnType<typeof createPublicClient>>();

export type SequencerStatus = {
  ok: boolean;
  reason?: string;
  updatedAt?: number;
};

export async function checkSequencerStatus(params: {
  rpcUrl: string;
  feed?: `0x${string}`;
  staleAfterSeconds?: number;
  recoveryGraceSeconds?: number;
}): Promise<SequencerStatus> {
  const { rpcUrl, feed, staleAfterSeconds = 120, recoveryGraceSeconds = 60 } = params;
  if (!feed) {
    return { ok: true };
  }

  let client = clients.get(rpcUrl);
  if (!client) {
    client = createPublicClient({ transport: http(rpcUrl) });
    clients.set(rpcUrl, client);
  }

  try {
    const [, answer, , updatedAt] = await client.readContract({
      address: feed,
      abi: SEQUENCER_FEED_ABI,
      functionName: 'latestRoundData',
    });

    const status = Number(answer);
    const updated = Number(updatedAt);
    const now = Math.floor(Date.now() / 1000);

    if (status !== 0) {
      return { ok: false, reason: `status ${status}`, updatedAt: updated };
    }

    const age = now - updated;
    if (age > staleAfterSeconds) {
      return { ok: false, reason: `stale ${age}s`, updatedAt: updated };
    }

    if (age < recoveryGraceSeconds) {
      return { ok: false, reason: `grace ${age}s`, updatedAt: updated };
    }

    return { ok: true, updatedAt: updated };
  } catch (err) {
    console.warn(`sequencer-feed-read-failed`, { err: (err as Error).message, feed, rpcUrl });
    return { ok: false, reason: 'feed-read-failed' };
  }
}
