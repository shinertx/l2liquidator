import { randomUUID } from 'crypto';
import { formatUnits } from 'viem';
import { QuoteEdge } from '../pipeline/types';
import { PairRegistry, PairRuntime } from './pair_registry';
import { QuoterMesh } from './quoter_mesh';
import { fetchOraclePriceUsd } from './oracle';
import { FabricConfig, SingleHopEdgeComputation } from './types';
import { formatTokenAmount, weiToEth } from './utils';
import { getPublicClient } from '../infra/rpc_clients';
import { log } from '../infra/logger';
import { PriceGraph } from './price_graph';
import { counter } from '../infra/metrics';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SingleHopSolver {
  private readonly quoter: QuoterMesh;
  private stopped = false;
  private readonly quoterFailureBackoffMs: number;
  private readonly quoterFailureBackoffMaxMs: number;
  private readonly quoterFailureLogCooldownMs: number;
  private readonly suppressedVenues = new Map<string, { until: number; lastLog?: number; failCount: number }>();

  constructor(
    private readonly registry: PairRegistry,
    private readonly fabric: FabricConfig,
    private readonly priceGraph?: PriceGraph,
  ) {
    this.quoter = new QuoterMesh(registry);
    this.quoterFailureBackoffMs = this.fabric.global.quoterFailureBackoffMs ?? 120_000;
    const configuredMax = this.fabric.global.quoterFailureBackoffMaxMs;
    this.quoterFailureBackoffMaxMs = configuredMax && configuredMax >= this.quoterFailureBackoffMs
      ? configuredMax
      : this.quoterFailureBackoffMs * 8;
    this.quoterFailureLogCooldownMs = this.fabric.global.quoterFailureLogCooldownMs ?? 30_000;
  }

  stop(): void {
    this.stopped = true;
  }

  async *findSingleHopEdges(): AsyncGenerator<QuoteEdge> {
    const interval = this.fabric.global.quoteIntervalMs;
    while (!this.stopped) {
      for (const pair of this.registry.getPairs()) {
        try {
          const edges = await this.computeEdgesForPair(pair);
          for (const edge of edges) {
            yield edge;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ pairId: pair.config.id, err: message }, 'fabric-single-hop-compute-failed');
        }
        if (this.stopped) break;
      }
      if (this.stopped) break;
      await delay(interval);
    }
  }

  private async computeEdgesForPair(pair: PairRuntime): Promise<QuoteEdge[]> {
    const client = getPublicClient(pair.chain);
    const nativeToken = pair.chain.tokens[pair.fabricChain.nativeToken];
    const nativeOracle = await fetchOraclePriceUsd(client, nativeToken);
    if (!nativeOracle.priceUsd || nativeOracle.stale) {
      log.debug(
        { pairId: pair.config.id, native: pair.fabricChain.nativeToken },
        'fabric-skip-pair-native-price-missing',
      );
      return [];
    }
    const baseOracle = await fetchOraclePriceUsd(client, pair.baseToken);
    if (!baseOracle.priceUsd || baseOracle.stale) {
      log.debug(
        { pairId: pair.config.id, base: pair.baseToken.address },
        'fabric-skip-pair-base-price-missing',
      );
      return [];
    }
    const basePriceUsd = baseOracle.priceUsd ?? 0;
    const gasPrice = await client.getGasPrice();
    const gasUnits = BigInt(
      Math.ceil(pair.fabricChain.gasUnitsEstimate * (pair.fabricChain.gasSafetyMultiplier ?? 1.25)),
    );
    const gasWei = gasPrice * gasUnits;
    const gasUsd = weiToEth(gasWei) * nativeOracle.priceUsd;
    const computations: SingleHopEdgeComputation[] = [];
    const configBaseAmountFloat = Number(formatUnits(pair.tradeSizeBase, pair.baseToken.decimals));
    const freshnessMs = this.fabric.global.quoteIntervalMs * 3;
    const maxSlippageBps = this.fabric.global.slippageBps ?? 35;
    for (const venueSell of pair.venues) {
      for (const venueBuy of pair.venues) {
        if (venueBuy.config.id === venueSell.config.id) continue;
        const tradeBaseAmount = this.pickTradeAmount(
          pair.tradeSizeBase,
          this.priceGraph?.suggestBaseAmount(pair, venueSell.config.id, maxSlippageBps),
          this.priceGraph?.suggestBaseAmount(pair, venueBuy.config.id, maxSlippageBps),
        );
        if (tradeBaseAmount === 0n) continue;
        const sellResult = await this.safeQuote(
          client,
          pair,
          venueSell,
          tradeBaseAmount,
          venueSell.tokenIn.address,
          venueSell.tokenOut.address,
        );
        if (sellResult.amountOut === 0n) continue;
        const baseAmountFloat = Number(formatUnits(tradeBaseAmount, pair.baseToken.decimals));
        if (!Number.isFinite(baseAmountFloat) || baseAmountFloat === 0) continue;
        const sellQuoteFloat = Number(formatUnits(sellResult.amountOut, pair.quoteToken.decimals));
        const realizedSellPrice =
          baseAmountFloat > 0 && sellQuoteFloat > 0 ? sellQuoteFloat / baseAmountFloat : 0;
        const rawSizeRatio =
          configBaseAmountFloat > 0 && Number.isFinite(configBaseAmountFloat)
            ? baseAmountFloat / configBaseAmountFloat
            : 1;
        const sizeRatio = Number.isFinite(rawSizeRatio) && rawSizeRatio > 0 ? rawSizeRatio : 1;
        const graphMinNetUsd = ((pair.config.minNetUsd ?? this.fabric.global.minNetUsd) * sizeRatio) * 0.6;
        if (this.priceGraph && realizedSellPrice > 0 && baseAmountFloat > 0 && basePriceUsd > 0) {
          const estimate = this.priceGraph.estimateNetUsdWithSell({
            pair,
            basePriceUsd,
            buyVenueId: venueBuy.config.id,
            realizedSellPriceQuotePerBase: realizedSellPrice,
            baseAmountFloat,
            freshnessMs,
          });
          if (estimate && estimate.netUsd < graphMinNetUsd) {
            counter.lafGraphSkip
              .labels({ chain: pair.chain.id.toString(), pair: pair.config.id, reason: 'est-net-low' })
              .inc();
            continue;
          }
        }
        const buyResult = await this.safeQuote(
          client,
          pair,
          venueBuy,
          sellResult.amountOut,
          venueBuy.tokenOut.address,
          venueBuy.tokenIn.address,
        );
        const netBase = buyResult.amountOut - tradeBaseAmount;
        if (netBase <= 0n) continue;
        const netBaseFloat = parseFloat(formatUnits(netBase, pair.baseToken.decimals));
        const netUsd = netBaseFloat * baseOracle.priceUsd;
        const pnlMultiple = gasUsd > 0 ? netUsd / gasUsd : 0;
        computations.push({
          pair: pair.config,
          chain: pair.chain,
          sellVenueId: venueSell.config.id,
          sellPoolAddress: venueSell.poolAddress,
          sellLabel: venueSell.config.label,
          buyVenueId: venueBuy.config.id,
          buyPoolAddress: venueBuy.poolAddress,
          buyLabel: venueBuy.config.label,
          amountBaseIn: tradeBaseAmount,
          amountQuoteOut: sellResult.amountOut,
          amountBaseReturned: buyResult.amountOut,
          gasWei,
          gasUsd,
          netBase,
          netUsd,
          pnlMultiple,
          sizeMultiplier: sizeRatio,
        });
      }
    }
    return this.buildEdges(pair, computations, gasUsd, basePriceUsd);
  }

  private async safeQuote(
    client: ReturnType<typeof getPublicClient>,
    pair: PairRuntime,
    venue: PairRuntime['venues'][number],
    amountIn: bigint,
    tokenIn: `0x${string}`,
    tokenOut: `0x${string}`,
  ): Promise<{ amountOut: bigint; sqrtPriceX96After: bigint; gasEstimate: bigint }> {
    const key = `${pair.config.id}:${venue.config.id}:${tokenIn}->${tokenOut}`;
    const now = Date.now();
    const suppressed = this.suppressedVenues.get(key);
    if (suppressed && suppressed.until > now) {
      if (!suppressed.lastLog || now - suppressed.lastLog >= this.quoterFailureLogCooldownMs) {
        log.debug(
          {
            pairId: pair.config.id,
            venue: venue.config.id,
            untilMs: suppressed.until,
            failCount: suppressed.failCount,
          },
          'fabric-quoter-suppressed',
        );
        this.suppressedVenues.set(key, { ...suppressed, lastLog: now });
      }
      return { amountOut: 0n, sqrtPriceX96After: 0n, gasEstimate: 0n };
    }
    if (suppressed && suppressed.until <= now) {
      this.suppressedVenues.delete(key);
    }
    try {
      const result = await this.quoter.quoteExactInput(client, venue, amountIn, tokenIn, tokenOut);
      this.suppressedVenues.delete(key);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const previous = this.suppressedVenues.get(key);
      const failCount = (previous?.failCount ?? 0) + 1;
      const backoffMs = Math.min(
        this.quoterFailureBackoffMs * Math.pow(2, failCount - 1),
        this.quoterFailureBackoffMaxMs,
      );
      const until = now + backoffMs;
      this.suppressedVenues.set(key, { until, lastLog: now, failCount });
      log.warn(
        {
          pairId: pair.config.id,
          venue: venue.config.id,
          tokenIn,
          tokenOut,
          err: message,
          retryAtMs: until,
          backoffMs,
          failCount,
        },
        'fabric-quoter-failure-backoff',
      );
      return { amountOut: 0n, sqrtPriceX96After: 0n, gasEstimate: 0n };
    }
  }

  private pickTradeAmount(...candidates: (bigint | undefined)[]): bigint {
    let best: bigint | undefined;
    for (const value of candidates) {
      if (value === undefined || value === 0n) continue;
      best = best === undefined ? value : value < best ? value : best;
    }
    return best ?? 0n;
  }

  private buildEdges(
    pair: PairRuntime,
    computations: SingleHopEdgeComputation[],
    gasUsd: number,
    basePriceUsd: number,
  ): QuoteEdge[] {
    const minNet = pair.config.minNetUsd ?? this.fabric.global.minNetUsd;
    const pnlMin = pair.config.pnlMultipleMin ?? this.fabric.global.pnlMultipleMin;
    const edges: QuoteEdge[] = [];
    for (const comp of computations) {
      if (comp.netUsd < minNet) continue;
      if (comp.pnlMultiple < pnlMin) continue;
      const id = `${pair.config.id}:${comp.sellVenueId}->${comp.buyVenueId}:${randomUUID()}`;
      edges.push({
        id,
        source: 'single-hop',
        legs: [
          {
            chainId: pair.chain.id,
            venue: comp.sellVenueId,
            poolId: comp.sellPoolAddress,
            action: 'flash-swap',
            tokenIn: pair.baseToken.address,
            tokenOut: pair.quoteToken.address,
            amountIn: comp.amountBaseIn,
            minAmountOut: comp.amountQuoteOut,
            feeBps: pair.venues.find((v) => v.config.id === comp.sellVenueId)?.config.feeBps,
            metadata: {
              label: comp.sellLabel,
              pair: pair.config.symbol,
              quote: formatTokenAmount(comp.amountQuoteOut, pair.quoteToken.decimals),
            },
          },
          {
            chainId: pair.chain.id,
            venue: comp.buyVenueId,
            poolId: comp.buyPoolAddress,
            action: 'swap',
            tokenIn: pair.quoteToken.address,
            tokenOut: pair.baseToken.address,
            amountIn: comp.amountQuoteOut,
            minAmountOut: comp.amountBaseReturned,
            feeBps: pair.venues.find((v) => v.config.id === comp.buyVenueId)?.config.feeBps,
            metadata: {
              label: comp.buyLabel,
              pair: pair.config.symbol,
            },
          },
        ],
        sizeIn: comp.amountBaseIn,
        estNetUsd: comp.netUsd,
        estGasUsd: gasUsd,
        estSlippageUsd: 0,
        estFailCostUsd: gasUsd,
        risk: {
          minNetUsd: minNet,
          pnlMultiple: comp.pnlMultiple,
          revertProbability: this.fabric.global.revertProbability,
          inclusionP95Ms: this.fabric.global.inclusionTargetMs,
          mode: this.fabric.global.mode,
        },
        createdAtMs: Date.now(),
        tags: ['laf', pair.config.symbol, comp.sellVenueId, comp.buyVenueId],
        metrics: {
          netBase: comp.netBase.toString(),
          amountBaseReturned: comp.amountBaseReturned.toString(),
          gasWei: comp.gasWei.toString(),
        },
        metadata: {
          pairId: pair.config.id,
          chainId: pair.chain.id,
          baseToken: pair.baseToken.address,
          quoteToken: pair.quoteToken.address,
          baseDecimals: pair.baseToken.decimals,
          quoteDecimals: pair.quoteToken.decimals,
          sellFeeBps: pair.venues.find((v) => v.config.id === comp.sellVenueId)?.config.feeBps ?? null,
          buyFeeBps: pair.venues.find((v) => v.config.id === comp.buyVenueId)?.config.feeBps ?? null,
          basePriceUsd,
          sizeMultiplier: comp.sizeMultiplier ?? 1,
        },
      });
    }
    return edges;
  }
}
