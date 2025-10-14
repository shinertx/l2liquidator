type FeedStats = {
  lastTimestampMs: number;
  emaIntervalMs: number;
  samples: number;
};

const statsByFeed = new Map<string, FeedStats>();

const alpha = Number(process.env.PRECOMMIT_EMA_ALPHA ?? 0.2);
const minSamples = Number(process.env.PRECOMMIT_MIN_SAMPLES ?? 4);
const ageFactor = Number(process.env.PRECOMMIT_AGE_FACTOR ?? 0.8);
const minGapBps = Number(process.env.PRECOMMIT_MIN_GAP_BPS ?? 200);
const hfMargin = Number(process.env.PRECOMMIT_HF_MARGIN ?? 0.03);

export function recordFeedUpdate(feed: string, updatedAtMs: number | bigint): void {
  if (!feed) return;
  const normalized = feed.toLowerCase();
  let timestampMs: number;
  if (typeof updatedAtMs === 'bigint') {
    timestampMs = Number(updatedAtMs) * 1000;
  } else {
    timestampMs = updatedAtMs;
  }
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    timestampMs = Date.now();
  }
  const prev = statsByFeed.get(normalized);
  if (!prev) {
    statsByFeed.set(normalized, {
      lastTimestampMs: timestampMs,
      emaIntervalMs: 0,
      samples: 0,
    });
    return;
  }
  const interval = timestampMs - prev.lastTimestampMs;
  const positiveInterval = interval > 0 ? interval : 0;
  const ema = prev.emaIntervalMs === 0
    ? positiveInterval
    : (alpha * positiveInterval) + ((1 - alpha) * prev.emaIntervalMs);
  statsByFeed.set(normalized, {
    lastTimestampMs: timestampMs,
    emaIntervalMs: ema,
    samples: Math.min(prev.samples + 1, 256),
  });
}

export function shouldPrecommit(params: {
  debtFeed?: string;
  gapBps: number;
  healthFactor: number;
  hfMax: number;
}): boolean {
  const { debtFeed, gapBps, healthFactor, hfMax } = params;
  if (!debtFeed) return false;
  if (gapBps < minGapBps) return false;
  const normalized = debtFeed.toLowerCase();
  const feedStats = statsByFeed.get(normalized);
  if (!feedStats || feedStats.samples < minSamples) return false;
  if (feedStats.emaIntervalMs <= 0) return false;
  const age = Date.now() - feedStats.lastTimestampMs;
  if (age <= 0) return false;
  if (age < feedStats.emaIntervalMs * ageFactor) return false;
  if (healthFactor < hfMax) return false;
  if (healthFactor > hfMax + hfMargin) return false;
  return true;
}

export function getFeedStats(feed: string): FeedStats | undefined {
  return statsByFeed.get(feed.toLowerCase());
}
