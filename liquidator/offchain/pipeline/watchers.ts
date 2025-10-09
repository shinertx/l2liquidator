import { log } from '../infra/logger';
import type { AppConfig, ChainCfg } from '../infra/config';
import { defaultProtocolAdapter } from '../protocols/registry';
import { AsyncQueue } from './async_queue';
import type { QueuedCandidate } from './types';

const POLL_FALLBACK_MS = Number(process.env.PIPELINE_POLL_INTERVAL_MS ?? 180_000);

export type WatcherHandle = {
  queue: AsyncQueue<QueuedCandidate>;
  stop: () => void;
};

export function startCandidateWatchers(cfg: AppConfig): WatcherHandle {
  const adapter = defaultProtocolAdapter();
  const queue = new AsyncQueue<QueuedCandidate>();
  const abort = new AbortController();
  const pollTimers: NodeJS.Timeout[] = [];
  const watcherLog = log.child({ module: 'pipeline.watchers' });

  (async () => {
    try {
      for await (const candidate of adapter.streamCandidates(cfg)) {
        if (abort.signal.aborted) break;
        const chain = cfg.chains.find((c) => c.id === candidate.chainId);
        if (!chain || !chain.enabled) continue;
        queue.push({ candidate, chain, source: 'watcher' });
      }
    } catch (err) {
      watcherLog.error({ err }, 'candidate-stream-failed');
    } finally {
      queue.close();
    }
  })();

  if (POLL_FALLBACK_MS > 0) {
    for (const chain of cfg.chains.filter((c) => c.enabled)) {
      const timer = setInterval(async () => {
        if (abort.signal.aborted) return;
        try {
          const candidates = await adapter.pollCandidatesOnce(cfg, chain, 100);
          for (const candidate of candidates) {
            queue.push({ candidate, chain, source: 'poll' });
          }
        } catch (err) {
          watcherLog.debug({ chain: chain.name, err }, 'poll-candidates-failed');
        }
      }, POLL_FALLBACK_MS);
      pollTimers.push(timer);
    }
  }

  function stop() {
    if (abort.signal.aborted) return;
    abort.abort();
    for (const timer of pollTimers) clearInterval(timer);
    queue.close();
  }

  return { queue, stop };
}
