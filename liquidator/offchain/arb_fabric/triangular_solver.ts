import { randomUUID } from 'crypto';
import { formatUnits } from 'viem';
import { QuoteEdge } from '../pipeline/types';
import { PairRegistry, PairRuntime, VenueRuntime } from './pair_registry';
import { QuoterMesh } from './quoter_mesh';
import { fetchOraclePriceUsd } from './oracle';
import { FabricConfig } from './types';
import { getPublicClient } from '../infra/rpc_clients';
import { log } from '../infra/logger';
import { weiToEth, formatTokenAmount } from './utils';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LoopVenue = {
  pair: PairRuntime;
  venue: VenueRuntime;
};

export class TriangularSolver {
  private readonly quoter: QuoterMesh;
  private stopped = false;
  private readonly solverLog = log.child({ module: 'fabric.triangular' });

  constructor(private readonly registry: PairRegistry, private readonly fabric: FabricConfig) {
    this.quoter = new QuoterMesh(registry);
  }

  stop(): void {
    this.stopped = true;
  }

  async *findTriangularEdges(): AsyncGenerator<QuoteEdge> {
    const interval = this.fabric.global.quoteIntervalMs;
    const maxVenues = Math.max(1, this.fabric.global.maxVenuesPerLeg ?? 1);
    while (!this.stopped) {
      const pairsByChain = this.groupPairsByChain();
      for (const [, pairs] of pairsByChain) {
        if (this.stopped) break;
        try {
          const edges = await this.computeEdgesForChain(pairs, maxVenues);
          for (const edge of edges) {
            yield edge;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.solverLog.warn({ err: message }, 'triangular-compute-failed');
        }
      }
      if (this.stopped) break;
      await delay(interval);
    }
  }

  private groupPairsByChain(): Map<number, PairRuntime[]> {
    const map = new Map<number, PairRuntime[]>();
    for (const pair of this.registry.getPairs()) {
      if (!pair.fabricChain.enabled) continue;
      const list = map.get(pair.chain.id) ?? [];
      list.push(pair);
      map.set(pair.chain.id, list);
    }
    return map;
  }

  private async computeEdgesForChain(pairs: PairRuntime[], maxVenues: number): Promise<QuoteEdge[]> {
    if (pairs.length < 3) return [];
    const chain = pairs[0].chain;
    const client = getPublicClient(chain);
    const nativeToken = chain.tokens[pairs[0].fabricChain.nativeToken] ?? pairs[0].baseToken;
    const nativeOracle = await fetchOraclePriceUsd(client, nativeToken);
    if (!nativeOracle.priceUsd || nativeOracle.stale) {
      return [];
    }

    const gasPrice = await client.getGasPrice();
    const gasUnits = BigInt(
      Math.ceil(pairs[0].fabricChain.gasUnitsEstimate * (pairs[0].fabricChain.gasSafetyMultiplier ?? 1.5)),
    );
    const gasWeiBase = gasPrice * gasUnits;
    const gasUsdBase = weiToEth(gasWeiBase) * nativeOracle.priceUsd;

    const seenLoops = new Set<string>();
    const edges: QuoteEdge[] = [];

    for (const pairAB of pairs) {
      for (const pairBC of pairs) {
        if (pairBC.baseToken.address.toLowerCase() !== pairAB.quoteToken.address.toLowerCase()) continue;
        if (pairBC.quoteToken.address.toLowerCase() === pairAB.baseToken.address.toLowerCase()) continue;

        for (const pairCA of pairs) {
          if (pairCA.baseToken.address.toLowerCase() !== pairBC.quoteToken.address.toLowerCase()) continue;
          if (pairCA.quoteToken.address.toLowerCase() !== pairAB.baseToken.address.toLowerCase()) continue;

          const loopKey = [
            pairAB.config.id,
            pairBC.config.id,
            pairCA.config.id,
          ].sort().join('|');
          if (seenLoops.has(loopKey)) continue;
          seenLoops.add(loopKey);

          const venAB = pairAB.venues.slice(0, maxVenues);
          const venBC = pairBC.venues.slice(0, maxVenues);
          const venCA = pairCA.venues.slice(0, maxVenues);
          if (venAB.length === 0 || venBC.length === 0 || venCA.length === 0) continue;

          for (const vAB of venAB) {
            for (const vBC of venBC) {
              for (const vCA of venCA) {
                const edge = await this.buildLoopEdge({
                  first: { pair: pairAB, venue: vAB },
                  second: { pair: pairBC, venue: vBC },
                  third: { pair: pairCA, venue: vCA },
                  gasUsdBase,
                  gasWeiBase,
                  nativePriceUsd: nativeOracle.priceUsd,
                });
                if (edge) edges.push(edge);
              }
            }
          }
        }
      }
    }
    return edges;
  }

  private async buildLoopEdge(params: {
    first: LoopVenue;
    second: LoopVenue;
    third: LoopVenue;
    gasUsdBase: number;
    gasWeiBase: bigint;
    nativePriceUsd: number;
  }): Promise<QuoteEdge | null> {
    const { first, second, third, gasUsdBase, gasWeiBase, nativePriceUsd } = params;
    const client = getPublicClient(first.pair.chain);

    const startAmount = first.pair.tradeSizeBase;
    if (startAmount === 0n) return null;

    const priceA = await fetchOraclePriceUsd(client, first.pair.baseToken);
    if (!priceA.priceUsd || priceA.stale) return null;

    const leg1 = await this.quoter.quoteExactInput(
      client,
      first.venue,
      startAmount,
      first.pair.baseToken.address,
      first.pair.quoteToken.address,
    );
    if (leg1.amountOut === 0n) return null;

    const leg2 = await this.quoter.quoteExactInput(
      client,
      second.venue,
      leg1.amountOut,
      second.pair.baseToken.address,
      second.pair.quoteToken.address,
    );
    if (leg2.amountOut === 0n) return null;

    const leg3 = await this.quoter.quoteExactInput(
      client,
      third.venue,
      leg2.amountOut,
      third.pair.baseToken.address,
      third.pair.quoteToken.address,
    );
    if (leg3.amountOut === 0n) return null;

    const netBase = leg3.amountOut - startAmount;
    if (netBase <= 0n) return null;

    const netBaseFloat = parseFloat(formatUnits(netBase, first.pair.baseToken.decimals));
    const netUsd = netBaseFloat * priceA.priceUsd;
    const gasUsd = gasUsdBase * 1.8; // rough multiplier for three legs
    if (gasUsd <= 0) return null;
    const pnlMultiple = netUsd / gasUsd;
    const minNet = first.pair.config.minNetUsd ?? this.fabric.global.minNetUsd;
    const pnlMin = first.pair.config.pnlMultipleMin ?? this.fabric.global.pnlMultipleMin;
    if (netUsd < minNet || pnlMultiple < pnlMin) return null;

    const id = `${first.pair.config.id}:${second.pair.config.id}:${third.pair.config.id}:${randomUUID()}`;
    const legs = [
      {
        chainId: first.pair.chain.id,
        venue: first.venue.config.id,
        poolId: first.venue.poolAddress,
        action: 'swap' as const,
        tokenIn: first.pair.baseToken.address,
        tokenOut: first.pair.quoteToken.address,
        amountIn: startAmount,
        minAmountOut: leg1.amountOut,
        feeBps: first.venue.config.feeBps,
        metadata: {
          label: first.venue.config.label,
          pair: `${first.pair.baseToken.address}->${first.pair.quoteToken.address}`,
        },
      },
      {
        chainId: second.pair.chain.id,
        venue: second.venue.config.id,
        poolId: second.venue.poolAddress,
        action: 'swap' as const,
        tokenIn: second.pair.baseToken.address,
        tokenOut: second.pair.quoteToken.address,
        amountIn: leg1.amountOut,
        minAmountOut: leg2.amountOut,
        feeBps: second.venue.config.feeBps,
        metadata: {
          label: second.venue.config.label,
          pair: `${second.pair.baseToken.address}->${second.pair.quoteToken.address}`,
        },
      },
      {
        chainId: third.pair.chain.id,
        venue: third.venue.config.id,
        poolId: third.venue.poolAddress,
        action: 'swap' as const,
        tokenIn: third.pair.baseToken.address,
        tokenOut: third.pair.quoteToken.address,
        amountIn: leg2.amountOut,
        minAmountOut: leg3.amountOut,
        feeBps: third.venue.config.feeBps,
        metadata: {
          label: third.venue.config.label,
          pair: `${third.pair.baseToken.address}->${third.pair.quoteToken.address}`,
        },
      },
    ];

    return {
      id,
      source: 'triangular',
      legs,
      sizeIn: startAmount,
      estNetUsd: netUsd,
      estGasUsd: gasUsd,
      estSlippageUsd: 0,
      estFailCostUsd: gasUsd,
      risk: {
        minNetUsd: minNet,
        pnlMultiple,
        revertProbability: this.fabric.global.revertProbability,
        inclusionP95Ms: this.fabric.global.inclusionTargetMs,
        mode: this.fabric.global.mode,
      },
      createdAtMs: Date.now(),
      tags: [
        'laf',
        'triangular',
        first.pair.config.symbol,
        second.pair.config.symbol,
        third.pair.config.symbol,
      ],
      metrics: {
        leg1Out: leg1.amountOut.toString(),
        leg2Out: leg2.amountOut.toString(),
        finalOut: leg3.amountOut.toString(),
        netBase: netBase.toString(),
        gasWei: (gasWeiBase * 2n).toString(),
      },
      metadata: {
        primaryPairId: first.pair.config.id,
        pairId: first.pair.config.id,
        pairIds: [first.pair.config.id, second.pair.config.id, third.pair.config.id],
        loopTokens: [
          first.pair.baseToken.address,
          second.pair.baseToken.address,
          third.pair.baseToken.address,
        ],
        baseToken: first.pair.baseToken.address,
        baseDecimals: first.pair.baseToken.decimals,
        nativePriceUsd,
        basePriceUsd: priceA.priceUsd,
      },
    };
  }
}
