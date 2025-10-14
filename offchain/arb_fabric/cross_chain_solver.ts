import { formatUnits } from 'viem';
import { QuoteEdge } from '../pipeline/types';
import { PairRegistry, PairRuntime } from './pair_registry';
import { FabricConfig } from './types';
import { QuoterMesh } from './quoter_mesh';
import { fetchOraclePriceUsd } from './oracle';
import { getPublicClient } from '../infra/rpc_clients';
import { log } from '../infra/logger';
import { bigintMin, weiToEth } from './utils';
import { PriceGraph, type DepthPoint } from './price_graph';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ChainQuote = {
  pair: PairRuntime;
  venueId: string;
  tradeQuoteOut: bigint;
  sampledBaseAmount: bigint;
  priceQuotePerBase: number;
  priceBasePerQuote: number;
  gasUsd: number;
  quotePriceUsd: number;
  nativePriceUsd: number;
  timestampMs: number;
  baseAmountFallback: bigint;
  baseAmountSuggested: bigint;
  sizeMultiplier: number;
  depth: DepthPoint[];
  venueFresh: boolean;
};

export class CrossChainSolver {
  private stopped = false;
  private readonly quoter: QuoterMesh;
  private readonly logger = log.child({ module: 'fabric.cross-chain' });
  private readonly maxSlippageBps: number;

  constructor(
    private readonly registry: PairRegistry,
    private readonly fabric: FabricConfig,
    private readonly priceGraph?: PriceGraph,
  ) {
    this.quoter = new QuoterMesh(registry);
    this.maxSlippageBps = fabric.global.slippageBps ?? 35;
  }

  stop(): void {
    this.stopped = true;
  }

  async *findCrossChainEdges(): AsyncGenerator<QuoteEdge> {
    const interval = Math.max(1_000, this.fabric.global.quoteIntervalMs);
    while (!this.stopped) {
      if (!this.fabric.global.enableCrossChain) {
        await delay(interval);
        continue;
      }
      const edges = await this.evaluateGroups();
      for (const edge of edges) {
        yield edge;
      }
      if (this.stopped) break;
      await delay(interval);
    }
  }

  private groupPairs(): Map<string, PairRuntime[]> {
    const groups = new Map<string, PairRuntime[]>();
    for (const pair of this.registry.getPairs()) {
      if (!pair.fabricChain.enabled) continue;
      const key = `${pair.config.baseToken.toLowerCase()}::${pair.config.quoteToken.toLowerCase()}`;
      const list = groups.get(key) ?? [];
      list.push(pair);
      groups.set(key, list);
    }
    return groups;
  }

  private async evaluateGroups(): Promise<QuoteEdge[]> {
    const edges: QuoteEdge[] = [];
    const groups = this.groupPairs();
    for (const [, pairs] of groups) {
      if (pairs.length < 2) continue;
      try {
        const quotes = await this.loadQuotes(pairs);
        edges.push(...this.computeEdges(quotes));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn({ err: message }, 'cross-chain-eval-failed');
      }
    }
    return edges;
  }

