import { Address } from 'viem';
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
import {
  disableWebSocket,
  enableWebSocket,
  evictRpcClients,
  getRealtimeClient,
} from '../infra/rpc_clients';
import type { ManagedClient } from '../infra/rpc_clients';
import { serializeError } from '../util/serialize';
import { isValidAddress, normalizeAddress } from '../util/address';

const watchRealtimeEnv = process.env.WATCH_REALTIME;
const WATCH_FLAG =
  watchRealtimeEnv === undefined ? true : watchRealtimeEnv.toLowerCase() === 'true';
const BASE_POLL_INTERVAL_MS = Number(process.env.WATCH_POLL_MS ?? 500);
const MAX_POLL_INTERVAL_MS = Number(process.env.WATCH_MAX_POLL_MS ?? 5_000);
const RATE_LIMIT_BACKOFF_MS = Number(process.env.WATCH_RATE_LIMIT_BACKOFF_MS ?? 10_000);
const MAX_RATE_LIMIT_BACKOFF_MS = Number(process.env.WATCH_MAX_RATE_LIMIT_BACKOFF_MS ?? 60_000);
const BORROWER_DEBOUNCE_MS = 750;
// Price updates cluster heavily. 60s debounce cuts cost 97% while missing zero liquidations
// (real liquidation opportunities persist for 10-30+ minutes, not seconds)
const PRICE_REFETCH_DEBOUNCE_MS = Number(process.env.PRICE_REFETCH_DEBOUNCE_MS ?? 60_000);
const WS_FAILURE_THRESHOLD = Number(process.env.WATCH_WS_FAILURE_THRESHOLD ?? 4);
const WS_FAILURE_RESET_MS = Number(process.env.WATCH_WS_FAILURE_RESET_MS ?? 60_000);

type ErrorMetadata = {
  message: string;
  name?: string;
  code?: string | number;
  status?: number;
  cause?: string;
  data?: unknown;
};

