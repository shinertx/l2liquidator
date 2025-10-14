import '../infra/env';
import '../infra/metrics_server';
import { counter, histogram } from '../infra/metrics';
import { log } from '../infra/logger';
import { PairRegistry, PairRuntime } from './pair_registry';
import { SingleHopSolver } from './single_hop_solver';
import type { QuoteEdge } from '../pipeline/types';
import { logFabricConfig } from './config';
import { RiskManager } from './risk';
import { FabricExecutor } from './executor';
import { isKillSwitchActive, killSwitchPath } from '../infra/kill_switch';
import { AsyncQueue } from '../pipeline/async_queue';
import { isEdgeThrottled, recordEdgeAttempt } from './throttle';
import { TriangularSolver } from './triangular_solver';
import { CrossChainSolver } from './cross_chain_solver';
import { ensureLafAttemptTable, recordLafAttempt } from './attempts';
import { PriceGraph } from './price_graph';

const edgeCounter = counter.lafEdges;

type EdgeItem = { edge: QuoteEdge; pair: PairRuntime };

async function main(): Promise<void> {
  const registry = new PairRegistry();
  await registry.init();
  logFabricConfig(registry.fabric);
  await ensureLafAttemptTable().catch((err) => {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'laf-attempt-table-init-failed');
  });

  const pairMap = new Map<string, PairRuntime>();
  for (const pair of registry.getPairs()) {
    pairMap.set(pair.config.id, pair);
  }

  const priceGraph = new PriceGraph(registry, registry.fabric);
  priceGraph.start();

  try {
  const singleHopSolver = new SingleHopSolver(registry, registry.fabric, priceGraph);
  const triangularSolver = new TriangularSolver(registry, registry.fabric, priceGraph);
  const crossChainSolver = new CrossChainSolver(registry, registry.fabric, priceGraph);
    const risk = new RiskManager(registry.fabric);
    const executor = new FabricExecutor(registry.fabric);
    const queue = new AsyncQueue<EdgeItem>();
    const maxConcurrent = registry.fabric.global.maxConcurrentExecutions ?? 1;

    log.info(
      {
        mode: registry.fabric.global.mode,
        pairs: registry.getPairs().length,
        maxConcurrent,
      },
      'laf-runner-started',
    );

    const producers: Promise<void>[] = [];
    const streams: Array<{ name: string; generator: AsyncGenerator<QuoteEdge> }> = [];
    if (registry.fabric.global.enableSingleHop !== false) {
      streams.push({ name: 'single-hop', generator: singleHopSolver.findSingleHopEdges() });
    }
    if (registry.fabric.global.enableTriangular) {
      streams.push({ name: 'triangular', generator: triangularSolver.findTriangularEdges() });
    }
    if (registry.fabric.global.enableCrossChain) {
      streams.push({ name: 'cross-chain', generator: crossChainSolver.findCrossChainEdges() });
    }

    if (streams.length === 0) {
      log.warn('fabric-no-streams-enabled');
      queue.close();
    } else {
      let activeProducers = streams.length;
      for (const { name, generator } of streams) {
        producers.push(
          (async () => {
            try {
              for await (const edge of generator) {
                const pairId = extractPrimaryPairId(edge.metadata);
                const pair = pairId ? pairMap.get(pairId) : undefined;
                if (!pair) {
                  log.debug({ edgeId: edge.id, pairId, source: name }, 'fabric-missing-pair');
                  continue;
                }
                edgeCounter.labels({ source: edge.source }).inc();
                queue.push({ edge, pair });
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log.error({ err: message, source: name }, 'fabric-solver-failed');
            } finally {
              activeProducers -= 1;
              if (activeProducers === 0) {
                queue.close();
              }
            }
          })(),
        );
      }
    }

    const workers: Promise<void>[] = [];
    for (let i = 0; i < maxConcurrent; i += 1) {
      workers.push(consumer(queue, registry.fabric.global.mode, risk, executor));
    }
    await Promise.all([...workers, ...producers]);
  } finally {
    await priceGraph.stop();
  }
}

async function consumer(
  queue: AsyncQueue<EdgeItem>,
  mode: string,
  risk: RiskManager,
  executor: FabricExecutor,
): Promise<void> {
  for await (const item of queue) {
    const { edge, pair } = item;
    const pairId = pair.config.id;

    histogram.lafNetUsd.labels({ source: edge.source }).observe(edge.estNetUsd);
    histogram.lafPnlMultiple.labels({ source: edge.source }).observe(edge.risk.pnlMultiple);

    if (isKillSwitchActive()) {
      log.warn({ killSwitch: killSwitchPath() ?? 'env-only' }, 'fabric-kill-switch-active');
      risk.record(pair, false);
      continue;
    }

    if (mode === 'census') {
      log.info(
        {
          edgeId: edge.id,
          source: edge.source,
          estNetUsd: edge.estNetUsd,
          estGasUsd: edge.estGasUsd,
          pnlMultiple: edge.risk.pnlMultiple,
          legs: edge.legs.map((leg) => ({
            action: leg.action,
            venue: leg.venue,
            amountIn: leg.amountIn.toString(),
            minOut: leg.minAmountOut?.toString(),
          })),
        },
        'laf-edge-census',
      );
      continue;
    }

    const assessment = risk.evaluate(edge, pair);
    if (!assessment.ok) {
      log.debug(
        {
          edgeId: edge.id,
          pairId: pair.config.id,
          reason: assessment.reason,
          detail: assessment.detail,
        },
        'fabric-risk-skip',
      );
      risk.record(pair, false);
      continue;
    }

    if (mode !== 'census') {
      const throttled = await isEdgeThrottled(pair.chain.id, pairId);
      if (throttled) {
        log.debug({ edgeId: edge.id, pairId }, 'fabric-throttled');
        risk.record(pair, false);
        await recordLafAttempt({
          chainId: pair.chain.id,
          pairId,
          source: edge.source,
          status: 'throttled',
          netUsd: edge.estNetUsd,
          metadata: edge.metadata ?? undefined,
        });
        continue;
      }
      await recordEdgeAttempt(pair.chain.id, pairId);
      await recordLafAttempt({
        chainId: pair.chain.id,
        pairId,
        source: edge.source,
        status: 'queued',
        netUsd: edge.estNetUsd,
        metadata: edge.metadata ?? undefined,
      });
    }

    const hash = await executor.executeEdge(edge, pair);
    risk.record(pair, hash !== null);
    if (mode !== 'census') {
      await recordLafAttempt({
        chainId: pair.chain.id,
        pairId,
        source: edge.source,
        status: hash ? 'sent' : 'error',
        txHash: hash ?? undefined,
        netUsd: edge.estNetUsd,
        metadata: edge.metadata ?? undefined,
      });
    }
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ err: message }, 'laf-runner-fatal');
  process.exitCode = 1;
});

function extractPrimaryPairId(metadata: QuoteEdge['metadata']): string | undefined {
  if (!metadata) return undefined;
  const primary = metadata.pairId ?? metadata.primaryPairId;
  if (typeof primary === 'string' && primary.length > 0) {
    return primary;
  }
  if (Array.isArray(metadata.pairIds) && metadata.pairIds.length > 0) {
    const first = metadata.pairIds[0];
    if (typeof first === 'string') return first;
  }
  return undefined;
}
