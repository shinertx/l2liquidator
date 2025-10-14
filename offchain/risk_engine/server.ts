import '../infra/env';
import '../infra/metrics_server';
import fastify from 'fastify';

import { log } from '../infra/logger';
import { AdaptiveThresholds, type AdaptiveResult, type AdaptiveSample } from '../infra/adaptive_thresholds';
import { gauge } from '../infra/metrics';

type Snapshot = {
  sample: AdaptiveSample;
  result: AdaptiveResult;
  updatedAt: number;
};

type Feedback = {
  chainId: number;
  chainName: string;
  assetKey: string;
  hitRate: number;
  gapSkipRate: number;
  policySkipRate: number;
  errorRate: number;
  opportunityCostUsd: number;
  modelDrift: number;
  avgGapBps: number;
  windowSeconds: number;
  updatedAt: number;
};

const app = fastify({ logger: false });
const thresholds = new AdaptiveThresholds();
const snapshots = new Map<string, Snapshot>();
const feedbackMap = new Map<string, Feedback>();

app.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
  snapshots: snapshots.size,
  feedback: feedbackMap.size,
}));

app.get('/snapshots', async () => {
  const rows = Array.from(snapshots.entries()).map(([key, snap]) => ({
    key,
    sample: snap.sample,
    result: snap.result,
    updatedAt: new Date(snap.updatedAt).toISOString(),
  }));
  return { count: rows.length, rows };
});

app.get('/feedback', async () => {
  const rows = Array.from(feedbackMap.entries()).map(([key, fb]) => ({
    key,
    hitRate: fb.hitRate,
    gapSkipRate: fb.gapSkipRate,
    policySkipRate: fb.policySkipRate,
    errorRate: fb.errorRate,
    opportunityCostUsd: fb.opportunityCostUsd,
    modelDrift: fb.modelDrift,
    avgGapBps: fb.avgGapBps,
    windowSeconds: fb.windowSeconds,
    updatedAt: new Date(fb.updatedAt).toISOString(),
  }));
  return { count: rows.length, rows };
});

app.post('/feedback', async (req, reply) => {
  try {
    const payload = normalizeFeedback(req.body);
    feedbackMap.set(composeKey(payload), payload);
    gauge.analyticsHitRate.labels({ chain: payload.chainName, pair: payload.assetKey }).set(payload.hitRate);
    gauge.analyticsOpportunityCost
      .labels({ chain: payload.chainName, pair: payload.assetKey })
      .set(payload.opportunityCostUsd);
    gauge.analyticsModelDrift.labels({ chain: payload.chainName, pair: payload.assetKey }).set(payload.modelDrift);
    return { ok: true };
  } catch (err) {
    reply.code(400);
    return { error: (err as Error).message };
  }
});

app.post('/thresholds', async (req, reply) => {
  try {
    const sample = normalizeSample(req.body);
    const base = thresholds.update(sample);
    const adjusted = applyFeedback(sample, base);
    const updatedAt = Date.now();
    snapshots.set(composeKey(sample), { sample, result: adjusted, updatedAt });
    publishGauges(sample, adjusted);
    return { ...adjusted, updatedAt: new Date(updatedAt).toISOString() };
  } catch (err) {
    reply.code(400);
    return { error: (err as Error).message };
  }
});

function composeKey(sample: AdaptiveSample | Feedback): string {
  return `${sample.chainId}:${sample.assetKey}`.toLowerCase();
}

function normalizeSample(body: unknown): AdaptiveSample {
  if (typeof body !== 'object' || body === null) {
    throw new Error('request body must be an object');
  }
  const sample = body as Record<string, unknown>;
  const chainId = Number(sample.chainId);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error('chainId must be a positive number');
  }
  const chainName =
    typeof sample.chainName === 'string' && sample.chainName.length > 0 ? sample.chainName : `chain-${chainId}`;
  const assetKey =
    typeof sample.assetKey === 'string' && sample.assetKey.length > 0 ? sample.assetKey : undefined;
  if (!assetKey) {
    throw new Error('assetKey is required');
  }
  const baseHealthFactorMax = Number(sample.baseHealthFactorMax);
  if (!Number.isFinite(baseHealthFactorMax) || baseHealthFactorMax <= 0) {
    throw new Error('baseHealthFactorMax must be a positive number');
  }
  const baseGapCapBps = Number(sample.baseGapCapBps);
  if (!Number.isFinite(baseGapCapBps) || baseGapCapBps <= 0) {
    throw new Error('baseGapCapBps must be a positive number');
  }
  const observedGapBps = Number(sample.observedGapBps);
  if (!Number.isFinite(observedGapBps)) {
    throw new Error('observedGapBps must be a number');
  }
  return {
    chainId,
    chainName,
    assetKey,
    baseHealthFactorMax,
    baseGapCapBps,
    observedGapBps,
  };
}

