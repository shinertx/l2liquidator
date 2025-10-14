import { formatUnits } from 'viem';
import { QuoterMesh } from './quoter_mesh';
import type { PairRegistry, PairRuntime, VenueRuntime } from './pair_registry';
import type { FabricConfig } from './types';
import { log } from '../infra/logger';
import { getPublicClient } from '../infra/rpc_clients';

const DEFAULT_FRESHNESS_MS = 7_500;
const DEFAULT_MAX_SLIPPAGE_BPS = 35;
const DEFAULT_DEPTH_TIERS = [0.25, 0.5, 1, 1.5, 2];

export type DepthPoint = {
  multiplier: number;
  amountBaseIn: bigint;
  amountQuoteOut: bigint;
  priceQuotePerBase: number;
  priceBasePerQuote: number;
  slippageBps: number;
  gasEstimate: bigint;
  updatedAtMs: number;
};

type VenueSnapshot = {
  venueId: string;
  updatedAtMs: number;
  depth: DepthPoint[];
};

type PairSnapshot = {
  pairId: string;
  chainId: number;
  updatedAtMs: number;
  venues: Map<string, VenueSnapshot>;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PriceGraph {
  private readonly quoter: QuoterMesh;
  private readonly snapshots = new Map<string, PairSnapshot>();
  private running = false;
  private loop?: Promise<void>;
  private readonly logger = log.child({ module: 'fabric.price-graph' });
  private readonly refreshIntervalMs: number;
  private readonly freshnessMs: number;
  private readonly maxSlippageBps: number;
  private readonly depthTiers: readonly number[];

  constructor(private readonly registry: PairRegistry, fabric: FabricConfig) {
    this.quoter = new QuoterMesh(registry);
    this.refreshIntervalMs = Math.max(1_000, fabric.global.quoteIntervalMs);
    this.freshnessMs = Math.max(DEFAULT_FRESHNESS_MS, this.refreshIntervalMs * 3);
    this.maxSlippageBps = fabric.global.slippageBps ?? DEFAULT_MAX_SLIPPAGE_BPS;
    const tiers = (fabric.global.priceGraphDepthTiers ?? DEFAULT_DEPTH_TIERS).slice().sort((a, b) => a - b);
    if (!tiers.includes(1)) tiers.push(1);
    this.depthTiers = [...new Set(tiers)].sort((a, b) => a - b);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.refreshLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      await this.loop;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err: message }, 'price-graph-stop-error');
    }
  }

  getSnapshot(pairId: string): PairSnapshot | undefined {
    return this.snapshots.get(pairId);
  }

  getVenueSnapshot(pairId: string, venueId: string): VenueSnapshot | undefined {
    const snapshot = this.snapshots.get(pairId);
    return snapshot?.venues.get(venueId);
  }

  isFresh(pairId: string, freshnessMs = this.freshnessMs): boolean {
    const snapshot = this.snapshots.get(pairId);
    if (!snapshot) return false;
    return Date.now() - snapshot.updatedAtMs <= freshnessMs;
  }

  estimateNetUsdWithSell(params: {
    pair: PairRuntime;
    basePriceUsd: number;
    buyVenueId: string;
    realizedSellPriceQuotePerBase: number;
    baseAmountFloat: number;
    freshnessMs?: number;
  }): { netUsd: number; ageMs: number } | null {
    const { pair, basePriceUsd, buyVenueId, realizedSellPriceQuotePerBase, baseAmountFloat } = params;
    const freshnessMs = params.freshnessMs ?? this.freshnessMs;
    if (!Number.isFinite(baseAmountFloat) || baseAmountFloat <= 0) {
      return null;
    }
    const snapshot = this.snapshots.get(pair.config.id);
    if (!snapshot) return null;
    const buySnapshot = snapshot.venues.get(buyVenueId);
    if (!buySnapshot) return null;
    const primary = this.getPrimaryPoint(buySnapshot);
    if (!primary) return null;
    const ageMs = Date.now() - primary.updatedAtMs;
    if (ageMs > freshnessMs) {
      return null;
    }
    if (primary.priceBasePerQuote <= 0 || realizedSellPriceQuotePerBase <= 0) {
      return null;
    }
    const grossMultiplier = realizedSellPriceQuotePerBase * primary.priceBasePerQuote;
    if (!Number.isFinite(grossMultiplier)) {
      return null;
    }
    const netBase = baseAmountFloat * (grossMultiplier - 1);
    const netUsd = netBase * basePriceUsd;
    if (!Number.isFinite(netUsd)) {
      return null;
    }
    return { netUsd, ageMs };
  }

  getDepthPoints(pairId: string, venueId: string): DepthPoint[] {
    const venue = this.getVenueSnapshot(pairId, venueId);
    if (!venue) return [];
    return [...venue.depth].sort((a, b) => a.multiplier - b.multiplier);
  }

  suggestBaseAmount(
    pair: PairRuntime,
    venueId: string,
    maxSlippageBps = this.maxSlippageBps,
  ): bigint {
    const points = this.getDepthPoints(pair.config.id, venueId);
    if (points.length === 0) return pair.tradeSizeBase;
    for (const point of [...points].sort((a, b) => a.multiplier - b.multiplier).reverse()) {
      if (Math.abs(point.slippageBps) <= maxSlippageBps) {
        return point.amountBaseIn;
      }
    }
    return points[0].amountBaseIn;
  }

  private getPrimaryPoint(snapshot: VenueSnapshot): DepthPoint | null {
    const sorted = [...snapshot.depth].sort((a, b) => a.multiplier - b.multiplier);
    const exact = sorted.find((point) => point.multiplier === 1);
    return exact ?? sorted[sorted.length - 1] ?? null;
  }

  private async refreshLoop(): Promise<void> {
    while (this.running) {
      for (const pair of this.registry.getPairs()) {
        if (!this.running) break;
        try {
          await this.refreshPair(pair);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.debug({ pairId: pair.config.id, err: message }, 'price-graph-refresh-failed');
        }
      }
      if (!this.running) break;
      await delay(this.refreshIntervalMs);
    }
  }

  private async refreshPair(pair: PairRuntime): Promise<void> {
    if (!pair.fabricChain.enabled) return;
    const client = getPublicClient(pair.chain);
    const venues = new Map<string, VenueSnapshot>();
    for (const venue of pair.venues) {
      const snapshot = await this.refreshVenue(client, pair, venue);
      if (snapshot) {
        venues.set(snapshot.venueId, snapshot);
      }
    }
    if (venues.size === 0) {
      return;
    }
    this.snapshots.set(pair.config.id, {
      pairId: pair.config.id,
      chainId: pair.chain.id,
      updatedAtMs: Date.now(),
      venues,
    });
  }

  private async refreshVenue(
    client: ReturnType<typeof getPublicClient>,
    pair: PairRuntime,
    venue: VenueRuntime,
  ): Promise<VenueSnapshot | null> {
    const depth: DepthPoint[] = [];
    let baselinePrice: number | undefined;

    for (const multiplier of this.depthTiers) {
      const amountIn = this.scaleAmount(pair.tradeSizeBase, multiplier);
      if (amountIn === 0n) continue;
      try {
        const result = await this.quoter.quoteExactInput(
          client,
          venue,
          amountIn,
          pair.baseToken.address,
          pair.quoteToken.address,
        );
        if (result.amountOut === 0n) {
          if (multiplier >= 1) break;
          continue;
        }
        const baseAmountFloat = Number(formatUnits(amountIn, pair.baseToken.decimals));
        if (!Number.isFinite(baseAmountFloat) || baseAmountFloat <= 0) {
          continue;
        }
        const quoteAmountFloat = Number(formatUnits(result.amountOut, pair.quoteToken.decimals));
        if (!Number.isFinite(quoteAmountFloat) || quoteAmountFloat <= 0) {
          continue;
        }
        const priceQuotePerBase = quoteAmountFloat / baseAmountFloat;
        if (!Number.isFinite(priceQuotePerBase) || priceQuotePerBase <= 0) {
          continue;
        }
        const priceBasePerQuote = priceQuotePerBase > 0 ? 1 / priceQuotePerBase : 0;
        const point: DepthPoint = {
          multiplier,
          amountBaseIn: amountIn,
          amountQuoteOut: result.amountOut,
          priceQuotePerBase,
          priceBasePerQuote,
          slippageBps: 0,
          gasEstimate: result.gasEstimate,
          updatedAtMs: Date.now(),
        };
        depth.push(point);
        if (multiplier === 1) {
          baselinePrice = priceQuotePerBase;
        } else if (baselinePrice === undefined) {
          baselinePrice = priceQuotePerBase;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug({ pairId: pair.config.id, venue: venue.config.id, multiplier, err: message }, 'price-graph-depth-failed');
        if (multiplier >= 1) {
          break;
        }
      }
    }

    if (depth.length === 0 || baselinePrice === undefined) {
      return null;
    }

    depth.sort((a, b) => a.multiplier - b.multiplier);
    const baselinePoint = depth.find((point) => point.multiplier === 1) ?? depth[depth.length - 1];
    const effectiveBaselinePrice = baselinePoint.priceQuotePerBase > 0
      ? baselinePoint.priceQuotePerBase
      : baselinePrice;

    for (const point of depth) {
      if (effectiveBaselinePrice > 0) {
        const ratio = point.priceQuotePerBase / effectiveBaselinePrice - 1;
        const bps = Number.isFinite(ratio) ? ratio * 10_000 : 0;
        point.slippageBps = bps;
      } else {
        point.slippageBps = 0;
      }
    }

    return {
      venueId: venue.config.id,
      updatedAtMs: Date.now(),
      depth,
    };
  }

  private scaleAmount(base: bigint, multiplier: number): bigint {
    if (multiplier === 1) return base;
    const factor = Math.round(multiplier * 1_000_000);
    if (factor <= 0) return 0n;
    return (base * BigInt(factor)) / 1_000_000n;
  }
}
