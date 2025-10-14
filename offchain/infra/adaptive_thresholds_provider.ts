import { performance } from 'node:perf_hooks';
import { log } from './logger';
import { counter, gauge, histogram } from './metrics';
import { AdaptiveThresholds, type AdaptiveResult, type AdaptiveSample } from './adaptive_thresholds';

type RemoteResponse = {
  healthFactorMax: number;
  gapCapBps: number;
  volatility?: number;
};

function sanitizeUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export class AdaptiveThresholdsProvider {
  private readonly local = new AdaptiveThresholds();
  private readonly remoteUrl?: string;
  private lastRemoteErrorMs = 0;

  constructor(url?: string | null) {
    this.remoteUrl = sanitizeUrl(url);
  }

  async update(sample: AdaptiveSample): Promise<AdaptiveResult> {
    if (this.remoteUrl) {
      const labels = { chain: sample.chainName, pair: sample.assetKey } as const;
      counter.adaptiveRemoteRequests.labels(labels).inc();
      const start = performance.now();
      try {
        const result = await this.fetchRemote(sample);
        const duration = (performance.now() - start) / 1000;
        histogram.adaptiveRemoteLatency.labels(labels).observe(duration);
        if (result) {
          try {
            this.local.update(sample);
          } catch (err) {
            log.debug(
              {
                err: (err as Error).message,
                chain: sample.chainName,
                asset: sample.assetKey,
              },
              'adaptive-threshold-local-sync-failed'
            );
          }
          this.publish(sample, result);
          return result;
        }
      } catch (err) {
        const duration = (performance.now() - start) / 1000;
        histogram.adaptiveRemoteLatency.labels(labels).observe(duration);
        counter.adaptiveRemoteErrors.labels(labels).inc();
        const now = Date.now();
        if (now - this.lastRemoteErrorMs > 60_000) {
          this.lastRemoteErrorMs = now;
          log.warn(
            {
              err: (err as Error).message,
              chain: sample.chainName,
              asset: sample.assetKey,
              remote: this.remoteUrl,
            },
            'adaptive-threshold-remote-failed'
          );
        }
      }
    }
    return this.local.update(sample);
  }

  private async fetchRemote(sample: AdaptiveSample): Promise<AdaptiveResult | null> {
    if (typeof fetch !== 'function') {
      throw new Error('fetch not available for remote adaptive thresholds');
    }
    const res = await fetch(`${this.remoteUrl}/thresholds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample),
    });
    if (!res.ok) {
      throw new Error(`remote responded ${res.status}`);
    }
    const data = (await res.json()) as RemoteResponse | null;
    if (!data) return null;
    const { healthFactorMax, gapCapBps, volatility } = data;
    if (typeof healthFactorMax !== 'number' || typeof gapCapBps !== 'number') {
      throw new Error('remote payload missing thresholds');
    }
    return {
      healthFactorMax,
      gapCapBps,
      volatility: typeof volatility === 'number' ? volatility : 0,
    };
  }

  private publish(sample: AdaptiveSample, result: AdaptiveResult): void {
    gauge.adaptiveHealthFactor
      .labels({ chain: sample.chainName, pair: sample.assetKey })
      .set(result.healthFactorMax);
    gauge.adaptiveGapCap.labels({ chain: sample.chainName, pair: sample.assetKey }).set(result.gapCapBps);
    gauge.adaptiveVolatility
      .labels({ chain: sample.chainName, pair: sample.assetKey })
      .set(result.volatility ?? 0);
  }
}
