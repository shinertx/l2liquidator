import { QuoteEdge } from '../pipeline/types';
import { FabricConfig } from './types';
import type { PairRuntime } from './pair_registry';
import { log } from '../infra/logger';

export type RiskOutcome =
  | { ok: true }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

type Stats = {
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastFailureMs: number;
};

const DEFAULT_MAX_AGE_MS = 15_000;
const FAILURE_BACKOFF = Number(process.env.FABRIC_FAILURE_BACKOFF ?? 3);

export class RiskManager {
  private readonly stats = new Map<string, Stats>();
  private readonly riskLog = log.child({ module: 'fabric.risk' });

  constructor(private readonly fabric: FabricConfig) {}

  evaluate(edge: QuoteEdge, pair: PairRuntime): RiskOutcome {
    const now = Date.now();
    const maxAgeMs = this.fabric.global.maxEdgeAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (now - edge.createdAtMs > maxAgeMs) {
      return { ok: false, reason: 'edge-stale', detail: { ageMs: now - edge.createdAtMs, maxAgeMs } };
    }

    if (this.fabric.global.mode !== 'census') {
      if (edge.source === 'single-hop' && this.fabric.global.enableSingleHop === false) {
        return { ok: false, reason: 'source-disabled', detail: { source: edge.source } };
      }
      if (edge.source === 'triangular' && !this.fabric.global.enableTriangular) {
        return { ok: false, reason: 'source-disabled', detail: { source: edge.source } };
      }
      if (edge.source === 'cross-chain' && !this.fabric.global.enableCrossChain) {
        return { ok: false, reason: 'source-disabled', detail: { source: edge.source } };
      }
    }

    if (edge.estNetUsd < this.fabric.global.minNetUsd) {
      return { ok: false, reason: 'net-below-floor', detail: { netUsd: edge.estNetUsd } };
    }

    if (edge.risk.pnlMultiple < this.fabric.global.pnlMultipleMin) {
      return {
        ok: false,
        reason: 'pnl-multiple-too-low',
        detail: { multiple: edge.risk.pnlMultiple, floor: this.fabric.global.pnlMultipleMin },
      };
    }

    if (edge.risk.mode === 'inventory') {
      // Additional inventory risk checks can be placed here.
    }

    const key = this.key(pair);
    const stats = this.stats.get(key);
    if (stats && stats.consecutiveFailures >= FAILURE_BACKOFF) {
      return {
        ok: false,
        reason: 'backoff',
        detail: { consecutiveFailures: stats.consecutiveFailures },
      };
    }

    return { ok: true };
  }

  record(pair: PairRuntime, success: boolean): void {
    const key = this.key(pair);
    const stats = this.stats.get(key) ?? {
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      lastFailureMs: 0,
    };
    if (success) {
      stats.successes += 1;
      stats.consecutiveFailures = 0;
    } else {
      stats.failures += 1;
      stats.consecutiveFailures += 1;
      stats.lastFailureMs = Date.now();
      this.riskLog.warn(
        { pairId: pair.config.id, chainId: pair.chain.id, consecutiveFailures: stats.consecutiveFailures },
        'fabric-risk-failure',
      );
    }
    this.stats.set(key, stats);
  }

  private key(pair: PairRuntime): string {
    return `${pair.chain.id}:${pair.config.id}`;
  }
}
