import { gauge } from './metrics';

type AdaptiveKey = string;

type AdaptiveState = {
  emaGap: number;
  emaVol: number;
  lastUpdated: number;
};

export type AdaptiveSample = {
  chainId: number;
  chainName: string;
  assetKey: string;
  baseHealthFactorMax: number;
  baseGapCapBps: number;
  observedGapBps: number;
};

export type AdaptiveResult = {
  healthFactorMax: number;
  gapCapBps: number;
  volatility: number;
};

const ALPHA = 0.2;
const MIN_GAP_CAP = 20;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export class AdaptiveThresholds {
  private readonly state = new Map<AdaptiveKey, AdaptiveState>();

  update(sample: AdaptiveSample): AdaptiveResult {
    const key = this.key(sample);
    const now = Date.now();
    const existing = this.state.get(key) ?? {
      emaGap: sample.baseGapCapBps,
      emaVol: 0,
      lastUpdated: now,
    };

    const gap = Math.max(sample.observedGapBps, 0);
    const emaGap = existing.emaGap + ALPHA * (gap - existing.emaGap);
    const gapDeviation = Math.abs(gap - existing.emaGap);
    const emaVol = existing.emaVol + ALPHA * (gapDeviation - existing.emaVol);

    const volatility = emaVol;

    let healthFactorMax = sample.baseHealthFactorMax;
    if (volatility > 500) {
      healthFactorMax = clamp(healthFactorMax - 0.02, Math.max(0.8, healthFactorMax * 0.9), healthFactorMax);
    } else if (volatility < 150) {
      healthFactorMax = clamp(healthFactorMax + 0.01, healthFactorMax, healthFactorMax * 1.05);
    }

    let gapCapBps = sample.baseGapCapBps;
    if (volatility > 500) {
      gapCapBps = clamp(Math.round(sample.baseGapCapBps * 0.85), MIN_GAP_CAP, sample.baseGapCapBps);
    } else if (volatility < 150) {
      gapCapBps = clamp(Math.round(sample.baseGapCapBps * 1.15), MIN_GAP_CAP, sample.baseGapCapBps + 100);
    }

    this.state.set(key, { emaGap, emaVol, lastUpdated: now });

    gauge.adaptiveHealthFactor
      .labels({ chain: sample.chainName, pair: sample.assetKey })
      .set(Number.isFinite(healthFactorMax) ? healthFactorMax : sample.baseHealthFactorMax);
    gauge.adaptiveGapCap
      .labels({ chain: sample.chainName, pair: sample.assetKey })
      .set(gapCapBps);
    gauge.adaptiveVolatility
      .labels({ chain: sample.chainName, pair: sample.assetKey })
      .set(volatility);

    return {
      healthFactorMax,
      gapCapBps,
      volatility,
    };
  }

  private key(sample: AdaptiveSample): AdaptiveKey {
    return `${sample.chainId}:${sample.assetKey}`.toLowerCase();
  }
}
