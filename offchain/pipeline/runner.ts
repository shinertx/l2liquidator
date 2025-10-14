import '../infra/env';
import '../infra/metrics_server';
import { performance } from 'perf_hooks';
import { Address } from 'viem';
import { loadConfig, type AppConfig, type ChainCfg, type TokenInfo } from '../infra/config';
import { log } from '../infra/logger';
import type { Logger } from 'pino';
import { counter, gauge, histogram } from '../infra/metrics';
import { startCandidateWatchers } from './watchers';
import type { QueuedCandidate, ScoredPlan, ScoreRejection } from './types';
import { isKillSwitchActive, killSwitchPath } from '../infra/kill_switch';
import { checkSequencerStatus } from '../infra/sequencer';
import { isThrottled, recordAttempt as recordThrottleAttempt } from '../infra/throttle';
import { ensureAttemptTable, recordAttemptRow } from '../infra/attempts';
import { Scorer } from './scorer';
import { sendLiquidation } from '../executor/send_tx';
import type { BuildArgs } from '../executor/build_tx';
import { privateKeyForChain } from '../infra/accounts';
import { lookupToken } from '../util/symbols';
import { normalizeDropReason } from '../util/drop_reason';
import type { Candidate } from '../indexer/aave_indexer';
import { getPublicClient, type ManagedClient } from '../infra/rpc_clients';
import { liquidatorForChain } from '../infra/config';
import { emitAlert } from '../infra/alerts';

const AUTO_STOP_ON_FAIL_RATE = process.env.FAIL_RATE_AUTO_STOP === '1';
const INVENTORY_MODE = process.env.INVENTORY_MODE !== '0';
const INVENTORY_REFRESH_MS = Number(process.env.INVENTORY_REFRESH_MS ?? 10_000);
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const THROTTLE_WINDOW_SEC = 3600;

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

type InventorySnapshot = { balance: bigint; fetchedAt: number };

function parseNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function recordCandidateDrop(chainName: string, code: string): void {
  const normalized = normalizeDropReason(code)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
  counter.candidateDrops.labels({ chain: chainName, reason: normalized }).inc();
}

class PipelineRunner {
  private readonly scorer: Scorer;
  private readonly runnerLog = log.child({ module: 'pipeline.runner' });
  private running = true;
  private plansReadyCount = 0;
  private plansSentCount = 0;
  private plansErrorCount = 0;
  private sessionNotionalUsd = 0;
  private lastFailAlertMs = 0;
  private readonly inventoryCache = new Map<string, InventorySnapshot>();

  constructor(private readonly cfg: AppConfig, private readonly stopWatchers: () => void) {
    this.scorer = new Scorer(cfg);
  }

  async run(queue: AsyncIterable<QueuedCandidate>): Promise<void> {
    for await (const item of queue) {
      if (!this.running) break;
      try {
        await this.handleCandidate(item);
      } catch (err) {
        this.runnerLog.error({
          err: err instanceof Error ? err.message : String(err),
          chainId: item.chain.id,
          borrower: item.candidate.borrower,
        }, 'candidate-processing-failed');
      }
    }
  }

  stop(reason: string): void {
    if (!this.running) return;
    this.running = false;
    this.runnerLog.warn({ reason }, 'runner-stopping');
    this.stopWatchers();
  }