  private async loadQuotes(pairs: PairRuntime[]): Promise<ChainQuote[]> {
    const results: ChainQuote[] = [];
    for (const pair of pairs) {
      if (this.stopped) break;
      const venueQuotes = await this.quoter.quotePair(pair);
      if (venueQuotes.size === 0) continue;
      let bestVenueId: string | undefined;
      let bestQuoteOut = 0n;
      for (const [venueId, quote] of venueQuotes.entries()) {
        if (quote.baseToQuoteOut > bestQuoteOut) {
          bestQuoteOut = quote.baseToQuoteOut;
          bestVenueId = venueId;
        }
      }
      if (!bestVenueId || bestQuoteOut === 0n) continue;

      const client = getPublicClient(pair.chain);
      const nativeToken = pair.chain.tokens[pair.fabricChain.nativeToken];
      const nativeOracle = await fetchOraclePriceUsd(client, nativeToken);
      if (!nativeOracle.priceUsd || nativeOracle.stale) {
        this.logger.debug({ chainId: pair.chain.id, pairId: pair.config.id }, 'cross-chain-native-stale');
        continue;
      }
      const quoteOracle = await fetchOraclePriceUsd(client, pair.quoteToken);
      if (!quoteOracle.priceUsd || quoteOracle.stale) {
        this.logger.debug({ chainId: pair.chain.id, pairId: pair.config.id }, 'cross-chain-quote-stale');
        continue;
      }

      const gasUnits = Math.ceil(
        pair.fabricChain.gasUnitsEstimate * (pair.fabricChain.gasSafetyMultiplier ?? 1.25),
      );
      const gasPrice = await client.getGasPrice();
      const gasWei = gasPrice * BigInt(gasUnits);
      const gasUsd = weiToEth(gasWei) * nativeOracle.priceUsd;

      let sampledBaseAmount = pair.tradeSizeBase;
      let sampledQuoteOut = bestQuoteOut;
      let { priceQuotePerBase, priceBasePerQuote } = this.computePrice(sampledBaseAmount, pair, sampledQuoteOut);

      const baseAmountFallback = pair.tradeSizeBase;
      let baseAmountSuggested = baseAmountFallback;
      let sizeMultiplier = 1;
      let depth: DepthPoint[] = [];
      let venueFresh = true;

      if (this.priceGraph) {
        depth = this.priceGraph.getDepthPoints(pair.config.id, bestVenueId);
        const primary = depth.find((point) => point.multiplier === 1) ?? depth[depth.length - 1];
        if (primary) {
          sampledBaseAmount = primary.amountBaseIn;
          priceQuotePerBase = primary.priceQuotePerBase;
          priceBasePerQuote = primary.priceBasePerQuote;
          sampledQuoteOut = primary.amountQuoteOut;
          venueFresh = Date.now() - primary.updatedAtMs <= this.fabric.global.quoteIntervalMs * 3;
        } else {
          venueFresh = this.priceGraph.isFresh(pair.config.id);
        }
        const suggested = this.priceGraph.suggestBaseAmount(pair, bestVenueId, this.maxSlippageBps);
        if (suggested > 0n) {
          baseAmountSuggested = suggested;
        }
      }

      sizeMultiplier = this.getSizeMultiplier(baseAmountSuggested, baseAmountFallback);

      results.push({
        pair,
        venueId: bestVenueId,
  tradeQuoteOut: sampledQuoteOut,
  sampledBaseAmount,
        priceQuotePerBase,
        priceBasePerQuote,
        gasUsd,
        quotePriceUsd: quoteOracle.priceUsd,
        nativePriceUsd: nativeOracle.priceUsd,
        timestampMs: Date.now(),
        baseAmountFallback,
        baseAmountSuggested,
        sizeMultiplier,
        depth,
        venueFresh,
      });
    }
    return results;
  }

  private computePrice(baseAmount: bigint, pair: PairRuntime, quoteOut: bigint): { priceQuotePerBase: number; priceBasePerQuote: number } {
    const base = Number(formatUnits(baseAmount, pair.baseToken.decimals));
    if (base === 0) {
      return { priceQuotePerBase: 0, priceBasePerQuote: 0 };
    }
    const quote = Number(formatUnits(quoteOut, pair.quoteToken.decimals));
    const priceQuotePerBase = quote / base;
    const priceBasePerQuote = priceQuotePerBase > 0 ? 1 / priceQuotePerBase : 0;
    return { priceQuotePerBase, priceBasePerQuote };
  }