function normalizeFeedback(body: unknown): Feedback {
  if (typeof body !== 'object' || body === null) {
    throw new Error('feedback payload must be an object');
  }
  const raw = body as Record<string, unknown>;
  const chainId = Number(raw.chainId);
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error('chainId must be positive');
  const chainName = typeof raw.chainName === 'string' && raw.chainName.length > 0 ? raw.chainName : `chain-${chainId}`;
  const assetKey = typeof raw.assetKey === 'string' && raw.assetKey.length > 0 ? raw.assetKey : undefined;
  if (!assetKey) throw new Error('assetKey required');

  function num(key: string, fallback = 0): number {
    const value = Number(raw[key]);
    return Number.isFinite(value) ? value : fallback;
  }

  const windowSeconds = Math.max(1, Math.round(num('windowSeconds', 60)));

  return {
    chainId,
    chainName,
    assetKey,
    hitRate: clampNum(num('hitRate'), 0, 1),
    gapSkipRate: clampNum(num('gapSkipRate'), 0, 1),
    policySkipRate: clampNum(num('policySkipRate'), 0, 1),
    errorRate: clampNum(num('errorRate'), 0, 1),
    opportunityCostUsd: Math.max(0, num('opportunityCostUsd')),
    modelDrift: num('modelDrift'),
    avgGapBps: Math.max(0, num('avgGapBps')),
    windowSeconds,
    updatedAt: Date.now(),
  };
}

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function applyFeedback(sample: AdaptiveSample, base: AdaptiveResult): AdaptiveResult {
  const key = composeKey(sample);
  const feedback = feedbackMap.get(key);
  if (!feedback) return base;

  let { healthFactorMax, gapCapBps, volatility } = base;
  const aggroSignal = feedback.hitRate < 0.5 && feedback.opportunityCostUsd > 50;
  const pullbackSignal = feedback.errorRate > 0.2;
  const gapPressure = feedback.gapSkipRate > 0.3 && feedback.opportunityCostUsd > 25;

  if (aggroSignal) {
    healthFactorMax = clamp(
      healthFactorMax + 0.02,
      sample.baseHealthFactorMax * 0.9,
      sample.baseHealthFactorMax + 0.1
    );
    gapCapBps = clamp(gapCapBps + 25, 20, sample.baseGapCapBps + 200);
  }

  if (gapPressure) {
    gapCapBps = clamp(gapCapBps + 15, 20, sample.baseGapCapBps + 200);
  }

  if (pullbackSignal) {
    healthFactorMax = clamp(
      healthFactorMax - 0.02,
      Math.max(0.7, sample.baseHealthFactorMax - 0.1),
      sample.baseHealthFactorMax + 0.1
    );
    gapCapBps = clamp(gapCapBps - 20, 20, sample.baseGapCapBps + 100);
  }

  if (feedback.modelDrift > 0.02) {
    // We are skipping just above threshold — loosen slightly.
    healthFactorMax = clamp(
      healthFactorMax + 0.01,
      sample.baseHealthFactorMax * 0.9,
      sample.baseHealthFactorMax + 0.12
    );
  } else if (feedback.modelDrift < -0.03) {
    // Acting too early; tighten a bit.
    healthFactorMax = clamp(
      healthFactorMax - 0.01,
      Math.max(0.75, sample.baseHealthFactorMax - 0.12),
      sample.baseHealthFactorMax + 0.1
    );
  }

  if (feedback.avgGapBps > 0 && feedback.avgGapBps < gapCapBps / 2) {
    gapCapBps = clamp(gapCapBps - 10, 20, sample.baseGapCapBps + 200);
  }

  return {
    healthFactorMax,
    gapCapBps,
    volatility,
  };
}

function publishGauges(sample: AdaptiveSample, result: AdaptiveResult): void {
  gauge.adaptiveHealthFactor.labels({ chain: sample.chainName, pair: sample.assetKey }).set(result.healthFactorMax);
  gauge.adaptiveGapCap.labels({ chain: sample.chainName, pair: sample.assetKey }).set(result.gapCapBps);
  gauge.adaptiveVolatility.labels({ chain: sample.chainName, pair: sample.assetKey }).set(result.volatility);
}

async function start() {
  const port = Number(process.env.RISK_ENGINE_PORT ?? 4010);
  const host = process.env.RISK_ENGINE_HOST ?? '0.0.0.0';
  try {
    await app.listen({ port, host });
    log.info({ port, host }, 'risk-engine-ready');
  } catch (err) {
    log.fatal({ err: (err as Error).message }, 'risk-engine-failed');
    process.exit(1);
  }
}

start();
