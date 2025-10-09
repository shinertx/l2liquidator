import { QuoteEdge } from '../pipeline/types';
import { PairRegistry } from './pair_registry';
import { FabricConfig } from './types';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CrossChainSolver {
  private stopped = false;

  constructor(private readonly _registry: PairRegistry, private readonly fabric: FabricConfig) {}

  stop(): void {
    this.stopped = true;
  }

  async *findCrossChainEdges(): AsyncGenerator<QuoteEdge> {
    // Placeholder generator – hooks into the main runner but yields nothing until
    // cross-chain inventory coordination is implemented.
    const interval = Math.max(1_000, this.fabric.global.pollIntervalMs);
    while (!this.stopped) {
      if (this.fabric.global.mode !== 'census') {
        await delay(interval);
        continue;
      }
      await delay(interval);
    }
  }
}
