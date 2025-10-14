import { log } from '../infra/logger';
import type { AppConfig, ChainCfg } from '../infra/config';
import { pollChainCandidatesOnce, type Candidate } from '../indexer/aave_indexer';
import { counter } from '../infra/metrics';

type PredictiveCallback = (candidate: Candidate) => Promise<void>;

const SCAN_INTERVAL_MS = Number(process.env.PREDICTIVE_SCAN_INTERVAL_MS ?? 30_000);
const MIN_DROP = Number(process.env.PREDICTIVE_MIN_DROP ?? 0.015);
const MIN_SLOPE = Number(process.env.PREDICTIVE_MIN_SLOPE ?? 0.00005);
const HF_CEILING = Number(process.env.PREDICTIVE_HF_CEILING ?? 1.12);
const HF_FLOOR = Number(process.env.PREDICTIVE_HF_FLOOR ?? 0.98);
const COOLDOWN_MS = Number(process.env.PREDICTIVE_COOLDOWN_MS ?? 4 * 60 * 1000);
const MAX_FETCH = Number(process.env.PREDICTIVE_MAX_FETCH ?? 300);

export type PredictiveHandle = {
  stop(): void;
};

export function startPredictiveScanner(
  chain: ChainCfg,
  cfg: AppConfig,
  onCandidate: PredictiveCallback
): PredictiveHandle {
  const scanner = new PredictiveScanner(chain, cfg, onCandidate);
  scanner.start();
  return {
    stop: () => scanner.stop(),
  };
}

class PredictiveScanner {
  private timer?: NodeJS.Timeout;
  private processing = false;
  private running = false;
  private readonly history = new Map<string, { hf: number; ts: number }>();
  private readonly cooldown = new Map<string, number>();

  constructor(
    private readonly chain: ChainCfg,
    private readonly cfg: AppConfig,
    private readonly onCandidate: PredictiveCallback
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick().catch((err) => {
      log.warn(
        { chain: this.chain.name, err: (err as Error).message },
        'predictive-scan-initial-error'
      );
    });
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        log.debug(
          { chain: this.chain.name, err: (err as Error).message },
          'predictive-scan-error'
        );
      });
    }, SCAN_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.processing) return;
    this.processing = true;
    try {
      const candidates = await pollChainCandidatesOnce(this.cfg, this.chain, MAX_FETCH);
      const now = Date.now();
      for (const candidate of candidates) {
        if (!Number.isFinite(candidate.healthFactor)) continue;
        if (candidate.healthFactor <= HF_FLOOR) continue;
        if (candidate.healthFactor > HF_CEILING) continue;

        const id = candidate.borrower.toLowerCase();
        const last = this.history.get(id);
        if (last) {
          const drop = last.hf - candidate.healthFactor;
          const elapsedSec = (now - last.ts) / 1000;
          if (drop > MIN_DROP && elapsedSec > 0) {
            const slope = drop / elapsedSec;
            if (slope >= MIN_SLOPE) {
              const lastTrigger = this.cooldown.get(id) ?? 0;
              if (now - lastTrigger >= COOLDOWN_MS) {
                this.cooldown.set(id, now);
                counter.predictiveQueued.inc({ chain: this.chain.name });
                await this.onCandidate(candidate);
              }
            }
          }
        }
        this.history.set(id, { hf: candidate.healthFactor, ts: now });
      }
    } catch (err) {
      throw err;
    } finally {
      this.processing = false;
    }
  }
}
