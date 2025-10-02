import { Address, createPublicClient, http, webSocket } from 'viem';
import assert from 'assert';
import type { ChainCfg, AppConfig } from '../infra/config';
import { log } from '../infra/logger';
import { getPoolFromProvider } from '../infra/aave_provider';
import {
  Candidate,
  fetchBorrowerCandidates,
  pollChainCandidatesOnce,
} from '../indexer/aave_indexer';
import { invalidateOracleFeed } from '../indexer/price_watcher';
import { recordFeedUpdate } from './oracle_predictor';

const watchRealtimeEnv = process.env.WATCH_REALTIME;
const WATCH_FLAG =
  watchRealtimeEnv === undefined ? true : watchRealtimeEnv.toLowerCase() === 'true';
const BASE_POLL_INTERVAL_MS = Number(process.env.WATCH_POLL_MS ?? 500);
const MAX_POLL_INTERVAL_MS = Number(process.env.WATCH_MAX_POLL_MS ?? 5_000);
const RATE_LIMIT_BACKOFF_MS = Number(process.env.WATCH_RATE_LIMIT_BACKOFF_MS ?? 10_000);
const MAX_RATE_LIMIT_BACKOFF_MS = Number(process.env.WATCH_MAX_RATE_LIMIT_BACKOFF_MS ?? 60_000);
const BORROWER_DEBOUNCE_MS = 750;
const PRICE_REFETCH_DEBOUNCE_MS = 2_000;

