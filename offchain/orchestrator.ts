import './infra/env';
import './infra/metrics_server';
import { Address } from 'viem';
import { performance } from 'perf_hooks';
import { loadConfig, liquidatorForChain, ChainCfg, AppConfig, TokenInfo, ProtocolKey } from './infra/config';
import { executorAddressForChain, privateKeyForChain } from './infra/accounts';
import { log } from './infra/logger';
import { counter, gauge, histogram } from './infra/metrics';
import { isThrottled, recordAttempt as recordThrottleAttempt, resetThrottle } from './infra/throttle';
import { loadBorrowerIntel, storeBorrowerIntel } from './infra/borrower_intel';
import { ensureAttemptTable, recordAttemptRow } from './infra/attempts';
import { type Candidate, requestIndexerBoost, fetchBorrowerCandidates, type AaveIndexerOptions } from './indexer/aave_indexer';
import { oracleDexGapBps, oraclePriceUsd, dexPriceRatio } from './indexer/price_watcher';
import type { SimPlan } from './protocols/types';
import { sendLiquidation } from './executor/send_tx';
import type { BuildArgs } from './executor/build_tx';
import { getPoolFromProvider, logPoolsAtBoot } from './infra/aave_provider';
import { buildRouteOptions } from './util/routes';
import { serializeCandidate, serializePlan } from './util/serialize';
import { lookupAssetPolicy, lookupToken, symbolsEqual } from './util/symbols';
import { normalizeDropReason } from './util/drop_reason';
import { emitAlert } from './infra/alerts';
import { checkSequencerStatus } from './infra/sequencer';
import { createChainWatcher } from './realtime/watchers';
import { shouldPrecommit } from './realtime/oracle_predictor';
import { startPredictiveScanner } from './realtime/predictive_scanner';
import { isKillSwitchActive, killSwitchPath } from './infra/kill_switch';
import { getPublicClient } from './infra/rpc_clients';
import type { ManagedClient } from './infra/rpc_clients';
import { AdaptiveThresholdsProvider } from './infra/adaptive_thresholds_provider';
import { defaultProtocolAdapter, getProtocolAdapter } from './protocols/registry';

const DEFAULT_CLOSE_FACTOR_BPS = 5000;
const DEFAULT_BONUS_BPS = 800;
const WAD = 10n ** 18n;
const SEQUENCER_STALE_SECONDS = (() => {
  const raw = process.env.SEQUENCER_STALE_SECS;
  if (!raw) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed;
})();
const SEQUENCER_RECOVERY_GRACE_SECONDS = 120;
const AUTO_STOP_ON_FAIL_RATE = process.env.FAIL_RATE_AUTO_STOP === '1';
const INVENTORY_MODE = process.env.INVENTORY_MODE !== '0';
const INVENTORY_REFRESH_MS = Number(process.env.INVENTORY_REFRESH_MS ?? 10_000);
const STALL_POLL_TRIGGER = Number(process.env.STALL_POLL_TRIGGER ?? 3);
const STALL_BOOST_DURATION_MS = Number(process.env.STALL_BOOST_DURATION_MS ?? 5 * 60 * 1000);
const STALL_BOOST_EXTRA_HF = Number(process.env.STALL_BOOST_EXTRA_HF ?? 0.005);
const STALL_BOOST_MIN_HF = Number(process.env.STALL_BOOST_MIN_HF ?? 1.005);
const STALL_BOOST_FIRST_MULTIPLIER = Number(process.env.STALL_BOOST_FIRST_MULTIPLIER ?? 1.5);
const POLICY_RETRY_ENABLED = process.env.POLICY_RETRY_ENABLED !== '0';
const POLICY_RETRY_MAX_ATTEMPTS = Math.max(0, Number(process.env.POLICY_RETRY_MAX_ATTEMPTS ?? 6));
const POLICY_RETRY_BASE_DELAY_MS = Math.max(1_000, Number(process.env.POLICY_RETRY_BASE_DELAY_MS ?? 5_000));
const POLICY_RETRY_MAX_DELAY_MS = Math.max(POLICY_RETRY_BASE_DELAY_MS, Number(process.env.POLICY_RETRY_MAX_DELAY_MS ?? 60_000));
const POLICY_RETRY_HF_MARGIN = Math.max(0, Number(process.env.POLICY_RETRY_HF_MARGIN ?? 0.06));
const POLICY_RETRY_JITTER_MS = Math.max(0, Number(process.env.POLICY_RETRY_JITTER_MS ?? 1_000));
const POLICY_RETRY_RESCHEDULE_GUARD_MS = Math.max(0, Number(process.env.POLICY_RETRY_RESCHEDULE_GUARD_MS ?? 5_000));
const POLICY_RETRY_IMPROVEMENT_EPS = Math.max(0, Number(process.env.POLICY_RETRY_IMPROVEMENT_EPS ?? 0.005));
const PEGGED_GAP_CAP_BPS = Number(process.env.PEGGED_GAP_CAP_BPS ?? 120);
const MISSING_PLACEHOLDER = '\u0000MISSING:';

function normalizeTokenSymbol(symbol?: string): string | null {
  if (!symbol) return null;
  return symbol.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

const PEGGED_PAIR_KEYS = new Set([
  'ETH-WSTETH',
  'WETH-WSTETH',
  'WSTETH-WETH',
  'WETH-RETH',
  'RETH-WETH',
  'WETH-CBETH',
  'CBETH-WETH',
  'WETH-SFRXETH',
  'SFRXETH-WETH',
  'WMATIC-MATICX',
  'MATICX-WMATIC',
  'WPOL-MATICX',
  'MATICX-WPOL',
]);

function isPeggedPairSymbol(a?: string, b?: string): boolean {
  const na = normalizeTokenSymbol(a);
  const nb = normalizeTokenSymbol(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const forward = `${na}-${nb}`;
  if (PEGGED_PAIR_KEYS.has(forward)) return true;
  const reverse = `${nb}-${na}`;
  return PEGGED_PAIR_KEYS.has(reverse);
}

type CandidateStreamState = {
  iterator: AsyncIterator<Candidate>;
  next: Promise<{ idx: number; res: IteratorResult<Candidate> }> | null;
};

function queueNext(states: CandidateStreamState[], idx: number): void {
  const iterator = states[idx].iterator;
  states[idx].next = iterator
    .next()
    .then((res) => ({ idx, res }))
    .catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'candidate-stream-error');
      return { idx, res: { done: true, value: undefined } as IteratorResult<Candidate> };
    });
}

async function* mergeCandidateStreams(streams: AsyncIterable<Candidate>[]): AsyncGenerator<Candidate> {
  const states: CandidateStreamState[] = streams.map((generator) => {
    const iterator = generator[Symbol.asyncIterator]();
    return { iterator, next: null };
  });
  states.forEach((_, idx) => queueNext(states, idx));

  try {
    while (true) {
      const active = states.filter((state) => state.next !== null);
      if (active.length === 0) {
        return;
      }
      const { idx, res } = await Promise.race(active.map((state) => state.next!));
      if (res.done) {
        states[idx].next = null;
        continue;
      }
      queueNext(states, idx);
      yield res.value;
    }
  } finally {
    await Promise.allSettled(
      states.map(async ({ iterator }) => {
        if (typeof iterator.return === 'function') {
          try {
            await iterator.return();
          } catch (err) {
            log.debug({ err: err instanceof Error ? err.message : String(err) }, 'candidate-stream-return-failed');
          }
        }
      })
    );
  }
}

