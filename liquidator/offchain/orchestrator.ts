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
import { RouteOption } from './simulator/router';
import { sendLiquidation } from './executor/send_tx';
import { logPoolsAtBoot } from './infra/aave_provider';

const DEFAULT_CLOSE_FACTOR_BPS = 5000;
const DEFAULT_BONUS_BPS = 800;
const DEFAULT_UNI_FEES = [500, 3000];

const clients = new Map<number, ReturnType<typeof createPublicClient>>();
let plansReadyCount = 0;
let plansSentCount = 0;

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
    case 'arbitrum':
      return process.env.WALLET_PK_ARB as `0x${string}` | undefined;
    case 'optimism':
    case 'op':
      return process.env.WALLET_PK_OP as `0x${string}` | undefined;
    default:
      return undefined;
  }
}

function buildRouteOptions(
  cfg: AppConfig,
  chain: ChainCfg,
  debtSymbol: string,
  collateralSymbol: string
): { options: RouteOption[]; gapFee: number; gapRouter?: Address } {
  const prefer = cfg.routing?.prefer?.[chain.id]?.[`${debtSymbol}-${collateralSymbol}`]
    ?? cfg.routing?.prefer?.[chain.id]?.[`${collateralSymbol}-${debtSymbol}`];
  const chainDex = cfg.dexRouters?.[chain.id];
  const uniRouter = (chainDex?.uniV3 ?? chain.uniV3Router) as Address | undefined;
  const options: RouteOption[] = [];
  const seenUni = new Set<number>();
  let gapFee: number | undefined;
  let gapRouter: Address | undefined;

  const pushUni = (fee: number) => {
    if (!uniRouter || !Number.isFinite(fee)) return;
    if (seenUni.has(fee)) return;
    seenUni.add(fee);
    options.push({ type: 'UniV3', router: uniRouter, fee });
    if (gapFee === undefined) {
      gapFee = fee;
      gapRouter = uniRouter;
    }
  };

  const pushUniDefaults = () => {
    for (const fee of DEFAULT_UNI_FEES) pushUni(fee);
  };

  const pushCamelot = () => {
    const router = chainDex?.camelotV2 as Address | undefined;
    if (router) options.push({ type: 'UniV2', router });
  };

  const pushSolidly = (router?: string, factory?: string, stable = false) => {
    if (!router || !factory) return;
    options.push({ type: 'SolidlyV2', router: router as Address, factory: factory as Address, stable });
  };

  if (Array.isArray(prefer) && prefer.length) {
    for (const raw of prefer) {
      const entry = String(raw).trim();
      const lower = entry.toLowerCase();
      const uniMatch = /^univ3:(\d+)$/.exec(lower);
      if (uniMatch) {
        pushUni(Number(uniMatch[1]));
        continue;
      }
      if (lower === 'univ3') {
        pushUniDefaults();
        continue;
      }
      if (lower.startsWith('camelot')) {
        pushCamelot();
        continue;
      }
      if (lower.startsWith('velodrome')) {
        const stable = lower.includes(':stable');
        pushSolidly(chainDex?.velodrome, chainDex?.velodromeFactory, stable);
        continue;
      }
      if (lower.startsWith('aerodrome')) {
        const stable = lower.includes(':stable');
        pushSolidly(chainDex?.aerodrome, chainDex?.aerodromeFactory, stable);
        continue;
      }
    }
  }

  if (!options.length) {
    pushUniDefaults();
  }

  if (gapRouter === undefined && uniRouter) {
    gapRouter = uniRouter;
  }

  return { options, gapFee: gapFee ?? DEFAULT_UNI_FEES[0], gapRouter };
}

async function main() {
  const cfg = loadConfig();
  await logPoolsAtBoot(cfg);
  if (!cfg.risk.dryRun) {
    await ensureAttemptTable();
  }
  log.info({ chains: cfg.chains.length }, 'boot');

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

    try {
      const throttleLimit = cfg.risk.maxAttemptsPerBorrowerHour ?? 0;
      if (!cfg.risk.dryRun) {
        if (await isThrottled(chain.id, candidate.borrower, throttleLimit)) {
          counter.throttled.inc();
          await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'throttled' });
          log.debug({ borrower: candidate.borrower, chain: chain.id }, 'throttled-skip');
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
        counter.gapSkip.inc();
        if (!cfg.risk.dryRun) {
          await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'gap_skip', reason: `gap ${gap}bps` });
        }
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
        if (!cfg.risk.dryRun) {
          await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'policy_skip', reason: 'plan-null' });
        }
        continue;
      }

      counter.plansReady.inc();
      plansReadyCount += 1;
      if (plansReadyCount > 0) {
        gauge.hitRate.set(plansSentCount / plansReadyCount);
      }

      if (cfg.risk.dryRun) {
        counter.plansDryRun.inc();
        // Skip DB writes in dry-run mode
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

      await sendLiquidation(chain.rpc, pk, contract, {
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
      await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'sent' });
      plansSentCount += 1;
      if (plansReadyCount > 0) {
        gauge.hitRate.set(plansSentCount / plansReadyCount);
      }
      log.info({ borrower: candidate.borrower, chain: chain.id, netBps: plan.estNetBps }, 'liquidation-sent');
    } catch (err) {
      counter.plansError.inc();
      if (!cfg.risk.dryRun) {
        await recordAttemptRow({ chainId: chain.id, borrower: candidate.borrower, status: 'error', reason: (err as Error).message });
      }
      log.error({ err: (err as Error).message, borrower: candidate.borrower, chain: chain.id }, 'candidate-failed');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
