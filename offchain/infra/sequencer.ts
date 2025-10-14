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
  const { rpcUrl, feed, staleAfterSeconds = Number.POSITIVE_INFINITY, recoveryGraceSeconds } = params;
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

    // Chainlink sequencer feeds use answer=0 when the sequencer is live and answer=1 when down.
    const updated = Number(updatedAt);
    const safeUpdated = Number.isFinite(updated) && updated > 0 ? updated : undefined;

    if (answer === 1n) {
      return { ok: false, reason: 'status-down', updatedAt: safeUpdated };
    }

    if (answer !== 0n) {
      return { ok: false, reason: `unknown-answer ${answer}`, updatedAt: safeUpdated };
    }

    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(updated) || updated === 0) {
      return { ok: false, reason: 'updated-zero' };
    }

    const age = now - updated;

    if (Number.isFinite(staleAfterSeconds) && staleAfterSeconds > 0 && age > staleAfterSeconds) {
      return { ok: false, reason: `stale ${age}s`, updatedAt: updated };
    }

    const envGraceRaw = process.env.SEQUENCER_GRACE_SECS;
    const envGrace = envGraceRaw ? Number(envGraceRaw) : NaN;
    const graceSeconds = Number.isFinite(envGrace) ? envGrace : recoveryGraceSeconds ?? 120;

    if (age < graceSeconds) {
      return { ok: false, reason: `grace ${age}s`, updatedAt: updated };
    }

    return { ok: true, updatedAt: updated };
  } catch (err) {
    console.warn(`sequencer-feed-read-failed`, { err: (err as Error).message, feed, rpcUrl });
    return { ok: false, reason: 'feed-read-failed' };
  }
}