  private async handleCandidate(item: QueuedCandidate): Promise<void> {
    const { candidate, chain, source } = item;
  const candidateLog = this.runnerLog.child({ chain: chain.name, borrower: candidate.borrower, source }) as Logger;

    if (isKillSwitchActive()) {
      const path = killSwitchPath();
      candidateLog.error({ killSwitch: path ?? 'env-only' }, 'kill-switch-triggered');
      this.stop('kill-switch');
      return;
    }

    if (!chain.enabled) {
      candidateLog.debug('chain-disabled');
      return;
    }

    if (candidate.chainId !== chain.id) {
      candidateLog.debug({ candidateChain: candidate.chainId }, 'chain-mismatch');
      return;
    }

    counter.candidates.labels({ chain: chain.name }).inc();
    if (Number.isFinite(candidate.healthFactor) && candidate.healthFactor > 0) {
      histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'candidate' }, candidate.healthFactor);
    }

    const throttleLimit = chain.risk?.maxAttemptsPerBorrowerHour ?? this.cfg.risk.maxAttemptsPerBorrowerHour ?? 0;
    if (!this.cfg.risk.dryRun && throttleLimit > 0) {
      const throttled = await isThrottled(chain.id, candidate.borrower, throttleLimit);
      if (throttled) {
        counter.throttled.inc({ chain: chain.name });
        recordCandidateDrop(chain.name, 'throttled');
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'throttled' });
        candidateLog.debug('throttled-skip');
        return;
      }
    }

    const sequencer = await checkSequencerStatus({
      rpcUrl: chain.rpc,
      feed: chain.sequencerFeed,
      staleAfterSeconds: parseNumberEnv('SEQUENCER_STALE_SECS', Number.POSITIVE_INFINITY),
      recoveryGraceSeconds: parseNumberEnv('SEQUENCER_GRACE_SECS', 120),
    });
    gauge.sequencerStatus.labels({ chain: chain.name, stage: 'pre_sim' }).set(sequencer.ok ? 1 : 0);
    if (!sequencer.ok) {
      const reason = `sequencer ${sequencer.reason ?? 'unavailable'}`;
      counter.sequencerSkip.inc({ chain: chain.name, reason: sequencer.reason ?? 'unknown' });
      recordCandidateDrop(chain.name, `sequencer_${sequencer.reason ?? 'unknown'}`);
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'policy_skip',
        reason,
        details: { sequencer },
      });
      candidateLog.debug({ reason }, 'sequencer-skip');
      return;
    }

    const outcome = await this.scorer.score(item);
    if ('plan' in outcome) {
      await this.handlePlan(candidateLog, item, outcome);
    } else {
      await this.handleRejection(candidateLog, item, outcome);
    }
  }

  private async handleRejection(
    candidateLog: Logger,
    item: QueuedCandidate,
    outcome: ScoreRejection,
  ): Promise<void> {
    const { chain, candidate } = item;
    const reason = outcome.reason;
    const detail = outcome.detail;
    const snapshot = outcome.snapshot;

    switch (reason) {
      case 'asset-denylist':
        counter.denylistSkip.inc({ chain: chain.name, debt: candidate.debt.symbol, collateral: candidate.collateral.symbol });
        break;
      case 'gap-exceeds-cap':
        counter.gapSkip.inc({ chain: chain.name });
        if (Number.isFinite(candidate.healthFactor) && candidate.healthFactor > 0) {
          histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'gap_skip' }, candidate.healthFactor);
        }
        break;
      case 'plan-null':
        if (Number.isFinite(candidate.healthFactor) && candidate.healthFactor > 0) {
          histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'plan_null' }, candidate.healthFactor);
        }
        break;
      case 'health-factor-above-max':
        if (Number.isFinite(candidate.healthFactor) && candidate.healthFactor > 0) {
          histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'hf_above_max' }, candidate.healthFactor);
        }
        break;
      default:
        break;
    }

    recordCandidateDrop(chain.name, reason);

    const attemptStatus = reason === 'gap-exceeds-cap' ? 'gap_skip' : 'policy_skip';
    const attemptReason = typeof detail === 'string' ? detail : reason;
    await recordAttemptRow({
      chainId: chain.id,
      borrower: candidate.borrower,
      status: attemptStatus,
      reason: attemptReason,
      details: snapshot ? { candidate: snapshot, detail } : { detail },
    });

    candidateLog.debug({ reason, detail }, 'candidate-rejected');
  }

  private async handlePlan(
    candidateLog: Logger,
    item: QueuedCandidate,
    scored: ScoredPlan,
  ): Promise<void> {
    const { candidate, chain } = item;
    const { plan, metrics, snapshot } = scored;

    if (!plan.mode) {
      plan.mode = 'flash';
    }
    if (plan.precommit === undefined) {
      plan.precommit = false;
    }
    snapshot.plan.executionMode = plan.mode;
    snapshot.plan.precommit = plan.precommit;
    if (typeof plan.pnlPerGas === 'number') {
      snapshot.plan.pnlPerGas = plan.pnlPerGas;
    }

    if (metrics.simulateSeconds && metrics.simulateSeconds > 0) {
      histogram.simulateDuration.observe(metrics.simulateSeconds);
    }

    counter.plansReady.inc({ chain: chain.name });
    this.plansReadyCount += 1;
    if (Number.isFinite(candidate.healthFactor) && candidate.healthFactor > 0) {
      histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'plan_ready' }, candidate.healthFactor);
    }
    if (this.plansReadyCount > 0) {
      gauge.hitRate.set(this.plansSentCount / this.plansReadyCount);
    }

    const planPnlPerGas = plan.pnlPerGas ?? (plan.gasUsd > 0 ? plan.netUsd / plan.gasUsd : Number.POSITIVE_INFINITY);
    gauge.pnlPerGas.labels({ chain: chain.name }).set(planPnlPerGas);

    if (plan.minProfit <= 0n) {
      recordCandidateDrop(chain.name, 'min_profit_zero');
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'policy_skip',
        reason: 'min-profit-zero',
        details: { candidate: snapshot.candidate, plan: snapshot.plan },
      });
      candidateLog.warn('min-profit-zero-skip');
      return;
    }

    if (this.cfg.risk.pnlPerGasMin > 0 && plan.gasUsd > 0 && planPnlPerGas < this.cfg.risk.pnlPerGasMin) {
      recordCandidateDrop(chain.name, 'pnl_per_gas_floor');
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'policy_skip',
        reason: `pnl/gas ${planPnlPerGas.toFixed(2)} < ${this.cfg.risk.pnlPerGasMin}`,
        details: { candidate: snapshot.candidate, plan: snapshot.plan, pnlPerGas: planPnlPerGas },
      });
      candidateLog.debug({ pnlPerGas: planPnlPerGas }, 'skip-pnl-per-gas');
      return;
    }

    if (this.cfg.risk.dryRun) {
      counter.plansDryRun.inc({ chain: chain.name });
      if (Number.isFinite(candidate.healthFactor) && candidate.healthFactor > 0) {
        histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'dry_run' }, candidate.healthFactor);
      }
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'dry_run',
        reason: `netBps ${plan.estNetBps.toFixed(2)}`,
        details: { candidate: snapshot.candidate, plan: snapshot.plan },
      });
      recordCandidateDrop(chain.name, 'dry_run');
      candidateLog.info({ netBps: plan.estNetBps }, 'dry-run-plan');
      return;
    }

    const sequencerPreSend = await checkSequencerStatus({
      rpcUrl: chain.rpc,
      feed: chain.sequencerFeed,
      staleAfterSeconds: parseNumberEnv('SEQUENCER_STALE_SECS', Number.POSITIVE_INFINITY),
      recoveryGraceSeconds: parseNumberEnv('SEQUENCER_GRACE_SECS', 120),
    });
    gauge.sequencerStatus.labels({ chain: chain.name, stage: 'pre_send' }).set(sequencerPreSend.ok ? 1 : 0);
    if (!sequencerPreSend.ok) {
      const reason = `sequencer ${sequencerPreSend.reason ?? 'unavailable'}`;
      counter.sequencerSkip.inc({ chain: chain.name, reason: sequencerPreSend.reason ?? 'unknown' });
      recordCandidateDrop(chain.name, `sequencer_${sequencerPreSend.reason ?? 'pre_send'}`);
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'policy_skip',
        reason,
        details: { candidate: snapshot.candidate, plan: snapshot.plan },
      });
      candidateLog.warn({ reason }, 'sequencer-pre-send-skip');
      return;
    }

    const pk = privateKeyForChain(chain);
    if (!pk) {
      recordCandidateDrop(chain.name, 'missing_pk');
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'policy_skip',
        reason: 'missing-private-key',
        details: { candidate: snapshot.candidate, plan: snapshot.plan },
      });
      candidateLog.error('missing-private-key');
      return;
    }

    const contract = liquidatorForChain(this.cfg, chain.id);
    if (!contract) {
      recordCandidateDrop(chain.name, 'missing_contract');
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'policy_skip',
        reason: 'missing-liquidator-address',
        details: { candidate: snapshot.candidate, plan: snapshot.plan },
      });
      candidateLog.error('missing-liquidator');
      return;
    }

    if (INVENTORY_MODE) {
      await this.updateInventoryMode(chain, contract, candidate, plan, candidateLog);
      snapshot.plan.executionMode = plan.mode;
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    await recordThrottleAttempt(chain.id, candidate.borrower, THROTTLE_WINDOW_SEC);

    if (
      this.cfg.risk.maxLiveExecutions !== undefined &&
      this.cfg.risk.maxLiveExecutions > 0 &&
      this.plansSentCount >= this.cfg.risk.maxLiveExecutions
    ) {
      candidateLog.warn({ maxLiveExecutions: this.cfg.risk.maxLiveExecutions }, 'live-execution-cap-hit');
      this.stop('live-execution-cap');
      return;
    }

    if (
      this.cfg.risk.maxSessionNotionalUsd !== undefined &&
      this.cfg.risk.maxSessionNotionalUsd > 0 &&
      this.sessionNotionalUsd + scored.plan.repayUsd > this.cfg.risk.maxSessionNotionalUsd
    ) {
      candidateLog.warn({
        pendingRepayUsd: scored.plan.repayUsd,
        sessionNotionalUsd: this.sessionNotionalUsd,
        maxSessionNotionalUsd: this.cfg.risk.maxSessionNotionalUsd,
      }, 'session-notional-cap-hit');
      this.stop('session-notional-cap');
      return;
    }

    const sendStart = performance.now();
    try {
      let buildArgs: BuildArgs;
      if (plan.protocol === 'morphoblue') {
        if (!plan.morpho) {
          candidateLog.error('morpho-plan-missing');
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
          minProfit: plan.minProfit,
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
          minProfit: plan.minProfit,
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
      const latencySeconds = (performance.now() - sendStart) / 1000;
      histogram.sendLatency.observe(latencySeconds);
      if (plan.mode === 'funds') {
        counter.inventoryExecutions.inc({ chain: chain.name });
      }
      counter.plansSent.inc({ chain: chain.name });
      this.plansSentCount += 1;
      this.sessionNotionalUsd += scored.plan.repayUsd;
      if (Number.isFinite(candidate.healthFactor) && candidate.healthFactor > 0) {
        histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'sent' }, candidate.healthFactor);
      }
      const sentReason = Number.isFinite(candidate.healthFactor) ? `hf ${candidate.healthFactor.toFixed(4)}` : undefined;
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'sent',
        reason: sentReason,
        txHash,
        details: { candidate: snapshot.candidate, plan: snapshot.plan, txHash, pnlPerGas: planPnlPerGas },
      });
      if (this.plansReadyCount > 0) {
        gauge.hitRate.set(this.plansSentCount / this.plansReadyCount);
      }
      const attempts = this.plansSentCount + this.plansErrorCount;
      const failureRatio = attempts > 0 ? this.plansErrorCount / attempts : 0;
      gauge.failureRate.labels({ chain: chain.name }).set(failureRatio);
      if (plan.netUsd > 0) {
        counter.profitEstimated.inc({ chain: chain.name, mode: plan.mode ?? 'flash' }, plan.netUsd);
      }
      candidateLog.info({ txHash, netUsd: plan.netUsd, netBps: plan.estNetBps, pnlPerGas: planPnlPerGas }, 'liquidation-sent');
    } catch (err) {
      await this.handleSendError(candidateLog, item, scored, err as Error);
    }
  }

  private async handleSendError(
    candidateLog: Logger,
    item: QueuedCandidate,
    scored: ScoredPlan,
    err: Error,
  ): Promise<void> {
    const { chain, candidate } = item;
    const message = err.message || err.toString();

    if (message === 'HealthFactorNotBelowThreshold') {
      recordCandidateDrop(chain.name, 'hf_recovered');
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'policy_skip',
        reason: scored.plan.precommit ? 'hf-precommit-revert' : 'hf-recovered',
        details: { plan: scored.snapshot.plan },
      });
      if (Number.isFinite(candidate.healthFactor) && candidate.healthFactor > 0) {
        histogram.candidateHealthFactor.observe({ chain: chain.name, stage: 'recovered' }, candidate.healthFactor);
      }
      candidateLog.info({ reason: message }, 'skip-hf-recovered');
      return;
    }

    counter.plansError.inc({ chain: chain.name });
    this.plansErrorCount += 1;
    await recordAttemptRow({
      chainId: chain.id,
      borrower: candidate.borrower,
      status: 'error',
      reason: message,
      details: { candidate: scored.snapshot.candidate, plan: scored.snapshot.plan },
    });
    const attempts = this.plansSentCount + this.plansErrorCount;
    const ratio = attempts > 0 ? this.plansErrorCount / attempts : 0;
    gauge.failureRate.labels({ chain: chain.name }).set(ratio);

    if (
      !this.cfg.risk.dryRun &&
      attempts >= 5 &&
      this.cfg.risk.failRateCap > 0 &&
      ratio > this.cfg.risk.failRateCap &&
      Date.now() - this.lastFailAlertMs > ALERT_COOLDOWN_MS
    ) {
      this.lastFailAlertMs = Date.now();
      await emitAlert('Liquidations fail-rate above threshold', {
        chain: chain.name,
        ratio: ratio.toFixed(2),
        attempts,
        errors: this.plansErrorCount,
      }, 'critical');
      if (AUTO_STOP_ON_FAIL_RATE) {
        candidateLog.error({ ratio, attempts, errors: this.plansErrorCount }, 'fail-rate-cap-exceeded');
        this.stop('fail-rate-cap');
      }
    }

    candidateLog.error({ err: message }, 'send-liquidation-failed');
    recordCandidateDrop(chain.name, 'send_error');
  }

  private async updateInventoryMode(
    chain: ChainCfg,
    contract: `0x${string}`,
    candidate: Candidate,
    plan: ScoredPlan['plan'],
    candidateLog: Logger,
  ): Promise<void> {
    const debtTokenEntry = lookupToken(chain.tokens, candidate.debt.symbol, candidate.debt.address);
    if (!debtTokenEntry) return;
    const { value: debtToken } = debtTokenEntry;
    const client = getPublicClient(chain);
    try {
      const balance = await this.inventoryBalance(chain, debtToken, contract, client);
      const normalized = Number(balance) / Math.pow(10, debtToken.decimals);
      if (Number.isFinite(normalized)) {
        gauge.inventoryBalance.labels({ chain: chain.name, token: candidate.debt.symbol }).set(normalized);
      }
      if (balance >= plan.repayAmount) {
        plan.mode = 'funds';
        candidateLog.debug({ balance: balance.toString() }, 'inventory-mode-enabled');
      } else {
        plan.mode = 'flash';
      }
    } catch (err) {
      candidateLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'inventory-balance-failed');
      plan.mode = 'flash';
    }
  }

  private async inventoryBalance(
    chain: ChainCfg,
    token: TokenInfo,
    contract: Address,
    client: ManagedClient,
  ): Promise<bigint> {
    const key = `${chain.id}:${token.address.toLowerCase()}`;
    const now = Date.now();
    const cached = this.inventoryCache.get(key);
    if (cached && now - cached.fetchedAt < INVENTORY_REFRESH_MS) {
      return cached.balance;
    }
    const balance = (await client.readContract({
      address: token.address as Address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [contract],
    })) as bigint;
    this.inventoryCache.set(key, { balance, fetchedAt: now });
    return balance;
  }
}

async function main() {
  const cfg = loadConfig();
  await ensureAttemptTable();
  const watchers = startCandidateWatchers(cfg);
  const runner = new PipelineRunner(cfg, watchers.stop);

  const abort = () => runner.stop('signal');
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  try {
    await runner.run(watchers.queue);
  } finally {
    watchers.stop();
  }
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'pipeline-runner-fatal');
  process.exit(1);
});