  private computeEdges(quotes: ChainQuote[]): QuoteEdge[] {
    const edges: QuoteEdge[] = [];
    if (quotes.length < 2) return edges;

    const minNet = this.fabric.global.minNetUsd;
    const minMultiple = this.fabric.global.pnlMultipleMin;
    const revertProb = this.fabric.global.revertProbability;
    const inclusionMs = this.fabric.global.inclusionTargetMs;
    const expiryDelta = this.fabric.global.maxEdgeAgeMs ?? 60_000;

    for (let i = 0; i < quotes.length; i += 1) {
      for (let j = 0; j < quotes.length; j += 1) {
        if (i === j) continue;
        const buy = quotes[i];
        const sell = quotes[j];

        if (this.priceGraph && (!buy.venueFresh || !sell.venueFresh)) {
          continue;
        }

        const baseAmountBuy = this.pickBaseAmount(buy);
        const baseAmountSell = this.pickBaseAmount(sell);
        const baseAmount = bigintMin(baseAmountBuy, baseAmountSell);
        if (baseAmount === 0n) continue;
        const baseFloat = Number(formatUnits(baseAmount, buy.pair.baseToken.decimals));
        if (!Number.isFinite(baseFloat) || baseFloat === 0) continue;

        const diff = sell.priceQuotePerBase - buy.priceQuotePerBase;
        if (diff <= 0) continue;

        const grossQuoteDelta = diff * baseFloat;
        const quotePriceUsd = (buy.quotePriceUsd + sell.quotePriceUsd) / 2;
        const grossUsd = grossQuoteDelta * quotePriceUsd;
        const gasUsd = buy.gasUsd + sell.gasUsd;
        if (gasUsd <= 0) continue;
        const estNetUsd = grossUsd - gasUsd;
        const pnlMultiple = estNetUsd / gasUsd;
        if (estNetUsd < minNet || pnlMultiple < minMultiple) continue;

        const buyQuoteIn = this.scaleQuoteAmount(buy, baseAmount);
        const sellQuoteOut = this.scaleQuoteAmount(sell, baseAmount);

        const createdAtMs = Date.now();
        const legs = [
          {
            chainId: buy.pair.chain.id,
            venue: buy.venueId,
            action: 'swap' as const,
            tokenIn: buy.pair.quoteToken.address,
            tokenOut: buy.pair.baseToken.address,
            amountIn: buyQuoteIn,
            minAmountOut: baseAmount,
            metadata: {
              side: 'buy-base',
              priceQuotePerBase: buy.priceQuotePerBase,
            },
          },
          {
            chainId: buy.pair.chain.id,
            venue: 'bridge',
            action: 'bridge' as const,
            tokenIn: buy.pair.baseToken.address,
            tokenOut: buy.pair.baseToken.address,
            amountIn: baseAmount,
            metadata: {
              fromChainId: buy.pair.chain.id,
              toChainId: sell.pair.chain.id,
            },
          },
          {
            chainId: sell.pair.chain.id,
            venue: sell.venueId,
            action: 'swap' as const,
            tokenIn: sell.pair.baseToken.address,
            tokenOut: sell.pair.quoteToken.address,
            amountIn: baseAmount,
            minAmountOut: sellQuoteOut,
            metadata: {
              side: 'sell-base',
              priceQuotePerBase: sell.priceQuotePerBase,
            },
          },
        ];

        edges.push({
          id: `${buy.pair.config.id}->${sell.pair.config.id}:${createdAtMs}`,
          source: 'cross-chain',
          legs,
          sizeIn: baseAmount,
          estNetUsd,
          estGasUsd: gasUsd,
          estSlippageUsd: 0,
          estFailCostUsd: gasUsd * revertProb,
          risk: {
            minNetUsd: minNet,
            pnlMultiple,
            revertProbability: revertProb,
            inclusionP95Ms: inclusionMs,
            mode: this.fabric.global.mode,
          },
          createdAtMs,
          expiresAtMs: createdAtMs + expiryDelta,
          tags: [
            buy.pair.config.baseToken,
            buy.pair.config.quoteToken,
            `${buy.pair.chain.id}->${sell.pair.chain.id}`,
          ],
          metrics: {
            grossQuoteDelta,
            buyPrice: buy.priceQuotePerBase,
            sellPrice: sell.priceQuotePerBase,
          },
          metadata: {
            buyChainId: buy.pair.chain.id,
            sellChainId: sell.pair.chain.id,
            buyVenue: buy.venueId,
            sellVenue: sell.venueId,
            quotePriceUsd,
            nativePricesUsd: {
              [buy.pair.chain.id]: buy.nativePriceUsd,
              [sell.pair.chain.id]: sell.nativePriceUsd,
            },
          },
        });
      }
    }
    return edges;
  }

  private pickBaseAmount(entry: ChainQuote): bigint {
    if (entry.baseAmountSuggested > 0n) {
      return entry.baseAmountSuggested;
    }
    return entry.baseAmountFallback;
  }

  private getSizeMultiplier(suggested: bigint, fallback: bigint): number {
    if (fallback === 0n || suggested === 0n) return 1;
    if (suggested === fallback) return 1;
    const ratio = Number(suggested) / Number(fallback);
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return 1;
    }
    const clamped = Math.max(0.25, Math.min(ratio, 4));
    return clamped;
  }

  private scaleQuoteAmount(entry: ChainQuote, baseAmount: bigint): bigint {
    if (entry.tradeQuoteOut === 0n || entry.sampledBaseAmount === 0n) return 0n;
    return (baseAmount * entry.tradeQuoteOut) / entry.sampledBaseAmount;
  }

}