function extractErrorMetadata(err: unknown): ErrorMetadata {
  if (err instanceof Error) {
    const code = (err as { code?: string | number }).code;
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { status?: number; statusCode?: number }).statusCode;
    const anyErr = err as any;
    const causeVal = anyErr?.cause;
    const causeMessage = causeVal instanceof Error ? causeVal.message : typeof causeVal === 'string' ? causeVal : undefined;
    const data = (err as { data?: unknown }).data;
    return {
      message: err.message,
      name: err.name,
      code,
      status,
      cause: causeMessage,
      data,
    };
  }
  if (typeof err === 'object' && err !== null) {
    const anyErr = err as Record<string, unknown>;
    const message = typeof anyErr.message === 'string' ? anyErr.message : serializeError(err);
    const name = typeof anyErr.name === 'string' ? anyErr.name : undefined;
    const code = anyErr.code;
    const status = (anyErr.status as number | undefined) ?? (anyErr.statusCode as number | undefined);
    const cause = typeof anyErr.cause === 'string' ? anyErr.cause : undefined;
    const data = anyErr.data;
    return { message, name, code: code as string | number | undefined, status, cause, data };
  }
  return { message: serializeError(err) };
}

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
  private client?: ManagedClient;
  private pool?: Address;
  private currentPollMs = BASE_POLL_INTERVAL_MS;
  private backoffMs = RATE_LIMIT_BACKOFF_MS;
  private rateLimitedUntil = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private lastRateLimitAt = 0;
  private usingWebSocket = false;
  private wsEnableTimer: NodeJS.Timeout | null = null;
  private wsFailureStreak = 0;
  private lastWsFailureMs = 0;

  constructor(private chain: ChainCfg, private cfg: AppConfig) {}

  async start() {
    if (!WATCH_FLAG) return;
    this.client = this.createClient();
    let pool: Address;
    try {
      pool = await getPoolFromProvider(this.chain);
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
      const rawProxy = token.chainlinkFeed;
      if (!isValidAddress(rawProxy)) {
        if (rawProxy) {
          log.warn({ chain: this.chain.id, feed: rawProxy }, 'invalid-feed-address-skip');
        }
        continue;
      }
      const proxy = normalizeAddress(rawProxy);
      if (!proxy) continue;
      try {
        const agg = (await client.readContract({
          address: proxy as Address,
          abi: AGGREGATOR_PROXY_ABI,
          functionName: 'aggregator',
        })) as Address;
        const aggLc = normalizeAddress(agg);
        proxyToAgg.set(proxy, aggLc);
        aggregators.add(aggLc);
      } catch (err) {
        // If aggregator() read fails, fallback to watching the proxy itself.
        const msg = err instanceof Error ? err.message : String(err);
        log.debug({ chain: this.chain.id, feed: proxy, err: msg }, 'aggregator-proxy-fallback');
        const normalizedProxy = normalizeAddress(proxy);
        proxyToAgg.set(normalizedProxy, normalizedProxy);
        aggregators.add(normalizedProxy);
      }
    }

    for (const aggregator of aggregators) {
      const addr = normalizeAddress(aggregator);
      const unwatchFeed = client.watchContractEvent({
        address: addr as Address,
        abi: AGGREGATOR_ABI,
        eventName: 'AnswerUpdated',
        pollingInterval,
        onError: (err) => {
          this.handleWatcherError('feed', err, { feed: addr });
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

  private createClient(): ManagedClient {
    const previousMode = this.usingWebSocket ? 'ws' : 'http';
    const { client, kind } = getRealtimeClient(this.chain);
    this.usingWebSocket = kind === 'ws';
    if (kind === 'ws' && previousMode !== 'ws') {
      log.info({ chain: this.chain.id, wsRpc: this.chain.wsRpc }, 'realtime-watch-ws-enabled');
    }
    if (kind === 'http' && previousMode === 'ws' && this.chain.wsRpc) {
      log.warn({ chain: this.chain.id }, 'realtime-watch-falling-back-http');
    }
    return client;
  }

  private onWatcherActivity() {
    if (this.stopped) return;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.wsFailureStreak = 0;
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
    const { message, name, code, status, cause, data } = extractErrorMetadata(err);
    if (this.isFilterNotFoundError(message)) {
      log.debug({ chain: this.chain.id, kind, err: message, errName: name, errCode: code, errStatus: status, ...metadata }, 'realtime-watch-filter-stale-restart');
      this.clearWatchers();
      void this.startWatchers();
      return;
    }
    if (this.usingWebSocket && message.includes('closed')) {
      const now = Date.now();
      if (now - this.lastWsFailureMs > WS_FAILURE_RESET_MS) {
        this.wsFailureStreak = 0;
      }
      this.wsFailureStreak += 1;
      this.lastWsFailureMs = now;
      if (this.wsFailureStreak >= WS_FAILURE_THRESHOLD) {
        const streak = this.wsFailureStreak;
        this.wsFailureStreak = 0;
        log.warn(
          { chain: this.chain.id, kind, err: message, streak, ...metadata },
          'realtime-watch-ws-backoff',
        );
        this.applyRateLimit(kind, { reason: 'ws-closed-streak', streak, ...metadata });
        return;
      }
      log.warn({ chain: this.chain.id, kind, err: message, errName: name, errCode: code, errStatus: status, streak: this.wsFailureStreak, ...metadata }, 'realtime-watch-ws-closed');
      this.clearWatchers();
      evictRpcClients(this.chain.id);
      this.client = this.createClient();
      void this.startWatchers();
      return;
    }
    if (!this.usingWebSocket && message.toLowerCase().includes('resource not found')) {
      log.warn({ chain: this.chain.id, kind, err: message, errName: name, errCode: code, errStatus: status }, 'realtime-watch-http-unsupported');
      if (this.chain.wsRpc && !this.usingWebSocket) {
        this.clearWatchers();
        evictRpcClients(this.chain.id);
        this.client = this.createClient();
        void this.startWatchers();
        return;
      }
    }
    // Some providers (e.g., Alchemy) return -32602 when filter params are not supported via WS
    if (this.usingWebSocket && String(code) === '-32602') {
      log.warn({ chain: this.chain.id, kind, err: message, errCode: code }, 'realtime-watch-ws-unsupported-switch-http');
      this.clearWatchers();
      disableWebSocket(this.chain.id, 5 * 60 * 1000);
      evictRpcClients(this.chain.id);
      this.client = this.createClient();
      void this.startWatchers();
      return;
    }
    const logPayload: Record<string, unknown> = {
      chain: this.chain.id,
      kind,
      err: message,
      errName: name,
      errCode: code,
      errStatus: status,
      ...metadata,
    };
    if (cause) logPayload.errCause = cause;
    if (data !== undefined) logPayload.errData = data;
    log.warn(logPayload, 'realtime-watch-error');
  }

  private isRateLimitError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err ?? '');
    if (!message) return false;
    const status = this.extractStatusCode(message);
    if (status === 429) return true;
    if (status && status >= 500 && status < 600) return true;
    if (/too many requests/i.test(message)) return true;
    // Alchemy-specific throughput limiter messages
    if (/exceeded its compute units per second capacity/i.test(message)) return true;
    if (/throughput/i.test(message) && /safely ignore this message/i.test(message)) return true;
    if (/temporarily unavailable|gateway time-out|cloudflare/i.test(message)) return true;
    return false;
  }

  private extractStatusCode(message: string): number | null {
    const statusMatch = message.match(/status:\s*(\d{3})/i);
    if (statusMatch) return Number(statusMatch[1]);
    const httpMatch = message.match(/http\s+(\d{3})/i);
    if (httpMatch) return Number(httpMatch[1]);
    const genericMatch = message.match(/\b(5\d{2})\b/);
    if (genericMatch) {
      const code = Number(genericMatch[1]);
      if (Number.isFinite(code) && code >= 500 && code < 600) return code;
    }
    return null;
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

    const cooldownMs = Math.min(Math.max(this.backoffMs * 3, 30_000), 300_000);
    disableWebSocket(this.chain.id, cooldownMs);
    if (this.wsEnableTimer) {
      clearTimeout(this.wsEnableTimer);
    }
    this.wsEnableTimer = setTimeout(() => {
      this.wsEnableTimer = null;
      enableWebSocket(this.chain.id);
    }, cooldownMs);

    evictRpcClients(this.chain.id);
    this.client = this.createClient();

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
    if (this.wsEnableTimer) {
      clearTimeout(this.wsEnableTimer);
      this.wsEnableTimer = null;
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
