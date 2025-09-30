import './infra/env';
import { Address, createPublicClient, http } from 'viem';
import { loadConfig, chainById, liquidatorForChain, ChainCfg, AppConfig } from './infra/config';
import { executorAddressForChain, privateKeyForChain } from './infra/accounts';
import { log } from './infra/logger';
import { counter, gauge } from './infra/metrics';
import { isThrottled, recordAttempt as recordThrottleAttempt } from './infra/throttle';
import { ensureAttemptTable, recordAttemptRow } from './infra/attempts';
import { streamCandidates } from './indexer/aave_indexer';
import { oracleDexGapBps, oraclePriceUsd } from './indexer/price_watcher';
import { simulate } from './simulator/simulate';
import { sendLiquidation } from './executor/send_tx';
import { getPoolFromProvider, logPoolsAtBoot } from './infra/aave_provider';
import { buildRouteOptions } from './util/routes';
import { emitAlert } from './infra/alerts';

const DEFAULT_CLOSE_FACTOR_BPS = 5000;
const DEFAULT_BONUS_BPS = 800;
const RAY = 10n ** 27n;
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

function rayToFloat(value: bigint): number {
  if (value === 0n) return 0;
  return Number(value) / Number(RAY);
}

function publicClient(chain: ChainCfg) {
  let client = clients.get(chain.id);
  if (!client) {
    client = createPublicClient({ transport: http(chain.rpc) });
    clients.set(chain.id, client);
  }
  return client;
}

// --- Chain Agent --- 

