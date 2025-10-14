import '../infra/env';
import '../infra/metrics_server';
import { performance } from 'perf_hooks';

import { loadConfig } from '../infra/config';
import { db, waitForDb } from '../infra/db';
import { log } from '../infra/logger';
import { gauge } from '../infra/metrics';

type AttemptRow = {
  id: number;
  chain_id: number;
  borrower: string;
  status: string;
  reason?: string | null;
  details?: any;
  created_at: string;
};

type MetricsBucket = {
  chainId: number;
  chainName: string;
  assetKey: string;
  total: number;
  sent: number;
  gapSkip: number;
  policySkip: number;
  errors: number;
  opportunityCostUsd: number;
  hfDeltaSum: number;
  hfSamples: number;
  gapSum: number;
  gapSamples: number;
  lastUpdated: number;
  windowStart: number;
};

const RISK_ENGINE_URL = process.env.RISK_ENGINE_URL;
const POLL_INTERVAL_MS = Number(process.env.ANALYTICS_POLL_MS ?? 10_000);
const FLUSH_INTERVAL_MS = Number(process.env.ANALYTICS_FLUSH_MS ?? 60_000);
const MAX_BATCH = Number(process.env.ANALYTICS_BATCH ?? 500);
const OPPORTUNITY_STATUS = new Set(['policy_skip', 'gap_skip', 'error']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toAssetKey(details?: any): string | null {
  const debt = details?.candidate?.debt?.symbol ?? details?.plan?.debt?.symbol;
  const collateral = details?.candidate?.collateral?.symbol ?? details?.plan?.collateral?.symbol;
  if (!debt || !collateral) return null;
  return `${String(debt).toUpperCase()}-${String(collateral).toUpperCase()}`;
}

function extractNetUsd(details: any): number {
  const planNet = details?.plan?.netUsd;
  if (typeof planNet === 'number' && Number.isFinite(planNet)) return planNet;
  const estBps = details?.plan?.estNetBps;
  const repayUsd = details?.plan?.repayUsd ?? details?.candidate?.debtPriceUsd;
  if (typeof estBps === 'number' && typeof repayUsd === 'number') {
    return (estBps / 10_000) * repayUsd;
  }
  return 0;
}

function extractHfDelta(details: any): number | null {
  const candidate = details?.candidate;
  if (!candidate) return null;
  const hf = typeof candidate.healthFactor === 'number' ? candidate.healthFactor : undefined;
  const threshold =
    typeof candidate.adaptiveHealthFactorMax === 'number'
      ? candidate.adaptiveHealthFactorMax
      : typeof candidate.baseHealthFactorMax === 'number'
      ? candidate.baseHealthFactorMax
      : undefined;
  if (typeof hf === 'number' && typeof threshold === 'number') {
    return hf - threshold;
  }
  return null;
}

function extractGap(details: any): number | null {
  const gap = details?.candidate?.gapBps ?? details?.gapBps;
  if (typeof gap === 'number' && Number.isFinite(gap)) {
    return gap;
  }
  return null;
}

function bucketKey(chainId: number, assetKey: string): string {
  return `${chainId}:${assetKey}`;
}

async function fetchRows(sinceId: number): Promise<AttemptRow[]> {
  const query = `
    SELECT id, chain_id, borrower, status, reason, details, created_at
    FROM liquidation_attempts
    WHERE id > $1
    ORDER BY id ASC
    LIMIT $2
  `;
  const res = await db.query(query, [sinceId, MAX_BATCH]);
  return res.rows as AttemptRow[];
}

async function postFeedback(payload: any): Promise<void> {
  if (!RISK_ENGINE_URL) return;
  try {
    const res = await fetch(`${RISK_ENGINE_URL.replace(/\/$/, '')}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      log.warn({ status: res.status, body }, 'risk-engine-feedback-failed');
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'risk-engine-feedback-error');
  }
}

async function main() {
  const cfg = loadConfig();
  const chainMap = new Map(cfg.chains.map((c) => [c.id, c]));
  await waitForDb();
  log.info('analytics-loop-start');

  let lastId = 0;
  let lastFlush = 0;
  const buckets = new Map<string, MetricsBucket>();

  while (true) {
    const loopStart = performance.now();
    try {
      const rows = await fetchRows(lastId);
      for (const row of rows) {
        lastId = Math.max(lastId, row.id);
        const chain = chainMap.get(row.chain_id);
        if (!chain) continue;
        const assetKey = toAssetKey(row.details);
        if (!assetKey) continue;
        const key = bucketKey(row.chain_id, assetKey);
        const bucket =
          buckets.get(key) ??
          {
            chainId: row.chain_id,
            chainName: chain.name,
            assetKey,
            total: 0,
            sent: 0,
            gapSkip: 0,
            policySkip: 0,
            errors: 0,
            opportunityCostUsd: 0,
            hfDeltaSum: 0,
            hfSamples: 0,
            gapSum: 0,
            gapSamples: 0,
            lastUpdated: Date.now(),
            windowStart: Date.now(),
          };

        bucket.total += 1;
        bucket.lastUpdated = Date.now();
        if (row.status === 'sent') bucket.sent += 1;
        if (row.status === 'gap_skip') bucket.gapSkip += 1;
        if (row.status === 'policy_skip') bucket.policySkip += 1;
        if (row.status === 'error') bucket.errors += 1;

        if (OPPORTUNITY_STATUS.has(row.status)) {
          const net = extractNetUsd(row.details);
          if (Number.isFinite(net) && net > 0) {
            bucket.opportunityCostUsd += net;
          }
        }

        const hfDelta = extractHfDelta(row.details);
        if (hfDelta !== null) {
          bucket.hfDeltaSum += hfDelta;
          bucket.hfSamples += 1;
        }

        const gap = extractGap(row.details);
        if (gap !== null) {
          bucket.gapSum += gap;
          bucket.gapSamples += 1;
        }

        buckets.set(key, bucket);
      }

      const now = Date.now();
      if (now - lastFlush >= FLUSH_INTERVAL_MS && buckets.size > 0) {
        for (const bucket of buckets.values()) {
          const considered = bucket.sent + bucket.gapSkip + bucket.policySkip + bucket.errors;
          if (considered === 0) continue;
          const hitRate = bucket.sent / considered;
          const gapSkipRate = bucket.gapSkip / considered;
          const policySkipRate = bucket.policySkip / considered;
          const errorRate = bucket.errors / considered;
          const modelDrift = bucket.hfSamples > 0 ? bucket.hfDeltaSum / bucket.hfSamples : 0;
          const avgGapBps = bucket.gapSamples > 0 ? bucket.gapSum / bucket.gapSamples : 0;
          const windowSeconds = Math.max(1, Math.round((now - bucket.windowStart) / 1000));

          gauge.analyticsHitRate.labels({ chain: bucket.chainName, pair: bucket.assetKey }).set(hitRate);
          gauge.analyticsOpportunityCost
            .labels({ chain: bucket.chainName, pair: bucket.assetKey })
            .set(bucket.opportunityCostUsd);
          gauge.analyticsModelDrift.labels({ chain: bucket.chainName, pair: bucket.assetKey }).set(modelDrift);

          await postFeedback({
            chainId: bucket.chainId,
            chainName: bucket.chainName,
            assetKey: bucket.assetKey,
            windowSeconds,
            counts: {
              total: bucket.total,
              considered,
              sent: bucket.sent,
              gapSkip: bucket.gapSkip,
              policySkip: bucket.policySkip,
              errors: bucket.errors,
            },
            hitRate,
            gapSkipRate,
            policySkipRate,
            errorRate,
            opportunityCostUsd: bucket.opportunityCostUsd,
            modelDrift,
            avgGapBps,
            updatedAt: new Date().toISOString(),
          });

          bucket.total = 0;
          bucket.sent = 0;
          bucket.gapSkip = 0;
          bucket.policySkip = 0;
          bucket.errors = 0;
          bucket.opportunityCostUsd = 0;
          bucket.hfDeltaSum = 0;
          bucket.hfSamples = 0;
          bucket.gapSum = 0;
          bucket.gapSamples = 0;
          bucket.windowStart = now;
        }
        lastFlush = now;
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'analytics-loop-error');
      await sleep(FLUSH_INTERVAL_MS);
    }

    const elapsed = performance.now() - loopStart;
    const waitMs = Math.max(POLL_INTERVAL_MS - elapsed, 1000);
    await sleep(waitMs);
  }
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message }, 'analytics-loop-fatal');
  process.exit(1);
});
