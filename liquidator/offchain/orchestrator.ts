import './infra/env';
import { Address, createPublicClient, http } from 'viem';
import { loadConfig, chainById, liquidatorForChain, AppConfig, ChainCfg } from './infra/config';
import { log } from './infra/logger';
import { counter, gauge } from './infra/metrics';
import { isThrottled, recordAttempt as recordThrottleAttempt } from './infra/throttle';
import { ensureAttemptTable, recordAttemptRow } from './infra/attempts';
import { streamCandidates } from './indexer/aave_indexer';
import { oracleDexGapBps, oraclePriceUsd } from './indexer/price_watcher';
import { simulate } from './simulator/simulate';
import { sendLiquidation } from './executor/send_tx';
import { isPrivateConfigured } from './executor/mev_protect';
import { logPoolsAtBoot } from './infra/aave_provider';
import { buildRouteOptions } from './util/routes';
import { emitAlert } from './infra/alerts';
import { serializeCandidate, serializePlan, serializeRoutes, serializeError, type CandidateSnapshot, type PlanSnapshot } from './util/serialize';

const DEFAULT_CLOSE_FACTOR_BPS = 5000;
const DEFAULT_BONUS_BPS = 800;

const clients = new Map<number, ReturnType<typeof createPublicClient>>();
let plansReadyCount = 0;
let plansSentCount = 0;
let plansErrorCount = 0;
let lastFailAlertMs = 0;
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

function publicClient(chain: ChainCfg) {
  let client = clients.get(chain.id);
  if (!client) {
    client = createPublicClient({ transport: http(chain.rpc) });
    clients.set(chain.id, client);
  }
  return client;
}

function privateKeyForChain(chain: ChainCfg): `0x${string}` | undefined {
  switch (chain.name.toLowerCase()) {
    case 'ethereum':
    case 'mainnet':
    case 'eth':
      return process.env.WALLET_PK_ETH as `0x${string}` | undefined;
    case 'arbitrum':
      return process.env.WALLET_PK_ARB as `0x${string}` | undefined;
    case 'optimism':
    case 'op':
      return process.env.WALLET_PK_OP as `0x${string}` | undefined;
    case 'base':
      return process.env.WALLET_PK_BASE as `0x${string}` | undefined;
    case 'polygon':
      return process.env.WALLET_PK_POLYGON as `0x${string}` | undefined;
    default:
      return undefined;
  }
}

