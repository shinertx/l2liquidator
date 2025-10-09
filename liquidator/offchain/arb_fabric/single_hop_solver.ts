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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SingleHopSolver {
  private readonly quoter: QuoterMesh;
  private stopped = false;

  constructor(private readonly registry: PairRegistry, private readonly fabric: FabricConfig) {
    this.quoter = new QuoterMesh(registry);
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
    const gasPrice = await client.getGasPrice();
    const gasUnits = BigInt(
      Math.ceil(pair.fabricChain.gasUnitsEstimate * (pair.fabricChain.gasSafetyMultiplier ?? 1.25)),
    );
    const gasWei = gasPrice * gasUnits;
    const gasUsd = weiToEth(gasWei) * nativeOracle.priceUsd;
    const computations: SingleHopEdgeComputation[] = [];
    for (const venueSell of pair.venues) {
      const sellResult = await this.quoter.quoteExactInput(
        client,
        venueSell,
        pair.tradeSizeBase,
        venueSell.tokenIn.address,
        venueSell.tokenOut.address,
      );
      if (sellResult.amountOut === 0n) continue;
      for (const venueBuy of pair.venues) {
        if (venueBuy.config.id === venueSell.config.id) continue;
        const buyResult = await this.quoter.quoteExactInput(
          client,
          venueBuy,
          sellResult.amountOut,
          venueBuy.tokenOut.address,
          venueBuy.tokenIn.address,
        );
        const netBase = buyResult.amountOut - pair.tradeSizeBase;
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
          amountBaseIn: pair.tradeSizeBase,
          amountQuoteOut: sellResult.amountOut,
          amountBaseReturned: buyResult.amountOut,
          gasWei,
          gasUsd,
          netBase,
          netUsd,
          pnlMultiple,
        });
      }
    }
    return this.buildEdges(pair, computations, gasUsd);
  }

  private buildEdges(
    pair: PairRuntime,
    computations: SingleHopEdgeComputation[],
    gasUsd: number,
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
          basePriceUsd: baseOracle.priceUsd,
        },
      });
    }
    return edges;
  }
}
