import './infra/env';
import './infra/metrics_server';
import { Address, createPublicClient, http } from 'viem';
import { performance } from 'perf_hooks';
import { loadConfig, liquidatorForChain, ChainCfg, AppConfig, TokenInfo } from './infra/config';
import { executorAddressForChain, privateKeyForChain } from './infra/accounts';
import { log } from './infra/logger';
import { counter, gauge, histogram } from './infra/metrics';
import { isThrottled, recordAttempt as recordThrottleAttempt } from './infra/throttle';
import { ensureAttemptTable, recordAttemptRow } from './infra/attempts';
import { streamCandidates, type Candidate, pollChainCandidatesOnce } from './indexer/aave_indexer';
import { oracleDexGapBps, oraclePriceUsd } from './indexer/price_watcher';
import { simulate, Plan as SimPlan } from './simulator/simulate';
import { sendLiquidation } from './executor/send_tx';
import { getPoolFromProvider, logPoolsAtBoot } from './infra/aave_provider';
import { buildRouteOptions } from './util/routes';
import { serializeCandidate, serializePlan } from './util/serialize';
import { lookupAssetPolicy, lookupToken, symbolsEqual } from './util/symbols';
import { emitAlert } from './infra/alerts';
import { checkSequencerStatus } from './infra/sequencer';
import { createChainWatcher } from './realtime/watchers';
import { shouldPrecommit } from './realtime/oracle_predictor';
import { isKillSwitchActive, killSwitchPath } from './infra/kill_switch';

const DEFAULT_CLOSE_FACTOR_BPS = 5000;
const DEFAULT_BONUS_BPS = 800;
const WAD = 10n ** 18n;
const SEQUENCER_STALE_SECONDS = 120;
const SEQUENCER_RECOVERY_GRACE_SECONDS = 120;
const AUTO_STOP_ON_FAIL_RATE = process.env.FAIL_RATE_AUTO_STOP === '1';
const INVENTORY_MODE = process.env.INVENTORY_MODE !== '0';
const INVENTORY_REFRESH_MS = Number(process.env.INVENTORY_REFRESH_MS ?? 10_000);

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
const clients = new Map<number, ReturnType<typeof createPublicClient>>();
const pools = new Map<number, Address>();
const inventoryCache = new Map<string, { balance: bigint; fetchedAt: number }>();

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
  const pool = await getPoolFromProvider(chain.rpc, chain.aaveProvider);
  pools.set(chain.id, pool);
  return pool;
}

function wadToFloat(value: bigint): number {
  if (value === 0n) return 0;
  return Number(value) / Number(WAD);
}

function publicClient(chain: ChainCfg) {
  let client = clients.get(chain.id);
  if (!client) {
    client = createPublicClient({ transport: http(chain.rpc) });
    clients.set(chain.id, client);
  }
  return client;
}