async function main() {
  const cfg = loadConfig();
  await logPoolsAtBoot(cfg);
  await ensureAttemptTable();
  // Visibility: which chains will use private lanes
  const privMap = Object.fromEntries(cfg.chains.map(c => [c.id, isPrivateConfigured(c.id)]));
  log.info({ chains: cfg.chains.length, privateLanes: privMap }, 'boot');

  for await (const candidate of streamCandidates(cfg)) {
    counter.candidates.inc();

    const chain = chainById(cfg, candidate.chainId);
    if (!chain) {
      log.warn({ chainId: candidate.chainId }, 'unknown-chain');
      continue;
    }

    const policy = cfg.assets[candidate.debt.symbol];
    if (!policy) {
      log.warn({ asset: candidate.debt.symbol }, 'missing-policy');
      continue;
    }

    const market = cfg.markets.find(
      (m) => m.enabled && m.chainId === candidate.chainId && m.debtAsset === candidate.debt.symbol && m.collateralAsset === candidate.collateral.symbol
    );
    if (!market) {
      log.debug({ market: candidate }, 'market-disabled');
      continue;
    }

    const client = publicClient(chain);
    const debtToken = chain.tokens[candidate.debt.symbol];
    const collateralToken = chain.tokens[candidate.collateral.symbol];
    if (!debtToken || !collateralToken) {
      log.warn({ candidate }, 'token-metadata-missing');
      continue;
    }

    const policySnapshot = {
      floorBps: policy.floorBps,
      gapCapBps: policy.gapCapBps,
      slippageBps: policy.slippageBps,
      gasCapUsd: cfg.risk.gasCapUsd,
    };

    let candidateDetails: CandidateSnapshot = serializeCandidate({
      candidate,
      debtToken,
      collateralToken,
    });
    let planSnapshot: PlanSnapshot | undefined;

    try {
      const throttleLimit = cfg.risk.maxAttemptsPerBorrowerHour ?? 0;
      if (!cfg.risk.dryRun) {
        if (await isThrottled(chain.id, candidate.borrower, throttleLimit)) {
          counter.throttled.inc();
          await recordAttemptRow({
            chainId: chain.id,
            borrower: candidate.borrower,
            status: 'throttled',
            details: { candidate: candidateDetails, policy: policySnapshot },
          });
          log.debug({ borrower: candidate.borrower, chain: chain.id }, 'throttled-skip');
          continue;
        }
      }

      const debtPriceUsd = (await oraclePriceUsd(client, debtToken)) ?? 1;
      const collPriceUsd = (await oraclePriceUsd(client, collateralToken)) ?? debtPriceUsd;
      const { options: routeOptions, gapFee, gapRouter } = buildRouteOptions(cfg, chain, candidate.debt.symbol, candidate.collateral.symbol);
      candidateDetails = {
        ...candidateDetails,
        debtPriceUsd,
        collateralPriceUsd: collPriceUsd,
        routeCandidates: serializeRoutes(routeOptions),
      };
      const gap = await oracleDexGapBps({
        client,
        chain,
        collateral: collateralToken,
        debt: debtToken,
        fee: gapFee,
        router: gapRouter,
      });
      candidateDetails = { ...candidateDetails, gapBps: gap };
      if (gap > policy.gapCapBps) {
        counter.gapSkip.inc();
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'gap_skip',
          reason: `gap ${gap}bps`,
          details: { candidate: candidateDetails, policy: policySnapshot },
        });
        log.debug({ borrower: candidate.borrower, chain: chain.id, gap }, 'skip-gap');
        continue;
      }

      log.debug({
        borrower: candidate.borrower,
        chain: chain.id,
        debtAmount: candidate.debt.amount.toString(),
        collateralAmount: candidate.collateral.amount.toString(),
        routes: routeOptions.map((r) => r.type),
      }, 'candidate-considered');

      const plan = await simulate({
        client,
        chain,
        debt: { ...debtToken, symbol: candidate.debt.symbol, amount: candidate.debt.amount },
        collateral: { ...collateralToken, symbol: candidate.collateral.symbol, amount: candidate.collateral.amount },
        closeFactor: (market.closeFactorBps ?? DEFAULT_CLOSE_FACTOR_BPS) / 10_000,
        bonusBps: market.bonusBps ?? DEFAULT_BONUS_BPS,
        routes: routeOptions,
        pricesUsd: { debt: debtPriceUsd, coll: collPriceUsd },
        policy,
        gasCapUsd: cfg.risk.gasCapUsd,
      });

      if (!plan) {
        log.debug({
          borrower: candidate.borrower,
          chain: chain.id,
          debtAmount: candidate.debt.amount.toString(),
          collateralAmount: candidate.collateral.amount.toString(),
          debtPriceUsd,
          collPriceUsd,
          gap,
          gasCapUsd: cfg.risk.gasCapUsd,
          routes: routeOptions.map((r) => r.type),
        }, 'plan-null');
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'policy_skip',
          reason: 'plan-null',
          details: { candidate: candidateDetails, policy: policySnapshot },
        });
        continue;
      }

      planSnapshot = serializePlan(plan);

      counter.plansReady.inc();
      plansReadyCount += 1;
      if (plansReadyCount > 0) {
        gauge.hitRate.set(plansSentCount / plansReadyCount);
      }

      if (cfg.risk.dryRun) {
        counter.plansDryRun.inc();
        await recordAttemptRow({
          chainId: chain.id,
          borrower: candidate.borrower,
          status: 'dry_run',
          reason: `netBps ${plan.estNetBps.toFixed(2)}`,
          details: { candidate: candidateDetails, plan: planSnapshot, policy: policySnapshot },
        });
        log.info({ borrower: candidate.borrower, chain: chain.id, repay: plan.repayAmount.toString(), netBps: plan.estNetBps }, 'DRY-RUN');
        continue;
      }

      await recordThrottleAttempt(chain.id, candidate.borrower, 3600);

      const contract = liquidatorForChain(cfg, chain.id);
      const pk = privateKeyForChain(chain);
      if (!contract || /^0x0+$/.test(contract)) {
        log.warn({ chain: chain.id }, 'missing-liquidator-address');
        continue;
      }
      if (!pk) {
        log.warn({ chain: chain.id }, 'missing-private-key');
        continue;
      }

      const minProfit = (plan.repayAmount * BigInt(policy.floorBps)) / 10_000n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

      const txHash = await sendLiquidation(chain.rpc, chain.id, pk, contract, {
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
      });
      counter.plansSent.inc();
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'sent',
        txHash,
        details: { candidate: candidateDetails, plan: planSnapshot, policy: policySnapshot },
      });
      plansSentCount += 1;
      if (plansReadyCount > 0) {
        gauge.hitRate.set(plansSentCount / plansReadyCount);
      }
      log.info({ borrower: candidate.borrower, chain: chain.id, netBps: plan.estNetBps }, 'liquidation-sent');
    } catch (err) {
      counter.plansError.inc();
      plansErrorCount += 1;
      const errorMessage = serializeError(err);
      await recordAttemptRow({
        chainId: chain.id,
        borrower: candidate.borrower,
        status: 'error',
        reason: errorMessage,
        details: { candidate: candidateDetails, plan: planSnapshot, policy: policySnapshot },
      });
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
            chain: chain.id,
            ratio: ratio.toFixed(2),
            attempts,
            errors: plansErrorCount,
          }, 'critical');
        }
      }
      log.error({ err: (err as Error).message, borrower: candidate.borrower, chain: chain.id }, 'candidate-failed');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