async function runChainAgent(chain: ChainCfg, cfg: AppConfig) {
  const agentLog = log.child({ chain: chain.name, chainId: chain.id });
  agentLog.info('starting agent');

  for await (const candidate of streamCandidates(cfg)) {
    // This agent only handles candidates for its own chain
    if (candidate.chainId !== chain.id) {
      continue;
    }

    counter.candidates.inc({ chain: chain.name });

    const policy = cfg.assets[candidate.debt.symbol];
    if (!policy) {
      agentLog.warn({ asset: candidate.debt.symbol }, 'missing-policy');
      continue;
    }

    const market = cfg.markets.find(
      (m) => m.enabled && m.chainId === candidate.chainId && m.debtAsset === candidate.debt.symbol && m.collateralAsset === candidate.collateral.symbol
    );
    if (!market) {
      agentLog.debug({ market: candidate }, 'market-disabled');
      continue;
    }

    const client = publicClient(chain);
    const debtToken = chain.tokens[candidate.debt.symbol];
    const collateralToken = chain.tokens[candidate.collateral.symbol];
    if (!debtToken || !collateralToken) {
      agentLog.warn({ candidate }, 'token-metadata-missing');
      continue;
    }

    try {
      const throttleLimit = cfg.risk.maxAttemptsPerBorrowerHour ?? 0;
      if (!cfg.risk.dryRun) {
        if (await isThrottled(chain.id, candidate.borrower, throttleLimit)) {
          counter.throttled.inc({ chain: chain.name });
          await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'throttled' });
          agentLog.debug({ borrower: candidate.borrower }, 'throttled-skip');
          continue;
        }
      }

      const debtPriceUsd = (await oraclePriceUsd(client, debtToken)) ?? 1;
      const collPriceUsd = (await oraclePriceUsd(client, collateralToken)) ?? debtPriceUsd;
      const { options: routeOptions, gapFee, gapRouter } = buildRouteOptions(cfg, chain, candidate.debt.symbol, candidate.collateral.symbol);
      const gap = await oracleDexGapBps({
        client,
        chain,
        collateral: collateralToken,
        debt: debtToken,
        fee: gapFee,
        router: gapRouter,
      });
      if (gap > policy.gapCapBps) {
        counter.gapSkip.inc({ chain: chain.name });
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'gap_skip', reason: `gap ${gap}bps` });
        agentLog.debug({ borrower: candidate.borrower, gap }, 'skip-gap');
        continue;
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
        healthFactor = rayToFloat(accountData[5]);
        if (!Number.isFinite(healthFactor) || healthFactor <= 0) {
          agentLog.warn({ borrower: candidate.borrower }, 'hf-invalid');
          await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: 'hf-invalid' });
          continue;
        }
        if (healthFactor >= hfMax) {
          await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: `hf ${healthFactor.toFixed(4)}` });
          agentLog.debug({ borrower: candidate.borrower, healthFactor, hfMax }, 'skip-health-factor');
          continue;
        }
      } catch (hfErr) {
        agentLog.warn({ borrower: candidate.borrower, err: (hfErr as Error).message }, 'hf-fetch-failed');
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: 'hf-fetch-failed' });
        continue;
      }

      agentLog.debug({
        borrower: candidate.borrower,
        debtAmount: candidate.debt.amount.toString(),
        collateralAmount: candidate.collateral.amount.toString(),
        routes: routeOptions.map((r) => r.type),
        healthFactor,
        hfMax,
      }, 'candidate-considered');

      const contract = liquidatorForChain(cfg, chain.id);
      if (!contract || /^0x0+$/.test(contract)) {
        agentLog.warn('missing-liquidator-address');
        continue;
      }
      if (!cfg.beneficiary) {
        agentLog.warn('missing-beneficiary-address');
        continue;
      }
      const pk = privateKeyForChain(chain);
      if (!pk) {
        agentLog.warn('missing-private-key');
        continue;
      }
      const executor = executorAddressForChain(chain);
      if (!executor) {
        agentLog.warn('missing-executor-address');
        continue;
      }

      const plan = await simulate({
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
      });

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
        }, 'plan-null');
        const reason = ['plan-null'];
        if (healthFactor !== null) {
          reason.push(`hf ${healthFactor.toFixed(4)}`);
        }
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: reason.join(' ') });
        continue;
      }

      counter.plansReady.inc({ chain: chain.name });
      plansReadyCount += 1;
      if (plansReadyCount > 0) {
        gauge.hitRate.set(plansSentCount / plansReadyCount);
      }

      if (cfg.risk.dryRun) {
        counter.plansDryRun.inc({ chain: chain.name });
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'dry_run', reason: `netBps ${plan.estNetBps.toFixed(2)}` });
        agentLog.info({ borrower: candidate.borrower, repay: plan.repayAmount.toString(), netBps: plan.estNetBps }, 'DRY-RUN');
        continue;
      }

      await recordThrottleAttempt(chain.id, candidate.borrower, 3600);

      const minProfit = (plan.repayAmount * BigInt(policy.floorBps)) / 10_000n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

      if (
        cfg.risk.maxLiveExecutions !== undefined &&
        cfg.risk.maxLiveExecutions > 0 &&
        plansSentCount >= cfg.risk.maxLiveExecutions
      ) {
        agentLog.warn({ txnIdx: plansSentCount, maxLiveExecutions: cfg.risk.maxLiveExecutions }, 'live-execution-cap-reached');
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
          },
          'session-notional-cap-hit'
        );
        process.exit(0);
      }

      const txHash = await sendLiquidation(
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
        },
        chain.privtx,
      );
      counter.plansSent.inc({ chain: chain.name });
      const sentReason = healthFactor !== null ? `hf ${healthFactor.toFixed(4)}` : undefined;
      await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'sent', reason: sentReason });
      plansSentCount += 1;
      sessionNotionalUsd += plan.repayUsd;
      if (plansReadyCount > 0) {
        gauge.hitRate.set(plansSentCount / plansReadyCount);
      }
      agentLog.info({ borrower: candidate.borrower, netBps: plan.estNetBps, txHash, repayUsd: plan.repayUsd, sessionNotionalUsd, healthFactor }, 'liquidation-sent');

      if (
        cfg.risk.maxLiveExecutions !== undefined &&
        cfg.risk.maxLiveExecutions > 0 &&
        plansSentCount >= cfg.risk.maxLiveExecutions
      ) {
        agentLog.warn({ maxLiveExecutions: cfg.risk.maxLiveExecutions }, 'live-execution-cap-hit-stopping');
        process.exit(0);
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'HealthFactorNotBelowThreshold') {
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: 'hf-recovered' });
        agentLog.debug({ borrower: candidate.borrower }, 'skip-hf-recovered');
        continue;
      }

      counter.plansError.inc({ chain: chain.name });
      plansErrorCount += 1;
      await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'error', reason: (err as Error).message });
      if (!cfg.risk.dryRun) {
        const attempts = plansSentCount + plansErrorCount;
        const ratio = attempts > 0 ? plansErrorCount / attempts : 0;
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
        }
      }
      agentLog.error({ err: (err as Error).message, borrower: candidate.borrower }, 'candidate-failed');
    }
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