async function inventoryBalance(
  chain: ChainCfg,
  token: TokenInfo,
  contract: Address,
  client: ReturnType<typeof createPublicClient>
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

// --- Chain Agent --- 

async function runChainAgent(chain: ChainCfg, cfg: AppConfig) {
  const agentLog = log.child({ chain: chain.name, chainId: chain.id });
  agentLog.info('starting agent');

  const iterator = streamCandidates(cfg)[Symbol.asyncIterator]();
  let subgraphPromise = iterator.next();
  const realtimeWatcher = await createChainWatcher(chain, cfg);
  let killSwitchNotificationSent = false;
  // Heartbeat & stall detection state
  const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 60_000);
  const STALL_POLL_INTERVAL_MS = Number(process.env.STALL_POLL_INTERVAL_MS ?? 120_000);
  let lastActivityMs = Date.now();
  const startMs = lastActivityMs;
  function markActivity() { lastActivityMs = Date.now(); }
  markActivity();

  // Periodic heartbeat & idle fallback poll
  const heartbeatTimer = setInterval(async () => {
    const now = Date.now();
    const idleMs = now - lastActivityMs;
    const uptimeSec = Math.round((now - startMs) / 1000);
    try {
      if (idleMs >= STALL_POLL_INTERVAL_MS) {
        // Fallback subgraph poll to kick pipeline if everything is quiet
        const fallback = await pollChainCandidatesOnce(cfg, chain, 250);
        agentLog.warn({ idleSec: Math.round(idleMs / 1000), fetched: fallback.length, uptimeSec }, 'stall-fallback-poll');
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

  const processCandidate = async (candidate: Candidate, source: 'subgraph' | 'realtime') => {
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

    counter.candidates.inc({ chain: chain.name });
  markActivity();

    const denyAssets = cfg.risk.denyAssets ?? [];
    if (denyAssets.includes(candidate.debt.symbol) || denyAssets.includes(candidate.collateral.symbol)) {
      counter.denylistSkip.inc({ chain: chain.name });
      await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: 'asset-denylist' });
      agentLog.debug({ borrower: candidate.borrower, debt: candidate.debt.symbol, collateral: candidate.collateral.symbol, source }, 'asset-denylist');
      return;
    }

    const policyEntry = lookupAssetPolicy(cfg.assets, candidate.debt.symbol);
    if (!policyEntry) {
      agentLog.warn({ asset: candidate.debt.symbol, source }, 'missing-policy');
      return;
    }
    const policy = policyEntry.value;

  const debtTokenEntry = lookupToken(chain.tokens, candidate.debt.symbol, candidate.debt.address);
  const collateralTokenEntry = lookupToken(chain.tokens, candidate.collateral.symbol, candidate.collateral.address);
    if (!debtTokenEntry || !collateralTokenEntry) {
      agentLog.warn({ candidate, source }, 'token-metadata-missing');
      return;
    }
    const { value: debtToken, key: debtTokenSymbol } = debtTokenEntry;
    const { value: collateralToken, key: collateralTokenSymbol } = collateralTokenEntry;

    const market = cfg.markets.find(
      (m) =>
        m.enabled &&
        m.chainId === candidate.chainId &&
        symbolsEqual(m.debtAsset, candidate.debt.symbol) &&
        symbolsEqual(m.collateralAsset, candidate.collateral.symbol)
    );
    if (!market) {
      agentLog.debug({ market: candidate, source }, 'market-disabled');
      return;
    }

    const client = publicClient(chain);

    const sequencer = await checkSequencerStatus({
      rpcUrl: chain.rpc,
      feed: chain.sequencerFeed,
      staleAfterSeconds: SEQUENCER_STALE_SECONDS,
      recoveryGraceSeconds: SEQUENCER_RECOVERY_GRACE_SECONDS,
    });
    if (!sequencer.ok) {
      counter.sequencerSkip.inc({ chain: chain.name });
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'policy_skip',
        reason: `sequencer ${sequencer.reason ?? 'unavailable'}`,
      });
      agentLog.debug({ borrower: candidate.borrower, reason: sequencer.reason, updatedAt: sequencer.updatedAt, source }, 'skip-sequencer');
      return;
    }

  let candSnapshot!: ReturnType<typeof serializeCandidate>;
  let plan: SimPlan | null = null;
  try {
      const throttleLimit = cfg.risk.maxAttemptsPerBorrowerHour ?? 0;
      if (!cfg.risk.dryRun) {
        if (await isThrottled(chain.id, candidate.borrower, throttleLimit)) {
          counter.throttled.inc({ chain: chain.name });
          await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'throttled' });
          agentLog.debug({ borrower: candidate.borrower, source }, 'throttled-skip');
          return;
        }
      }

      const debtPriceUsd = await oraclePriceUsd(client, debtToken);
      const collPriceUsd = await oraclePriceUsd(client, collateralToken);
      if (debtPriceUsd == null || collPriceUsd == null) {
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'policy_skip',
          reason: 'price-missing',
        });
        agentLog.debug({ borrower: candidate.borrower, debt: candidate.debt.symbol, collateral: candidate.collateral.symbol, source }, 'price-missing');
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
      candSnapshot = serializeCandidate({
        candidate,
        debtToken,
        collateralToken,
        debtPriceUsd,
        collateralPriceUsd: collPriceUsd,
        gapBps: gap,
        routeOptions,
      });
      if (gap > policy.gapCapBps) {
        counter.gapSkip.inc({ chain: chain.name });
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'gap_skip',
          reason: `gap ${gap}bps`,
          details: { candidate: candSnapshot },
        });
        agentLog.debug({ borrower: candidate.borrower, gap, source }, 'skip-gap');
        return;
      }

      let healthFactor: number | null = null;
      const hfMax = cfg.risk.healthFactorMax ?? 0.98;
      try {
        const pool = await poolAddress(chain);
        const accountData = (await client.readContract({
          abi: AAVE_POOL_ABI,
          address: pool,
          functionName: 'getUserAccountData',
          args: [candidate.borrower],
        })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
        healthFactor = wadToFloat(accountData[5]);
        if (!Number.isFinite(healthFactor) || healthFactor <= 0) {
          agentLog.warn({ borrower: candidate.borrower, source }, 'hf-invalid');
          await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: 'hf-invalid' });
          return;
        }
      } catch (hfErr) {
        agentLog.warn({ borrower: candidate.borrower, err: (hfErr as Error).message, source }, 'hf-fetch-failed');
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: 'hf-fetch-failed' });
        return;
      }

      const precommitEligible = shouldPrecommit({
        debtFeed: debtToken.chainlinkFeed,
        gapBps: candSnapshot.gapBps ?? gap,
        healthFactor: healthFactor ?? Number.POSITIVE_INFINITY,
        hfMax,
      });
      if ((healthFactor ?? 0) >= hfMax && !precommitEligible) {
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: `hf ${healthFactor?.toFixed(4)}` });
        agentLog.debug({ borrower: candidate.borrower, healthFactor, hfMax, source }, 'skip-health-factor');
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
        return;
      }
      if (!cfg.beneficiary) {
        agentLog.warn({ source }, 'missing-beneficiary-address');
        return;
      }
      const pk = privateKeyForChain(chain);
      if (!pk) {
        agentLog.warn({ source }, 'missing-private-key');
        return;
      }
      const executor = executorAddressForChain(chain);
      if (!executor) {
        agentLog.warn({ source }, 'missing-executor-address');
        return;
      }

      const simulateStart = performance.now();
      plan = await simulate({
        client,
        chain,
        contract,
        beneficiary: cfg.beneficiary,
        executor,
        borrower: candidate.borrower,
        debt: { ...debtToken, symbol: candidate.debt.symbol, amount: candidate.debt.amount },
        collateral: { ...collateralToken, symbol: candidate.collateral.symbol, amount: candidate.collateral.amount },
        closeFactor: (market.closeFactorBps ?? DEFAULT_CLOSE_FACTOR_BPS) / 10_000,
        bonusBps: market.bonusBps ?? DEFAULT_BONUS_BPS,
        routes: routeOptions,
        pricesUsd: { debt: debtPriceUsd, coll: collPriceUsd },
        policy,
        gasCapUsd: cfg.risk.gasCapUsd,
        maxRepayUsd: cfg.risk.maxRepayUsd,
        nativePriceUsd,
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
        }
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'policy_skip',
          reason: reason.join(' '),
          details: { candidate: candSnapshot },
        });
        return;
      }

      counter.plansReady.inc({ chain: chain.name });
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
      gauge.pnlPerGas.set(pnlPerGas);

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
          return;
        }
      }

      const sequencerPreSend = await checkSequencerStatus({
        rpcUrl: chain.rpc,
        feed: chain.sequencerFeed,
        staleAfterSeconds: SEQUENCER_STALE_SECONDS,
        recoveryGraceSeconds: SEQUENCER_RECOVERY_GRACE_SECONDS,
      });
      if (!sequencerPreSend.ok) {
        const reason = `sequencer ${sequencerPreSend.reason ?? 'unavailable'}`;
        agentLog.warn({ borrower: candidate.borrower, reason, source }, 'sequencer-down-skipping-tx');
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason });
        return;
      }

      await recordThrottleAttempt(chain.id, candidate.borrower, 3600);

      const minProfit = (plan.repayAmount * BigInt(policy.floorBps)) / 10_000n;
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

      const txHash = await sendLiquidation(
        chain.id,
        chain.rpc,
        pk,
        contract,
        {
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
        },
        chain.privtx,
      );
      if (plan.mode === 'funds') {
        counter.inventoryExecutions.inc({ chain: chain.name });
        inventoryCache.delete(`${chain.id}:${debtToken.address.toLowerCase()}`);
      }
      if (plan.precommit) {
        counter.precommitSuccess.inc({ chain: chain.name });
      }
      counter.plansSent.inc({ chain: chain.name });
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
      agentLog.info({ borrower: candidate.borrower, netBps: plan.estNetBps, txHash, repayUsd: plan.repayUsd, sessionNotionalUsd, healthFactor, source, trigger, mode: plan.mode, precommit: plan.precommit, pnlPerGas }, 'liquidation-sent');
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
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason, details: plan ? { plan: serializePlan(plan) } : undefined });
        const logFn = plan?.precommit ? agentLog.info.bind(agentLog) : agentLog.debug.bind(agentLog);
        logFn({ borrower: candidate.borrower, source, precommit: plan?.precommit }, 'skip-hf-recovered');
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
    }
  };

  try {
    while (true) {
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
        subgraphPromise = iterator.next();
      } else {
        const { done, value } = await subgraphPromise;
        if (done) break;
        await processCandidate(value, 'subgraph');
        subgraphPromise = iterator.next();
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    realtimeWatcher?.stop();
  }
}


async function main() {
  const cfg = loadConfig();
  await logPoolsAtBoot(cfg);
  await ensureAttemptTable();
  log.info({ chains: cfg.chains.length }, 'boot');

  const enabledChains = cfg.chains.filter((c) => c.enabled);
  if (enabledChains.length === 0) {
    log.warn('no chains enabled in config, exiting');
    return;
  }

  log.info({ chains: enabledChains.map(c => c.name) }, 'launching agents');
  const agents = enabledChains.map(chain => runChainAgent(chain, cfg));
  await Promise.all(agents);
  log.info('all agents finished');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