function recordCandidateDrop(chainName: string, code: string | null | undefined): void {
  const normalized = normalizeDropReason(code)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
  counter.candidateDrops.labels({ chain: chainName, reason: normalized }).inc();
}

const AAVE_POOL_ABI = [
  {
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
] as const;

// --- Global State ---
const pools = new Map<number, Address>();
const inventoryCache = new Map<string, { balance: bigint; fetchedAt: number }>();
const adaptiveThresholds = new AdaptiveThresholdsProvider(process.env.RISK_ENGINE_URL);

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

// Global counters for overall system monitoring
let plansReadyCount = 0;
let plansSentCount = 0;
let plansErrorCount = 0;
let sessionNotionalUsd = 0;

// Global alert cooldown
let lastFailAlertMs = 0;
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

// --- Helper Functions ---

async function poolAddress(chain: ChainCfg): Promise<Address> {
  const cached = pools.get(chain.id);
  if (cached) return cached;
  const pool = await getPoolFromProvider(chain);
  pools.set(chain.id, pool);
  return pool;
}

function wadToFloat(value: bigint): number {
  if (value === 0n) return 0;
  return Number(value) / Number(WAD);
}

function publicClient(chain: ChainCfg): ManagedClient {
  return getPublicClient(chain);
}

async function inventoryBalance(
  chain: ChainCfg,
  token: TokenInfo,
  contract: Address,
  client: ManagedClient
): Promise<bigint> {
  const key = `${chain.id}:${token.address.toLowerCase()}`;
  const now = Date.now();
  const cached = inventoryCache.get(key);
  if (cached && now - cached.fetchedAt < INVENTORY_REFRESH_MS) {
    return cached.balance;
  }
  const balance = (await client.readContract({
    address: token.address as Address,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [contract],
  })) as bigint;
  inventoryCache.set(key, { balance, fetchedAt: now });
  return balance;
}

function summarizeRouteCoverage(cfg: AppConfig): void {
  (gauge.routeOptions as any).reset?.();
  (gauge.protocolMarkets as any).reset?.();

  const warnings: Array<{ chain: string; pair: string; routes: string[]; reason: string }> = [];
  const protocolCounts = new Map<string, number>();
  for (const market of cfg.markets.filter((m) => m.enabled)) {
    const chain = cfg.chains.find((c) => c.id === market.chainId);
    if (!chain || !chain.enabled) continue;
    const pair = `${market.debtAsset}-${market.collateralAsset}`.toUpperCase();
    const { options } = buildRouteOptions(cfg, chain, market.debtAsset, market.collateralAsset);
    const routeTypes = Array.from(new Set(options.map((option) => option.type))).sort();
    gauge.routeOptions.labels({ chain: chain.name, pair }).set(options.length);
    log.debug({ chain: chain.name, pair, routes: routeTypes, optionCount: options.length }, 'route-coverage');
    if (options.length === 0) {
      warnings.push({ chain: chain.name, pair, routes: routeTypes, reason: 'no-routes' });
      continue;
    }
    const isWpolPair =
      market.debtAsset.toUpperCase().includes('WPOL') ||
      market.collateralAsset.toUpperCase().includes('WPOL');
    if (isWpolPair) {
      const debtToken = chain.tokens?.[market.debtAsset];
      const collateralToken = chain.tokens?.[market.collateralAsset];
      const sameAddress =
        debtToken?.address?.toLowerCase() === collateralToken?.address?.toLowerCase();
      if (sameAddress) {
        continue;
      }
      const hasAltDepth = routeTypes.some((type) => type !== 'UniV3');
      const hasMultiHop = routeTypes.includes('UniV3Multi');
      if (options.length < 2 || (!hasAltDepth && !hasMultiHop)) {
        warnings.push({ chain: chain.name, pair, routes: routeTypes, reason: 'wpol-low-depth' });
      }
    }

    const protocolLabel = market.protocol ?? 'unknown';
    const key = `${protocolLabel}::${chain.name}`;
    protocolCounts.set(key, (protocolCounts.get(key) ?? 0) + 1);
  }

  for (const [key, count] of protocolCounts.entries()) {
    const [protocol, chain] = key.split('::');
    gauge.protocolMarkets.labels({ protocol, chain }).set(count);
  }

  for (const warning of warnings) {
    log.warn(warning, 'route-coverage-warning');
  }
}

// --- Chain Agent --- 

async function runChainAgent(chain: ChainCfg, cfg: AppConfig) {
  const defaultAdapter = defaultProtocolAdapter();
  const defaultProtocolKey = defaultAdapter.key as ProtocolKey;
  const agentLog = log.child({ chain: chain.name, chainId: chain.id });
  agentLog.info('starting agent');

  const protocolAdapters = new Map<ProtocolKey, ReturnType<typeof getProtocolAdapter>>();
  protocolAdapters.set(defaultProtocolKey, defaultAdapter);
  const protocolKeysForChain = new Set<ProtocolKey>(
    cfg.markets
      .filter((m) => m.enabled && m.chainId === chain.id)
      .map((m) => m.protocol)
  );

  const streamGenerators: AsyncIterable<Candidate>[] = [defaultAdapter.streamCandidates(cfg)];
  for (const protocol of protocolKeysForChain) {
    if (protocol === defaultProtocolKey) continue;
    try {
      const adapter = getProtocolAdapter(protocol);
      protocolAdapters.set(protocol, adapter);
      streamGenerators.push(adapter.streamCandidates(cfg));
    } catch (err) {
      agentLog.warn({ protocol, err: (err as Error).message }, 'protocol-stream-init-failed');
    }
  }

  const candidateIterator = mergeCandidateStreams(streamGenerators)[Symbol.asyncIterator]();
  let subgraphPromise = candidateIterator.next();
  const realtimeWatcher = await createChainWatcher(chain, cfg);
  let killSwitchNotificationSent = false;
  let consecutiveStallPolls = 0;
  let stallBoostActiveUntil = 0;
  // Heartbeat & stall detection state
  const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 60_000);
  const STALL_POLL_INTERVAL_MS = Number(process.env.STALL_POLL_INTERVAL_MS ?? 120_000);
  type PolicyRetryState = {
    borrower: `0x${string}`;
    attempts: number;
    nextAttemptMs: number;
    lastHealthFactor: number;
    lastHfMax: number;
    protocol: ProtocolKey;
  };
  const policyRetryQueue = new Map<string, PolicyRetryState>();
  let lastActivityMs = Date.now();
  const startMs = lastActivityMs;
  function markActivity() { lastActivityMs = Date.now(); }
  markActivity();
  let radiantIndexerWarningLogged = false;

  const resolveIndexerOptions = (protocol: ProtocolKey): Partial<AaveIndexerOptions> | undefined => {
    if (protocol === 'radiant') {
      const radiantSubgraph = process.env.RADIANT_SUBGRAPH_ARB;
      if (!radiantSubgraph || radiantSubgraph.includes(MISSING_PLACEHOLDER) || radiantSubgraph.trim().length === 0) {
        if (!radiantIndexerWarningLogged) {
          agentLog.warn({ env: 'RADIANT_SUBGRAPH_ARB' }, 'radiant-subgraph-missing');
          radiantIndexerWarningLogged = true;
        }
        return undefined;
      }
      return {
        protocol: 'radiant',
        subgraphOverrides: { [chain.id]: radiantSubgraph.trim() },
        chainIds: [chain.id],
      };
    }
    return {
      protocol: 'aavev3',
      chainIds: [chain.id],
    };
  };

  // Periodic heartbeat & idle fallback poll
  const heartbeatTimer = setInterval(async () => {
    const now = Date.now();
    const idleMs = now - lastActivityMs;
    const uptimeSec = Math.round((now - startMs) / 1000);
    try {
      if (idleMs >= STALL_POLL_INTERVAL_MS) {
        // Fallback subgraph poll to kick pipeline if everything is quiet
        const fallback: Candidate[] = [];
        for (const [protocol, adapter] of protocolAdapters) {
          try {
            const candidates = await adapter.pollCandidatesOnce(cfg, chain, 250);
            fallback.push(...candidates);
          } catch (err) {
            agentLog.debug({ protocol, err: (err as Error).message }, 'stall-fallback-error');
          }
        }
        agentLog.warn({ idleSec: Math.round(idleMs / 1000), fetched: fallback.length, uptimeSec }, 'stall-fallback-poll');
        if (fallback.length === 0) {
          consecutiveStallPolls += 1;
          if (consecutiveStallPolls >= STALL_POLL_TRIGGER && Date.now() >= stallBoostActiveUntil) {
            const baseHf = chain.risk?.healthFactorMax ?? cfg.risk.healthFactorMax ?? 1.02;
            const boostedHf = Math.max(baseHf + STALL_BOOST_EXTRA_HF, STALL_BOOST_MIN_HF);
            const baseFirst = cfg.indexer?.subgraphFirst ?? 500;
            const boostedFirst = Math.min(1000, Math.max(baseFirst, Math.round(baseFirst * STALL_BOOST_FIRST_MULTIPLIER)) || baseFirst);
            stallBoostActiveUntil = requestIndexerBoost(chain.id, {
              hfThreshold: boostedHf,
              subgraphFirst: boostedFirst,
              durationMs: STALL_BOOST_DURATION_MS,
            });
            agentLog.warn({ stallCount: consecutiveStallPolls, boostedHf, boostedFirst, durationMs: STALL_BOOST_DURATION_MS }, 'stall-indexer-boost');
          }
        } else {
          consecutiveStallPolls = 0;
        }
        for (const cand of fallback) {
          try {
            await processCandidate(cand, 'subgraph');
          } catch (err) {
            agentLog.debug({ err: (err as Error).message }, 'stall-candidate-error');
          }
        }
        markActivity();
      } else {
        agentLog.debug({ uptimeSec, idleSec: Math.round(idleMs / 1000) }, 'heartbeat');
      }
    } catch (hbErr) {
      agentLog.debug({ err: (hbErr as Error).message }, 'heartbeat-error');
    }
  }, HEARTBEAT_INTERVAL_MS);

  function computePolicyRetryDelay(attempts: number): number {
    const base = POLICY_RETRY_BASE_DELAY_MS * Math.max(1, 2 ** (attempts - 1));
    return Math.min(base, POLICY_RETRY_MAX_DELAY_MS);
  }

  function schedulePolicyRetry(
    borrower: `0x${string}`,
    hf: number,
    hfMax: number,
    label: string,
    protocol: ProtocolKey
  ): void {
    if (!POLICY_RETRY_ENABLED) return;
    if (!Number.isFinite(hf) || hf <= 0) return;
    if (hf >= hfMax + POLICY_RETRY_HF_MARGIN) return;
    if (POLICY_RETRY_MAX_ATTEMPTS === 0) return;
    const key = `${chain.id}:${borrower}`;
    const existing = policyRetryQueue.get(key);
    const now = Date.now();
    if (existing) {
      const hasMeaningfulImprovement =
        existing.lastHealthFactor != null && hf < existing.lastHealthFactor - POLICY_RETRY_IMPROVEMENT_EPS;
      if (!hasMeaningfulImprovement && existing.nextAttemptMs > now + POLICY_RETRY_RESCHEDULE_GUARD_MS) {
        policyRetryQueue.set(key, {
          ...existing,
          lastHealthFactor: hf,
          lastHfMax: hfMax,
          protocol: existing.protocol ?? protocol,
        });
        agentLog.debug({ borrower, healthFactor: hf, hfMax, attempts: existing.attempts, guardMs: POLICY_RETRY_RESCHEDULE_GUARD_MS, source: label }, 'policy-retry-guarded');
        return;
      }
    }
    const attempts = (existing?.attempts ?? 0) + 1;
    if (attempts > POLICY_RETRY_MAX_ATTEMPTS) {
      policyRetryQueue.delete(key);
      agentLog.debug({ borrower, attempts, source: label, healthFactor: hf, hfMax }, 'policy-retry-max-attempts');
      return;
    }
    const boundedDelay = computePolicyRetryDelay(attempts);
    const jitter = POLICY_RETRY_JITTER_MS > 0 ? Math.floor(Math.random() * (POLICY_RETRY_JITTER_MS + 1)) : 0;
    const delayMs = Math.min(POLICY_RETRY_MAX_DELAY_MS, boundedDelay + jitter);
    const nextAttemptMs = Date.now() + delayMs;
    policyRetryQueue.set(key, {
      borrower,
      attempts,
      nextAttemptMs,
      lastHealthFactor: hf,
      lastHfMax: hfMax,
      protocol: existing?.protocol ?? protocol,
    });
    agentLog.debug({ borrower, healthFactor: hf, hfMax, attempts, delayMs, source: label }, 'policy-retry-scheduled');
  }

  const processCandidate = async (candidate: Candidate, source: 'subgraph' | 'realtime' | 'predictive' | 'policy_retry') => {
    if (isKillSwitchActive()) {
      if (!killSwitchNotificationSent) {
        killSwitchNotificationSent = true;
        const location = killSwitchPath();
        agentLog.error({ killSwitch: location ?? 'env-only' }, 'kill-switch-engaged-stopping');
        await emitAlert(
          'Kill switch engaged',
          { chain: chain.name, chainId: chain.id, killSwitch: location ?? 'env-only' },
          'critical'
        );
      }
      process.exit(0);
      return;
    }
    // This agent only handles candidates for its own chain
    if (candidate.chainId !== chain.id) {
      return;
    }

    const protocolKey = ((candidate as any).protocol ?? 'aavev3') as ProtocolKey;
    let adapter: ReturnType<typeof getProtocolAdapter>;
    try {
      adapter = getProtocolAdapter(protocolKey);
    } catch (adapterErr) {
      agentLog.warn({ borrower: candidate.borrower, protocol: protocolKey, err: (adapterErr as Error).message, source }, 'protocol-adapter-missing');
      recordCandidateDrop(chain.name, 'protocol_adapter_missing');
      return;
    }
    const PlanRejectedErrorCtor = adapter.PlanRejectedError;

    counter.candidates.inc({ chain: chain.name });
    if (Number.isFinite(candidate.healthFactor) && candidate.healthFactor > 0) {
      histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'candidate' }, candidate.healthFactor);
    }
    markActivity();

    const denyAssets = cfg.risk.denyAssets ?? [];
    if (denyAssets.includes(candidate.debt.symbol) || denyAssets.includes(candidate.collateral.symbol)) {
      counter.denylistSkip.inc({ chain: chain.name, debt: candidate.debt.symbol, collateral: candidate.collateral.symbol });
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'policy_skip',
        reason: 'asset-denylist',
        details: {
          source,
          debt: { symbol: candidate.debt.symbol, address: candidate.debt.address },
          collateral: { symbol: candidate.collateral.symbol, address: candidate.collateral.address },
        },
      });
      agentLog.debug({ borrower: candidate.borrower, debt: candidate.debt.symbol, collateral: candidate.collateral.symbol, source }, 'asset-denylist');
      recordCandidateDrop(chain.name, 'asset_denylist');
      return;
    }

    if (candidate.debt.amount <= 0n || candidate.collateral.amount <= 0n) {
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'policy_skip',
        reason: 'zero-exposure',
        details: {
          source,
          debt: { symbol: candidate.debt.symbol, amount: candidate.debt.amount.toString() },
          collateral: { symbol: candidate.collateral.symbol, amount: candidate.collateral.amount.toString() },
        },
      });
      agentLog.debug({ borrower: candidate.borrower, source, debtAmount: candidate.debt.amount.toString(), collateralAmount: candidate.collateral.amount.toString() }, 'skip-zero-exposure');
      recordCandidateDrop(chain.name, 'zero_exposure');
      return;
    }

    const policyEntry = lookupAssetPolicy(cfg.assets, candidate.debt.symbol);
    if (!policyEntry) {
      agentLog.warn({ asset: candidate.debt.symbol, source }, 'missing-policy');
      recordCandidateDrop(chain.name, 'missing_policy');
      return;
    }

    const market = cfg.markets.find(
      (m) =>
        m.enabled &&
        m.protocol === protocolKey &&
        m.chainId === candidate.chainId &&
        symbolsEqual(m.debtAsset, candidate.debt.symbol) &&
        symbolsEqual(m.collateralAsset, candidate.collateral.symbol)
    );
    if (!market) {
      agentLog.debug({ market: candidate, source }, 'market-disabled');
      recordCandidateDrop(chain.name, 'market_disabled');
      return;
    }

    const policy = policyEntry.value;

    const debtTokenEntry = lookupToken(chain.tokens, candidate.debt.symbol, candidate.debt.address);
    const collateralTokenEntry = lookupToken(chain.tokens, candidate.collateral.symbol, candidate.collateral.address);
    if (!debtTokenEntry || !collateralTokenEntry) {
      agentLog.warn({ candidate, source }, 'token-metadata-missing');
      recordCandidateDrop(chain.name, 'token_metadata_missing');
      return;
    }
    const { value: debtToken, key: debtTokenSymbol } = debtTokenEntry;
    const { value: collateralToken, key: collateralTokenSymbol } = collateralTokenEntry;

    const client = publicClient(chain);
    const borrowerIntelTtl = chain.risk?.borrowerIntelTtlSec ?? cfg.risk.borrowerIntelTtlSec ?? 7200;
    let cachedHealthFactor: number | null | undefined;

    const readHealthFactor = async (): Promise<number | null> => {
      if (cachedHealthFactor !== undefined) return cachedHealthFactor;
      const pool = await poolAddress(chain);
      const accountData = (await client.readContract({
        abi: AAVE_POOL_ABI,
        address: pool,
        functionName: 'getUserAccountData',
        args: [candidate.borrower],
      })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
      const hf = wadToFloat(accountData[5]);
      cachedHealthFactor = Number.isFinite(hf) && hf > 0 ? hf : null;
      return cachedHealthFactor;
    };

    const sequencer = await checkSequencerStatus({
      rpcUrl: chain.rpc,
      feed: chain.sequencerFeed,
      staleAfterSeconds: SEQUENCER_STALE_SECONDS,
      recoveryGraceSeconds: SEQUENCER_RECOVERY_GRACE_SECONDS,
    });
    gauge.sequencerStatus.labels({ chain: chain.name, stage: 'pre_sim' }).set(sequencer.ok ? 1 : 0);
    if (!sequencer.ok) {
      const sequencerReason = sequencer.reason ?? 'unknown';
      counter.sequencerSkip.inc({ chain: chain.name, reason: sequencerReason });
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'policy_skip',
        reason: `sequencer ${sequencerReason}`,
        details: {
          source,
          sequencer: {
            reason: sequencer.reason,
            updatedAt: sequencer.updatedAt,
          },
        },
      });
      agentLog.debug({ borrower: candidate.borrower, reason: sequencer.reason, updatedAt: sequencer.updatedAt, source }, 'skip-sequencer');
      recordCandidateDrop(chain.name, `sequencer_${sequencerReason}`);
      return;
    }

  let candSnapshot!: ReturnType<typeof serializeCandidate>;
  let plan: SimPlan | null = null;
  let healthFactor: number | null = null;
  let hfMax = chain.risk?.healthFactorMax ?? cfg.risk.healthFactorMax ?? 0.98;
  try {
      const throttleLimit = cfg.risk.maxAttemptsPerBorrowerHour ?? 0;
      let throttleBypassed = false;
      if (!cfg.risk.dryRun && throttleLimit > 0) {
        const throttled = await isThrottled(chain.id, candidate.borrower, throttleLimit);
        if (throttled) {
          const dropThreshold = chain.risk?.throttleBypassHfDrop ?? cfg.risk.throttleBypassHfDrop ?? 0;
          if (dropThreshold > 0) {
            try {
              const [priorIntel, currentHf] = await Promise.all([
                loadBorrowerIntel(chain.id, candidate.borrower),
                readHealthFactor(),
              ]);
              if (currentHf !== null && Number.isFinite(currentHf) && currentHf > 0) {
                await storeBorrowerIntel(chain.id, candidate.borrower, currentHf, borrowerIntelTtl);
              }
              if (currentHf !== null && priorIntel && Number.isFinite(priorIntel.healthFactor)) {
                const drop = priorIntel.healthFactor - currentHf;
                if (drop >= dropThreshold) {
                  await resetThrottle(chain.id, candidate.borrower);
                  throttleBypassed = true;
                  agentLog.debug({
                    borrower: candidate.borrower,
                    previousHf: priorIntel.healthFactor,
                    currentHf,
                    drop,
                    source,
                  }, 'throttle-bypass-hf-drop');
                }
              }
            } catch (hfErr) {
              agentLog.debug({ borrower: candidate.borrower, err: (hfErr as Error).message, source }, 'throttle-bypass-eval-failed');
            }
          }

          if (!throttleBypassed) {
            counter.throttled.inc({ chain: chain.name });
            await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'throttled' });
            agentLog.debug({ borrower: candidate.borrower, source }, 'throttled-skip');
            recordCandidateDrop(chain.name, 'throttled');
            return;
          }
        }
      }

      // Try to load oracle prices; if either is missing, attempt a conservative DEX ratio fallback
      let debtPriceUsd = await oraclePriceUsd(client, debtToken);
      let collPriceUsd = await oraclePriceUsd(client, collateralToken);
      if (debtPriceUsd == null || collPriceUsd == null) {
        const { options: routeOptions, gapFee, gapRouter } = buildRouteOptions(cfg, chain, debtTokenSymbol, collateralTokenSymbol);
        if (routeOptions.length > 0) {
          try {
            const ratio = await dexPriceRatio({ client, chain, collateral: collateralToken, debt: debtToken, fee: gapFee, router: gapRouter });
            if (ratio && Number.isFinite(ratio) && ratio > 0) {
              if (collPriceUsd == null && debtPriceUsd != null && debtPriceUsd > 0) {
                collPriceUsd = debtPriceUsd * ratio;
                agentLog.debug({ borrower: candidate.borrower, debt: candidate.debt.symbol, collateral: candidate.collateral.symbol, ratio, inferred: collPriceUsd }, 'price-fallback-dex-collateral');
              } else if (debtPriceUsd == null && collPriceUsd != null && collPriceUsd > 0) {
                debtPriceUsd = collPriceUsd / ratio;
                agentLog.debug({ borrower: candidate.borrower, debt: candidate.debt.symbol, collateral: candidate.collateral.symbol, ratio, inferred: debtPriceUsd }, 'price-fallback-dex-debt');
              }
            }
          } catch (e) {
            agentLog.debug({ borrower: candidate.borrower, err: (e as Error).message }, 'price-fallback-dex-failed');
          }
        }
      }
      if (debtPriceUsd == null || collPriceUsd == null || debtPriceUsd <= 0 || collPriceUsd <= 0) {
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'policy_skip',
          reason: 'price-missing',
        });
        agentLog.debug({ borrower: candidate.borrower, debt: candidate.debt.symbol, collateral: candidate.collateral.symbol, source }, 'price-missing');
        recordCandidateDrop(chain.name, 'price_missing');
        return;
      }
      const nativeToken = chain.tokens.WETH ?? chain.tokens.ETH ?? debtToken;
      let nativePriceUsd = debtPriceUsd;
      if (nativeToken) {
        const nativePrice = await oraclePriceUsd(client, nativeToken);
        if (nativePrice && nativePrice > 0) {
          nativePriceUsd = nativePrice;
        }
      }
  const { options: routeOptions, gapFee, gapRouter } = buildRouteOptions(cfg, chain, debtTokenSymbol, collateralTokenSymbol);
      const gap = await oracleDexGapBps({
        client,
        chain,
        collateral: collateralToken,
        debt: debtToken,
        fee: gapFee,
        router: gapRouter,
      });
      const baseHealthFactorMax = chain.risk?.healthFactorMax ?? cfg.risk.healthFactorMax ?? 0.98;
      let baseGapCapBps = policy.gapCapBps ?? 100;
      if (isPeggedPairSymbol(debtTokenSymbol, collateralTokenSymbol)) {
        baseGapCapBps = Math.max(baseGapCapBps, PEGGED_GAP_CAP_BPS);
      }
      const adaptive = await adaptiveThresholds.update({
        chainId: chain.id,
        chainName: chain.name,
        assetKey: `${debtTokenSymbol}-${collateralTokenSymbol}`,
        baseHealthFactorMax,
        baseGapCapBps,
        observedGapBps: gap,
      });
      candSnapshot = serializeCandidate({
        candidate,
        debtToken,
        collateralToken,
        debtPriceUsd,
        collateralPriceUsd: collPriceUsd,
        gapBps: gap,
        routeOptions,
        adaptive: {
          healthFactorMax: adaptive.healthFactorMax,
          gapCapBps: adaptive.gapCapBps,
          volatility: adaptive.volatility,
          baseHealthFactorMax,
          baseGapCapBps,
        },
      });

      if (gap > adaptive.gapCapBps) {
        counter.gapSkip.inc({ chain: chain.name });
        if (Number.isFinite(candidate.healthFactor) && candidate.healthFactor > 0) {
          histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'gap_skip' }, candidate.healthFactor);
        }
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'gap_skip',
          reason: `gap ${gap}bps`,
          details: { candidate: candSnapshot },
        });
        agentLog.debug({ borrower: candidate.borrower, gap, source }, 'skip-gap');
        recordCandidateDrop(chain.name, 'gap_skip');
        return;
      }

  hfMax = adaptive.healthFactorMax;
      try {
        const hf = await readHealthFactor();
        healthFactor = hf;
        if (!Number.isFinite(healthFactor) || (healthFactor ?? 0) <= 0) {
          agentLog.warn({ borrower: candidate.borrower, source }, 'hf-invalid');
          await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: 'hf-invalid' });
          recordCandidateDrop(chain.name, 'hf_invalid');
          return;
        }
        const hfValue = healthFactor as number;
        histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'hf_read' }, hfValue);
      } catch (hfErr) {
        agentLog.warn({ borrower: candidate.borrower, err: (hfErr as Error).message, source }, 'hf-fetch-failed');
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: 'hf-fetch-failed' });
        recordCandidateDrop(chain.name, 'hf_fetch_failed');
        return;
      }

      if (healthFactor !== null && Number.isFinite(healthFactor) && healthFactor > 0) {
        await storeBorrowerIntel(chain.id, candidate.borrower, healthFactor as number, borrowerIntelTtl);
      }

      const precommitEligible = shouldPrecommit({
        debtFeed: debtToken.chainlinkFeed,
        gapBps: candSnapshot.gapBps ?? gap,
        healthFactor: healthFactor ?? Number.POSITIVE_INFINITY,
        hfMax,
      });
      const hfValue = healthFactor ?? Number.POSITIVE_INFINITY;
      if (hfValue >= 1 && !precommitEligible) {
        const hfReason = Number.isFinite(hfValue) ? hfValue.toFixed(4) : String(hfValue);
        if (Number.isFinite(hfValue) && hfValue > 0) {
          histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'policy_skip' }, hfValue);
        }
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'policy_skip',
          reason: `hf>=1 ${hfReason}`,
          details: { candidate: candSnapshot },
        });
        if (throttleLimit > 0 && Number.isFinite(hfValue) && hfValue > 0) {
          await recordThrottleAttempt(chain.id, candidate.borrower, 3600);
        }
        if (Number.isFinite(hfValue)) {
          schedulePolicyRetry(candidate.borrower, hfValue, hfMax, source, protocolKey);
        }
        agentLog.debug({ borrower: candidate.borrower, healthFactor: hfValue, source }, 'skip-hf-at-or-above-one');
        recordCandidateDrop(chain.name, 'hf_at_or_above_one');
        return;
      }

      if (hfValue >= hfMax && !precommitEligible) {
        if (healthFactor !== null && Number.isFinite(healthFactor) && healthFactor > 0) {
          histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'policy_skip' }, healthFactor);
        }
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: `hf ${healthFactor?.toFixed(4)}` });
        if (throttleLimit > 0) {
          await recordThrottleAttempt(chain.id, candidate.borrower, 3600);
        }
        agentLog.debug({ borrower: candidate.borrower, healthFactor, hfMax, source }, 'skip-health-factor');
        if (healthFactor !== null) {
        schedulePolicyRetry(candidate.borrower, healthFactor, hfMax, source, protocolKey);
        }
        recordCandidateDrop(chain.name, 'hf_above_cap');
        return;
      }

      const trigger = (candidate as any).__trigger;
      agentLog.debug({
        borrower: candidate.borrower,
        debtAmount: candidate.debt.amount.toString(),
        collateralAmount: candidate.collateral.amount.toString(),
        routes: routeOptions.map((r) => r.type),
        healthFactor,
        hfMax,
        precommitEligible,
        source,
        trigger,
      }, 'candidate-considered');

      const contract = liquidatorForChain(cfg, chain.id);
      if (!contract || /^0x0+$/.test(contract)) {
        agentLog.warn({ source }, 'missing-liquidator-address');
        recordCandidateDrop(chain.name, 'missing_liquidator_address');
        return;
      }
      if (!cfg.beneficiary) {
        agentLog.warn({ source }, 'missing-beneficiary-address');
        recordCandidateDrop(chain.name, 'missing_beneficiary');
        return;
      }
      const pk = privateKeyForChain(chain);
      if (!pk) {
        agentLog.warn({ source }, 'missing-private-key');
        recordCandidateDrop(chain.name, 'missing_private_key');
        return;
      }
      const executor = executorAddressForChain(chain);
      if (!executor) {
        agentLog.warn({ source }, 'missing-executor-address');
        recordCandidateDrop(chain.name, 'missing_executor_address');
        return;
      }

      const simulateStart = performance.now();
      plan = await adapter.simulate({
        client,
        chain,
        contract,
        beneficiary: cfg.beneficiary,
        executor,
        borrower: candidate.borrower,
        protocol: protocolKey,
        debt: { ...debtToken, symbol: candidate.debt.symbol, amount: candidate.debt.amount },
        collateral: { ...collateralToken, symbol: candidate.collateral.symbol, amount: candidate.collateral.amount },
        closeFactor: (market.closeFactorBps ?? DEFAULT_CLOSE_FACTOR_BPS) / 10_000,
        bonusBps: market.bonusBps ?? DEFAULT_BONUS_BPS, // TODO: subtract Aave liquidationProtocolFee to pass the net bonus instead of the gross config value.
        routes: routeOptions,
        pricesUsd: { debt: debtPriceUsd, coll: collPriceUsd },
        policy,
        gasCapUsd: cfg.risk.gasCapUsd,
        maxRepayUsd: cfg.risk.maxRepayUsd,
        nativePriceUsd,
        morpho:
          protocolKey === 'morphoblue' && candidate.morpho
            ? {
                borrowShares: candidate.morpho.borrowShares,
                market: {
                  loanToken: candidate.morpho.marketParams.loanToken,
                  collateralToken: candidate.morpho.marketParams.collateralToken,
                  oracle: candidate.morpho.marketParams.oracle,
                  irm: candidate.morpho.marketParams.irm,
                  lltv: candidate.morpho.marketParams.lltv,
                },
              }
            : undefined,
      });
      const simulateDurationSeconds = (performance.now() - simulateStart) / 1000;
      histogram.simulateDuration.observe(simulateDurationSeconds);
      // TODO: branch here for RFQ execution once the contract codec supports RFQ calldata payloads.

      if (!plan) {
        agentLog.debug({
          borrower: candidate.borrower,
          debtAmount: candidate.debt.amount.toString(),
          collateralAmount: candidate.collateral.amount.toString(),
          debtPriceUsd,
          collPriceUsd,
          gap,
          gasCapUsd: cfg.risk.gasCapUsd,
          routes: routeOptions.map((r) => r.type),
          healthFactor,
          hfMax,
          source,
          trigger,
        }, 'plan-null');
        const reason = ['plan-null'];
        if (healthFactor !== null) {
          reason.push(`hf ${healthFactor.toFixed(4)}`);
          histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'plan_null' }, healthFactor);
        }
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'policy_skip',
          reason: reason.join(' '),
          details: { candidate: candSnapshot },
        });
        recordCandidateDrop(chain.name, 'plan_null');
        return;
      }

      counter.plansReady.inc({ chain: chain.name });
      if (healthFactor !== null && Number.isFinite(healthFactor) && healthFactor > 0) {
        histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'plan_ready' }, healthFactor);
      }
      plansReadyCount += 1;
      if (plansReadyCount > 0) {
        gauge.hitRate.set(plansSentCount / plansReadyCount);
      }

      plan.precommit = precommitEligible && (healthFactor ?? 0) >= hfMax;
      if (plan.precommit) {
        counter.precommitAttempts.inc({ chain: chain.name });
      }

      if (!cfg.risk.dryRun && INVENTORY_MODE) {
        try {
          const contractAddress = contract as Address;
          const currentBalance = await inventoryBalance(chain, debtToken, contractAddress, client);
          const normalizedBalance = Number(currentBalance) / Math.pow(10, debtToken.decimals);
          if (Number.isFinite(normalizedBalance)) {
            gauge.inventoryBalance
              .labels({ chain: chain.name, token: candidate.debt.symbol })
              .set(normalizedBalance);
          }
          if (currentBalance >= plan.repayAmount) {
            plan.mode = 'funds';
          }
        } catch (err) {
          agentLog.warn({ err: (err as Error).message }, 'inventory-balance-failed');
        }
      }
      if (!plan.mode) plan.mode = 'flash';

      const pnlPerGas = plan.gasUsd > 0 ? plan.netUsd / plan.gasUsd : Number.POSITIVE_INFINITY;
      plan.pnlPerGas = pnlPerGas;
      gauge.pnlPerGas.labels({ chain: chain.name }).set(pnlPerGas);

      const planSnapshot = serializePlan(plan);
      if (cfg.risk.dryRun) {
        counter.plansDryRun.inc({ chain: chain.name });
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'dry_run',
          reason: `netBps ${plan.estNetBps.toFixed(2)}`,
          details: { candidate: candSnapshot, plan: planSnapshot },
        });
        agentLog.info({ borrower: candidate.borrower, repay: plan.repayAmount.toString(), netBps: plan.estNetBps, source, trigger }, 'DRY-RUN');
        recordCandidateDrop(chain.name, 'dry_run');
        return;
      }

      if (cfg.risk.pnlPerGasMin > 0 && plan.gasUsd > 0) {
        if (pnlPerGas < cfg.risk.pnlPerGasMin) {
          await recordAttemptRow({
            chainId: chain.id,
            borrower: candidate.borrower,
            status: 'policy_skip',
            reason: `pnl/gas ${pnlPerGas.toFixed(2)} < ${cfg.risk.pnlPerGasMin}`,
            details: { candidate: candSnapshot, plan: planSnapshot, pnlPerGas },
          });
          agentLog.debug({ borrower: candidate.borrower, pnlPerGas, min: cfg.risk.pnlPerGasMin, source }, 'skip-pnl-per-gas');
          recordCandidateDrop(chain.name, 'pnl_per_gas_floor');
          return;
        }
      }

      const sequencerPreSend = await checkSequencerStatus({
        rpcUrl: chain.rpc,
        feed: chain.sequencerFeed,
        staleAfterSeconds: SEQUENCER_STALE_SECONDS,
        recoveryGraceSeconds: SEQUENCER_RECOVERY_GRACE_SECONDS,
      });
      gauge.sequencerStatus.labels({ chain: chain.name, stage: 'pre_send' }).set(sequencerPreSend.ok ? 1 : 0);
      if (!sequencerPreSend.ok) {
        const reason = `sequencer ${sequencerPreSend.reason ?? 'unavailable'}`;
        agentLog.warn({ borrower: candidate.borrower, reason, source }, 'sequencer-down-skipping-tx');
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason });
        recordCandidateDrop(chain.name, `sequencer_${sequencerPreSend.reason ?? 'pre_send'}`);
        return;
      }

      await recordThrottleAttempt(chain.id, candidate.borrower, 3600);

      const minProfit = plan.minProfit;
      if (minProfit <= 0n) {
        agentLog.warn({ borrower: candidate.borrower, floorBps: policy.floorBps, repayAmount: plan.repayAmount.toString(), source }, 'min-profit-zero-skip');
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'policy_skip',
          reason: 'min-profit-zero',
          details: { candidate: candSnapshot, plan: planSnapshot },
        });
        recordCandidateDrop(chain.name, 'min_profit_zero');
        return;
      }
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

      if (
        cfg.risk.maxLiveExecutions !== undefined &&
        cfg.risk.maxLiveExecutions > 0 &&
        plansSentCount >= cfg.risk.maxLiveExecutions
      ) {
        agentLog.warn({ txnIdx: plansSentCount, maxLiveExecutions: cfg.risk.maxLiveExecutions, source }, 'live-execution-cap-reached');
        process.exit(0);
      }

      if (
        cfg.risk.maxSessionNotionalUsd !== undefined &&
        cfg.risk.maxSessionNotionalUsd > 0 &&
        sessionNotionalUsd + plan.repayUsd > cfg.risk.maxSessionNotionalUsd
      ) {
        agentLog.warn(
          {
            pendingRepayUsd: plan.repayUsd,
            sessionNotionalUsd,
            maxSessionNotionalUsd: cfg.risk.maxSessionNotionalUsd,
            source,
          },
          'session-notional-cap-hit'
        );
        process.exit(0);
      }

      const sendStart = performance.now();
  let buildArgs: BuildArgs;
      if (plan.protocol === 'morphoblue') {
        if (!plan.morpho) {
          agentLog.error({ borrower: candidate.borrower, source }, 'morpho-plan-missing');
          await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: 'morpho-plan-missing' });
          recordCandidateDrop(chain.name, 'morpho_plan_missing');
          return;
        }
        buildArgs = {
          protocol: 'morphoblue',
          borrower: candidate.borrower,
          repayAmount: plan.repayAmount,
          repayShares: plan.morpho.repayShares,
          dexId: plan.dexId,
          router: plan.router,
          uniFee: plan.uniFee,
          solidlyStable: plan.solidlyStable,
          solidlyFactory: plan.solidlyFactory,
          minProfit,
          amountOutMin: plan.amountOutMin,
          deadline,
          path: plan.path,
          market: plan.morpho.market,
          callbackData: plan.morpho.callbackData,
          mode: plan.mode,
        };
      } else {
        buildArgs = {
          protocol: plan.protocol,
          borrower: candidate.borrower,
          debtAsset: candidate.debt.address,
          collateralAsset: candidate.collateral.address,
          repayAmount: plan.repayAmount,
          dexId: plan.dexId,
          router: plan.router,
          uniFee: plan.uniFee,
          solidlyStable: plan.solidlyStable,
          solidlyFactory: plan.solidlyFactory,
          minProfit,
          amountOutMin: plan.amountOutMin,
          deadline,
          path: plan.path,
          mode: plan.mode,
        };
      }

      const txHash = await sendLiquidation(
        chain.id,
        chain.rpc,
        pk,
        contract,
        buildArgs,
        chain.privtx,
      );
      const sendLatencySeconds = (performance.now() - sendStart) / 1000;
      histogram.sendLatency.observe(sendLatencySeconds);
      if (plan.mode === 'funds') {
        counter.inventoryExecutions.inc({ chain: chain.name });
        inventoryCache.delete(`${chain.id}:${debtToken.address.toLowerCase()}`);
      }
      if (plan.precommit) {
        counter.precommitSuccess.inc({ chain: chain.name });
      }
      counter.plansSent.inc({ chain: chain.name });
      if (healthFactor !== null && Number.isFinite(healthFactor) && healthFactor > 0) {
        histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'sent' }, healthFactor);
      }
      const sentReason = healthFactor !== null ? `hf ${healthFactor.toFixed(4)}` : undefined;
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'sent',
        reason: sentReason,
        txHash,
        details: { candidate: candSnapshot, plan: planSnapshot, txHash, pnlPerGas },
      });
      plansSentCount += 1;
      sessionNotionalUsd += plan.repayUsd;
      if (plansReadyCount > 0) {
        gauge.hitRate.set(plansSentCount / plansReadyCount);
      }
      {
        const attempts = plansSentCount + plansErrorCount;
        const failureRatio = attempts > 0 ? plansErrorCount / attempts : 0;
        gauge.failureRate.labels({ chain: chain.name }).set(failureRatio);
      }
      if (plan.netUsd > 0) {
        counter.profitEstimated.inc({ chain: chain.name, mode: plan.mode ?? 'flash' }, plan.netUsd);
      }
      agentLog.info({ borrower: candidate.borrower, netBps: plan.estNetBps, txHash, repayUsd: plan.repayAmount, sessionNotionalUsd, healthFactor, source, trigger, mode: plan.mode, precommit: plan.precommit, pnlPerGas }, 'liquidation-sent');
  markActivity();

      if (
        cfg.risk.maxLiveExecutions !== undefined &&
        cfg.risk.maxLiveExecutions > 0 &&
        plansSentCount >= cfg.risk.maxLiveExecutions
      ) {
        agentLog.warn({ maxLiveExecutions: cfg.risk.maxLiveExecutions, source }, 'live-execution-cap-hit-stopping');
        process.exit(0);
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'HealthFactorNotBelowThreshold') {
        const reason = plan?.precommit ? 'hf-precommit-revert' : 'hf-recovered';
        if (Number.isFinite(healthFactor ?? NaN) && (healthFactor ?? 0) > 0) {
          histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'recovered' }, healthFactor!);
        }
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason, details: plan ? { plan: serializePlan(plan) } : undefined });
        const logFn = plan?.precommit ? agentLog.info.bind(agentLog) : agentLog.debug.bind(agentLog);
        logFn({ borrower: candidate.borrower, source, precommit: plan?.precommit }, 'skip-hf-recovered');
        if (healthFactor !== null) {
          schedulePolicyRetry(candidate.borrower, healthFactor, hfMax, source, protocolKey);
        }
        recordCandidateDrop(chain.name, reason);
        return;
      }

      if (err instanceof PlanRejectedErrorCtor) {
        counter.plansRejected.inc({ chain: chain.name, reason: err.code });
        if (healthFactor !== null && Number.isFinite(healthFactor) && healthFactor > 0) {
          histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'plan_rejected' }, healthFactor);
        }
        const detail = err.detail
          ? { signature: err.detail.signature, shortMessage: err.detail.shortMessage }
          : undefined;
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'policy_skip',
          reason: `plan_rejected:${err.code}:${err.message}`,
          details: { candidate: candSnapshot, rejection: detail },
        });
        agentLog.debug({ borrower: candidate.borrower, code: err.code, message: err.message, source }, 'plan-rejected');
        recordCandidateDrop(chain.name, `plan_rejected_${err.code}`);
        return;
      }

      counter.plansError.inc({ chain: chain.name });
      plansErrorCount += 1;
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'error',
        reason: (err as Error).message,
        details: candSnapshot ? { candidate: candSnapshot } : { candidate },
      });
      const attempts = plansSentCount + plansErrorCount;
      const ratio = attempts > 0 ? plansErrorCount / attempts : 0;
      gauge.failureRate.labels({ chain: chain.name }).set(ratio);
      if (!cfg.risk.dryRun) {
        if (
          attempts >= 5 &&
          cfg.risk.failRateCap > 0 &&
          ratio > cfg.risk.failRateCap &&
          Date.now() - lastFailAlertMs > ALERT_COOLDOWN_MS
        ) {
          lastFailAlertMs = Date.now();
          await emitAlert('Liquidations fail-rate above threshold', {
            chain: chain.name,
            ratio: ratio.toFixed(2),
            attempts,
            errors: plansErrorCount,
          }, 'critical');
          if (AUTO_STOP_ON_FAIL_RATE) {
            agentLog.error({ ratio, attempts, errors: plansErrorCount }, 'fail-rate-cap-exceeded-auto-stop');
            process.exit(1);
          }
        }
      }
      agentLog.error({ err: (err as Error).message, borrower: candidate.borrower, source }, 'candidate-failed');
      recordCandidateDrop(chain.name, 'send_error');
    }
  };

  const drainPolicyRetry = async (): Promise<boolean> => {
    if (!POLICY_RETRY_ENABLED || policyRetryQueue.size === 0) return false;
    const now = Date.now();
  for (const [key, entry] of policyRetryQueue) {
    if (entry.nextAttemptMs > now) {
      continue;
    }
    policyRetryQueue.delete(key);
    try {
        const indexerOptions = resolveIndexerOptions(entry.protocol);
        if (!indexerOptions) {
          policyRetryQueue.set(key, entry);
          agentLog.debug({ borrower: entry.borrower, protocol: entry.protocol }, 'policy-retry-no-indexer-options');
          return false;
        }
        const candidates = await fetchBorrowerCandidates(cfg, chain, entry.borrower, indexerOptions);
        if (candidates.length === 0) {
          if (entry.attempts < POLICY_RETRY_MAX_ATTEMPTS) {
            const nextAttempts = entry.attempts + 1;
            const delayMs = computePolicyRetryDelay(nextAttempts);
            const jitter = POLICY_RETRY_JITTER_MS > 0 ? Math.floor(Math.random() * (POLICY_RETRY_JITTER_MS + 1)) : 0;
            entry.attempts = nextAttempts;
            entry.nextAttemptMs = Date.now() + Math.min(POLICY_RETRY_MAX_DELAY_MS, delayMs + jitter);
            policyRetryQueue.set(key, entry);
            agentLog.debug({ borrower: entry.borrower, attempts: nextAttempts, delayMs, source: 'policy_retry' }, 'policy-retry-rescheduled-empty');
          } else {
            agentLog.debug({ borrower: entry.borrower, attempts: entry.attempts, source: 'policy_retry' }, 'policy-retry-exhausted-empty');
          }
          return false;
        }
        agentLog.debug({ borrower: entry.borrower, attempts: entry.attempts, count: candidates.length }, 'policy-retry-dispatch');
        for (const candidate of candidates) {
          await processCandidate(candidate, 'policy_retry');
        }
        return true;
      } catch (err) {
        agentLog.debug({ borrower: entry.borrower, attempts: entry.attempts, err: (err as Error).message }, 'policy-retry-fetch-error');
        if (entry.attempts < POLICY_RETRY_MAX_ATTEMPTS) {
          const nextAttempts = entry.attempts + 1;
          const delayMs = computePolicyRetryDelay(nextAttempts);
          const jitter = POLICY_RETRY_JITTER_MS > 0 ? Math.floor(Math.random() * (POLICY_RETRY_JITTER_MS + 1)) : 0;
          entry.attempts = nextAttempts;
          entry.nextAttemptMs = Date.now() + Math.min(POLICY_RETRY_MAX_DELAY_MS, delayMs + jitter);
          policyRetryQueue.set(key, entry);
        }
        return false;
      }
    }
    return false;
  };

  const predictiveScanner = startPredictiveScanner(chain, cfg, async (candidate) => {
    try {
      await processCandidate(candidate, 'predictive');
    } catch (err) {
      agentLog.debug(
        { borrower: candidate.borrower, err: (err as Error).message },
        'predictive-candidate-error'
      );
    }
  });

  try {
    while (true) {
      if (await drainPolicyRetry()) {
        continue;
      }
      if (realtimeWatcher) {
        const immediate = realtimeWatcher.tryShift();
        if (immediate) {
          await processCandidate(immediate, 'realtime');
          continue;
        }

        const result = await Promise.race([
          subgraphPromise.then((value) => ({ type: 'subgraph' as const, value })),
          realtimeWatcher
            .next()
            .then((candidate) => ({ type: 'realtime' as const, candidate }))
            .catch(() => ({ type: 'stopped' as const })),
        ]);

        if (result.type === 'stopped') {
          break;
        }

        if (result.type === 'realtime') {
          await processCandidate(result.candidate, 'realtime');
          continue;
        }

        const { done, value } = result.value;
        if (done) break;
        await processCandidate(value, 'subgraph');
        subgraphPromise = candidateIterator.next();
      } else {
        const { done, value } = await subgraphPromise;
        if (done) break;
        await processCandidate(value, 'subgraph');
        subgraphPromise = candidateIterator.next();
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    realtimeWatcher?.stop();
    predictiveScanner?.stop();
  }
}


async function main() {
  const cfg = loadConfig();
  await logPoolsAtBoot(cfg);
  summarizeRouteCoverage(cfg);
  await ensureAttemptTable();
  log.info({ chains: cfg.chains.length }, 'boot');

  const enabledChains = cfg.chains.filter((c) => c.enabled);
  if (enabledChains.length === 0) {
    log.warn('no chains enabled in config, exiting');
    return;
  }

  const chainFilterRaw = process.env.CHAIN_FILTER?.trim();
  let chainsToRun = enabledChains;
  if (chainFilterRaw) {
    const requested = chainFilterRaw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (requested.length > 0) {
      const lowerRequested = requested.map((entry) => entry.toLowerCase());
      chainsToRun = enabledChains.filter((chain) => {
        const nameMatch = lowerRequested.includes(chain.name.toLowerCase());
        const idMatch = lowerRequested.includes(String(chain.id));
        return nameMatch || idMatch;
      });

      const missing = requested.filter((entry) => {
        const entryLower = entry.toLowerCase();
        return !enabledChains.some(
          (chain) =>
            chain.name.toLowerCase() === entryLower || String(chain.id) === entryLower
        );
      });

      if (missing.length > 0) {
        log.warn({ requested, missing }, 'chain-filter-missing');
      }

      if (chainsToRun.length === 0) {
        log.warn({ requested, enabled: enabledChains.map((chain) => chain.name) }, 'chain-filter-empty');
        return;
      }
    }
  }

  log.info({ chains: chainsToRun.map((c) => c.name) }, 'launching agents');
  const agents = chainsToRun.map((chain) => runChainAgent(chain, cfg));
  await Promise.all(agents);
  log.info('all agents finished');
}

main().catch((e) => {
  log.error({ err: (e as Error).message }, 'orchestrator-fatal');
  console.error(e);
  process.exit(1);
});
