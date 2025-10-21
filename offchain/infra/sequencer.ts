import { createPublicClient, http } from 'viem';
import { log } from './logger';

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

type SequencerCacheEntry = {
  value?: SequencerStatus;
  expires: number;
  pending?: Promise<SequencerStatus>;
};

const sequencerCache = new Map<string, SequencerCacheEntry>();

const SEQUENCER_SUCCESS_TTL_MS = 15_000;
const SEQUENCER_FAILURE_TTL_MS = 5_000;

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

  const key = `${rpcUrl}::${feed.toLowerCase()}`;
  const cached = sequencerCache.get(key);
  const nowMs = Date.now();
  if (cached && cached.expires > nowMs && !cached.pending && cached.value) {
    return cached.value;
  }
  if (cached?.pending) {
    return cached.pending;
  }

  let client = clients.get(rpcUrl);
  if (!client) {
    client = createPublicClient({ transport: http(rpcUrl) });
    clients.set(rpcUrl, client);
  }

  const pending = (async () => {
    try {
      const [, answer, , updatedAt] = await client!.readContract({
        address: feed,
        abi: SEQUENCER_FEED_ABI,
        functionName: 'latestRoundData',
      });

      // Chainlink sequencer feeds use answer=0 when the sequencer is live and answer=1 when down.
      const updated = Number(updatedAt);
      const safeUpdated = Number.isFinite(updated) && updated > 0 ? updated : undefined;

      if (answer === 1n) {
        return { ok: false, reason: 'status-down', updatedAt: safeUpdated } satisfies SequencerStatus;
      }

      if (answer !== 0n) {
        return { ok: false, reason: `unknown-answer ${answer}`, updatedAt: safeUpdated } satisfies SequencerStatus;
      }

      const now = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(updated) || updated === 0) {
        return { ok: false, reason: 'updated-zero' } satisfies SequencerStatus;
      }

      const age = now - updated;

      if (Number.isFinite(staleAfterSeconds) && staleAfterSeconds > 0 && age > staleAfterSeconds) {
        return { ok: false, reason: `stale ${age}s`, updatedAt: updated } satisfies SequencerStatus;
      }

      const envGraceRaw = process.env.SEQUENCER_GRACE_SECS;
      const envGrace = envGraceRaw ? Number(envGraceRaw) : NaN;
      const graceSeconds = Number.isFinite(envGrace) ? envGrace : recoveryGraceSeconds ?? 120;

      if (age < graceSeconds) {
        return { ok: false, reason: `grace ${age}s`, updatedAt: updated } satisfies SequencerStatus;
      }

      return { ok: true, updatedAt: updated } satisfies SequencerStatus;
    } catch (err) {
      log.warn({ err: (err as Error).message, feed, rpcUrl }, 'sequencer-feed-read-failed');
      return { ok: false, reason: 'feed-read-failed' } satisfies SequencerStatus;
    }
    })()
    .then((status) => {
      const ttlMs = status.ok ? SEQUENCER_SUCCESS_TTL_MS : SEQUENCER_FAILURE_TTL_MS;
      const existing = sequencerCache.get(key);
      const value =
        status.ok || !existing?.value
          ? status
          : existing.value;
      sequencerCache.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    });

  sequencerCache.set(key, { value: cached?.value, expires: cached?.expires ?? 0, pending });
  try {
    return await pending;
  } catch (err) {
    // Should be unreachable because pending handles errors, but fall back just in case.
  log.warn({ err: (err as Error).message, feed, rpcUrl }, 'sequencer-feed-read-failed');
    const fallback = { ok: false, reason: 'feed-read-failed' } as SequencerStatus;
    sequencerCache.set(key, { value: cached?.value ?? fallback, expires: Date.now() + SEQUENCER_FAILURE_TTL_MS });
    return cached?.value ?? fallback;
  }
}