const POOL_EVENTS_ABI = [
  {
    type: 'event',
    name: 'Borrow',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: false },
      { name: 'onBehalfOf', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'interestRateMode', type: 'uint8', indexed: false },
      { name: 'borrowRate', type: 'uint256', indexed: false },
      { name: 'referralCode', type: 'uint16', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Repay',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'repayer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'useATokens', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Supply',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'onBehalfOf', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'referralCode', type: 'uint16', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdraw',
    inputs: [
      { name: 'reserve', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'LiquidationCall',
    inputs: [
      { name: 'collateralAsset', type: 'address', indexed: true },
      { name: 'debtAsset', type: 'address', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'debtToCover', type: 'uint256', indexed: false },
      { name: 'liquidatedCollateralAmount', type: 'uint256', indexed: false },
      { name: 'liquidator', type: 'address', indexed: false },
      { name: 'receiveAToken', type: 'bool', indexed: false },
    ],
  },
] as const;

const AGGREGATOR_ABI = [
  {
    type: 'event',
    name: 'AnswerUpdated',
    inputs: [
      { name: 'current', type: 'int256', indexed: true },
      { name: 'roundId', type: 'uint256', indexed: true },
      { name: 'updatedAt', type: 'uint256', indexed: false },
    ],
  },
] as const;

const AGGREGATOR_PROXY_ABI = [
  {
    type: 'function',
    name: 'aggregator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

export type RealtimeCandidate = Candidate & {
  __source: 'realtime';
  __trigger: string;
};

class CandidateQueue {
  private items: RealtimeCandidate[] = [];
  private waiters: Array<{ resolve: (value: RealtimeCandidate) => void; reject: (err: Error) => void }> = [];
  private closed = false;

  push(item: RealtimeCandidate) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
    } else {
      this.items.push(item);
    }
  }

  tryShift(): RealtimeCandidate | null {
    return this.items.shift() ?? null;
  }

  next(): Promise<RealtimeCandidate> {
    if (this.closed) {
      return Promise.reject(new Error('queue closed'));
    }
    const immediate = this.tryShift();
    if (immediate) {
      return Promise.resolve(immediate);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  shutdown(error = new Error('queue closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
    this.items = [];
  }
}

export interface ChainRealtimeWatcher {
  next(): Promise<RealtimeCandidate>;
  tryShift(): RealtimeCandidate | null;
  stop(): void;
}

function resolveBorrowerFromEvent(args: Record<string, any>): Address | null {
  if (args.user && typeof args.user === 'string') return args.user as Address;
  if (args.onBehalfOf && typeof args.onBehalfOf === 'string') return args.onBehalfOf as Address;
  return null;
}

async function fetchAndEnqueueBorrower(
  cfg: AppConfig,
  chain: ChainCfg,
  borrower: Address,
  trigger: string,
  queue: CandidateQueue
) {
  const candidates = await fetchBorrowerCandidates(cfg, chain, borrower);
  for (const candidate of candidates) {
    queue.push({ ...(candidate as Candidate), __source: 'realtime', __trigger: trigger });
  }
}

async function refetchChainCandidates(
  cfg: AppConfig,
  chain: ChainCfg,
  trigger: string,
  queue: CandidateQueue
) {
  const candidates = await pollChainCandidatesOnce(cfg, chain);
  for (const candidate of candidates) {
    queue.push({ ...(candidate as Candidate), __source: 'realtime', __trigger: trigger });
  }
}

class ChainWatcher implements ChainRealtimeWatcher {
  private queue = new CandidateQueue();
  private unwatchers: Array<() => void> = [];
  private borrowerSeenAt = new Map<string, number>();
  private lastPriceRefetch = 0;
  private stopped = false;
  private client?: ReturnType<typeof createPublicClient>;
  private pool?: Address;
  private currentPollMs = BASE_POLL_INTERVAL_MS;
  private backoffMs = RATE_LIMIT_BACKOFF_MS;
  private rateLimitedUntil = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private lastRateLimitAt = 0;
  private usingWebSocket = false;

  constructor(private chain: ChainCfg, private cfg: AppConfig) {}

  async start() {
    if (!WATCH_FLAG) return;
    this.client = this.createClient();
    let pool: Address;
    try {
      pool = await getPoolFromProvider(this.chain.rpc, this.chain.aaveProvider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ chain: this.chain.id, err: message }, 'realtime-pool-lookup-failed');
      return;
    }
    this.pool = pool;

    await this.startWatchers();
  }

  private async startWatchers(): Promise<void> {
    if (!WATCH_FLAG || this.stopped) return;
    if (!this.client || !this.pool) return;
    if (this.unwatchers.length > 0) return;

    this.rateLimitedUntil = 0;

    const client = this.client;
    const pollingInterval = Math.min(Math.max(this.currentPollMs, BASE_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS);

    const allowedEvents = new Set(['Borrow', 'Repay', 'Supply', 'Withdraw', 'LiquidationCall']);

    const unwatchPool = client.watchContractEvent({
      address: this.pool,
      abi: POOL_EVENTS_ABI,
      pollingInterval,
      onError: (err) => {
        this.handleWatcherError('pool', err);
      },
      onLogs: (logs) => {
        this.onWatcherActivity();
        for (const logItem of logs) {
          const eventName = String(logItem.eventName ?? '');
          if (!allowedEvents.has(eventName)) continue;
          const borrower = resolveBorrowerFromEvent(logItem.args ?? {});
          if (!borrower) continue;
          const key = borrower.toLowerCase();
          const now = Date.now();
          const last = this.borrowerSeenAt.get(key) ?? 0;
          if (now - last < BORROWER_DEBOUNCE_MS) continue;
          this.borrowerSeenAt.set(key, now);
          void fetchAndEnqueueBorrower(this.cfg, this.chain, borrower, `pool:${eventName}`, this.queue);
        }
      },
    });
    this.unwatchers.push(unwatchPool);

    const proxyToAgg = new Map<string, string>();
    const aggregators = new Set<string>();
    for (const token of Object.values(this.chain.tokens ?? {})) {
      const proxy = token.chainlinkFeed?.toLowerCase();
      if (!proxy) continue;
      try {
        const agg = (await client.readContract({
          address: proxy as Address,
          abi: AGGREGATOR_PROXY_ABI,
          functionName: 'aggregator',
        })) as Address;
        const aggLc = agg.toLowerCase();
        proxyToAgg.set(proxy, aggLc);
        aggregators.add(aggLc);
      } catch (err) {
        log.debug({ chain: this.chain.id, feed: proxy, err: (err as Error).message }, 'aggregator-proxy-fallback');
        proxyToAgg.set(proxy, proxy);
        aggregators.add(proxy);
      }
    }

    for (const aggregator of aggregators) {
      const unwatchFeed = client.watchContractEvent({
        address: aggregator as Address,
        abi: AGGREGATOR_ABI,
        eventName: 'AnswerUpdated',
        pollingInterval,
        onError: (err) => {
          this.handleWatcherError('feed', err, { feed: aggregator });
        },
        onLogs: (logs) => {
          const now = Date.now();
          if (now - this.lastPriceRefetch < PRICE_REFETCH_DEBOUNCE_MS) return;
          let tickTimestamp = now;
          if (logs.length > 0) {
            const first = logs[logs.length - 1];
            const raw = (first.args as any)?.updatedAt ?? (first.args as any)?.[2];
            if (typeof raw === 'bigint') {
              const asNumber = Number(raw);
              if (Number.isFinite(asNumber) && asNumber > 0) {
                tickTimestamp = asNumber * 1000;
              }
            }
          }
          this.lastPriceRefetch = now;
          this.onWatcherActivity();
          for (const [proxy, agg] of proxyToAgg.entries()) {
            if (agg === aggregator) {
              invalidateOracleFeed(proxy);
              recordFeedUpdate(proxy, tickTimestamp);
            }
          }
          // TODO: surface price magnitude in trigger so policy can tighten when volatility spikes.
          void refetchChainCandidates(this.cfg, this.chain, `price:${aggregator}`, this.queue);
        },
      });
      this.unwatchers.push(unwatchFeed);
    }
  }

  private createClient() {
    if (this.client) return this.client;
    if (this.chain.wsRpc) {
      try {
        const transport = webSocket(this.chain.wsRpc, {
          retryCount: Number(process.env.WATCH_WS_RETRY_COUNT ?? 10),
          retryDelay: Number(process.env.WATCH_WS_RETRY_DELAY_MS ?? 1_000),
        });
        const client = createPublicClient({ transport });
        this.usingWebSocket = true;
        log.info({ chain: this.chain.id, wsRpc: this.chain.wsRpc }, 'realtime-watch-ws-enabled');
        return client;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ chain: this.chain.id, err: message, wsRpc: this.chain.wsRpc }, 'realtime-watch-ws-init-failed');
      }
    }
    this.usingWebSocket = false;
    const fallbackClient = createPublicClient({ transport: http(this.chain.rpc) });
    if (this.chain.wsRpc) {
      log.warn({ chain: this.chain.id }, 'realtime-watch-falling-back-http');
    }
    return fallbackClient;
  }

  private onWatcherActivity() {
    if (this.stopped) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (Date.now() - this.lastRateLimitAt > this.backoffMs) {
      this.backoffMs = RATE_LIMIT_BACKOFF_MS;
    }
    if (this.currentPollMs > BASE_POLL_INTERVAL_MS) {
      this.currentPollMs = Math.max(BASE_POLL_INTERVAL_MS, Math.floor(this.currentPollMs / 2));
    }
  }

  private handleWatcherError(kind: 'pool' | 'feed', err: unknown, metadata: Record<string, unknown> = {}) {
    if (this.isRateLimitError(err)) {
      this.applyRateLimit(kind, metadata);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (this.isFilterNotFoundError(message)) {
      log.debug({ chain: this.chain.id, kind, err: message, ...metadata }, 'realtime-watch-filter-stale-restart');
      this.clearWatchers();
      void this.startWatchers();
      return;
    }
    if (this.usingWebSocket && message.includes('closed')) {
      // Attempt to recreate websocket transport once before complaining loudly
      log.warn({ chain: this.chain.id, kind, err: message }, 'realtime-watch-ws-closed');
      this.clearWatchers();
      this.client = undefined;
      this.client = this.createClient();
      void this.startWatchers();
      return;
    }
    if (!this.usingWebSocket && message.toLowerCase().includes('resource not found')) {
      log.warn({ chain: this.chain.id, kind, err: message }, 'realtime-watch-http-unsupported');
      if (this.chain.wsRpc && !this.usingWebSocket) {
        this.clearWatchers();
        this.client = undefined;
        this.client = this.createClient();
        void this.startWatchers();
        return;
      }
    }
    log.warn({ chain: this.chain.id, kind, err: message, ...metadata }, 'realtime-watch-error');
  }

  private isRateLimitError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err ?? '');
    if (!message) return false;
    return message.includes('429') || /too many requests/i.test(message);
  }

  private isFilterNotFoundError(message: string): boolean {
    return /filter not found/i.test(message);
  }

  private applyRateLimit(kind: 'pool' | 'feed', metadata: Record<string, unknown>) {
    const now = Date.now();
    if (now < this.rateLimitedUntil) {
      return;
    }
    this.lastRateLimitAt = now;
    this.rateLimitedUntil = now + this.backoffMs;
    log.warn({
      chain: this.chain.id,
      kind,
      pollMs: this.currentPollMs,
      backoffMs: this.backoffMs,
      ...metadata,
    }, 'realtime-rate-limited');
    this.clearWatchers();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }
    const delay = this.backoffMs;
    const nextPoll = Math.min(this.currentPollMs * 2, MAX_POLL_INTERVAL_MS);
    const nextBackoff = Math.min(this.backoffMs * 2, MAX_RATE_LIMIT_BACKOFF_MS);
    this.currentPollMs = nextPoll;
    this.backoffMs = nextBackoff;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      this.clearWatchers();
      void this.startWatchers();
    }, delay);
  }

  private clearWatchers() {
    for (const unwatch of this.unwatchers) {
      try {
        unwatch();
      } catch (err) {
        log.warn({ chain: this.chain.id, err: (err as Error).message }, 'realtime-unwatch-failed');
      }
    }
    this.unwatchers = [];
  }

  next(): Promise<RealtimeCandidate> {
    return this.queue.next();
  }

  tryShift(): RealtimeCandidate | null {
    return this.queue.tryShift();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearWatchers();
    this.queue.shutdown(new Error('realtime watcher stopped'));
  }
}

export async function createChainWatcher(chain: ChainCfg, cfg: AppConfig): Promise<ChainRealtimeWatcher | null> {
  if (!WATCH_FLAG) return null;
  assert(chain.enabled, 'chain must be enabled for realtime watcher');
  const watcher = new ChainWatcher(chain, cfg);
  await watcher.start();
  return watcher;
}
