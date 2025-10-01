import { Address, createPublicClient, http } from 'viem';
import assert from 'assert';
import type { ChainCfg, AppConfig } from '../infra/config';
import { log } from '../infra/logger';
import { getPoolFromProvider } from '../infra/aave_provider';
import {
  Candidate,
  fetchBorrowerCandidates,
  pollChainCandidatesOnce,
} from '../indexer/aave_indexer';

const watchRealtimeEnv = process.env.WATCH_REALTIME;
const WATCH_FLAG =
  watchRealtimeEnv === undefined ? true : watchRealtimeEnv.toLowerCase() === 'true';
const POLLING_INTERVAL_MS = 150;
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

  constructor(private chain: ChainCfg, private cfg: AppConfig) {}

  async start() {
    if (!WATCH_FLAG) return;

    const client = createPublicClient({ transport: http(this.chain.rpc) });
    let pool: Address;
    try {
      pool = await getPoolFromProvider(this.chain.rpc, this.chain.aaveProvider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ chain: this.chain.id, err: message }, 'realtime-pool-lookup-failed');
      return;
    }

    const allowedEvents = new Set(['Borrow', 'Repay', 'Supply', 'Withdraw', 'LiquidationCall']);

    const unwatchPool = client.watchContractEvent({
      address: pool,
      abi: POOL_EVENTS_ABI,
      pollingInterval: POLLING_INTERVAL_MS,
      onError: (err) => {
        log.warn({ chain: this.chain.id, err: err?.message }, 'realtime-pool-watch-error');
      },
      onLogs: (logs) => {
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

    const feeds = new Set<string>();
    for (const token of Object.values(this.chain.tokens ?? {})) {
      if (token.chainlinkFeed) {
        feeds.add(token.chainlinkFeed.toLowerCase());
      }
    }

    for (const feed of feeds) {
      const unwatchFeed = client.watchContractEvent({
        address: feed as Address,
        abi: AGGREGATOR_ABI,
        eventName: 'AnswerUpdated',
        pollingInterval: POLLING_INTERVAL_MS,
        onError: (err) => {
          log.warn({ chain: this.chain.id, feed, err: err?.message }, 'realtime-feed-watch-error');
        },
        onLogs: () => {
          const now = Date.now();
          if (now - this.lastPriceRefetch < PRICE_REFETCH_DEBOUNCE_MS) return;
          this.lastPriceRefetch = now;
          // TODO: surface price magnitude in trigger so policy can tighten when volatility spikes.
          void refetchChainCandidates(this.cfg, this.chain, `price:${feed}`, this.queue);
        },
      });
      this.unwatchers.push(unwatchFeed);
    }
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
    for (const unwatch of this.unwatchers) {
      try {
        unwatch();
      } catch (err) {
        log.warn({ chain: this.chain.id, err: (err as Error).message }, 'realtime-unwatch-failed');
      }
    }
    this.unwatchers = [];
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
