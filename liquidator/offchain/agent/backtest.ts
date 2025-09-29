import '../infra/env';
import { createPublicClient, http } from 'viem';

import { loadConfig, chainById, AppConfig, Market } from '../infra/config';
import { log } from '../infra/logger';
import { db } from '../infra/db';
import { buildRouteOptions } from '../util/routes';
import { simulate, Plan as SimPlan } from '../simulator/simulate';
import { oraclePriceUsd } from '../indexer/price_watcher';

const DEFAULT_CLOSE_FACTOR_BPS = 5000;
const DEFAULT_BONUS_BPS = 800;

const hasDb = Boolean(process.env.DATABASE_URL);

export type BacktestOptions = {
  config?: AppConfig;
  configPath?: string;
  limit?: number;
  seconds?: number;
};

export type BacktestResult = {
  samples: number;
  newPlans: number;
  newAvgNetBps: number;
  baselinePlans: number;
  baselineAvgNetBps: number;
  baselineErrorRate: number;
  skipped: number;
  failures: Array<{ borrower: string; chainId: number; reason: string }>;
};

type AttemptRow = {
  chain_id: number;
  borrower: string;
  status: string;
  details: any;
  created_at: Date;
};

function bigIntFromString(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.floor(value));
  if (typeof value === 'string') return value.startsWith('0x') ? BigInt(value) : BigInt(value);
  throw new Error('invalid bigint input');
}

function resolvePolicy(config: AppConfig, market: Market | undefined, debtSymbol: string) {
  const policy = config.assets[debtSymbol];
  if (!policy) return null;
  const closeFactor = (market?.closeFactorBps ?? DEFAULT_CLOSE_FACTOR_BPS) / 10_000;
  const bonusBps = market?.bonusBps ?? DEFAULT_BONUS_BPS;
  return { policy, closeFactor, bonusBps };
}

async function fetchAttemptRows(limit: number, seconds?: number): Promise<AttemptRow[]> {
  if (!hasDb) {
    throw new Error('DATABASE_URL not configured; cannot run backtest');
  }
  const params: Array<string | number> = [limit];
  let where = '';
  if (seconds && seconds > 0) {
    params.push(seconds);
    where = `WHERE created_at >= NOW() - ($2 || ' seconds')::interval`;
  }
  const sql = `
    SELECT chain_id, borrower, status, details, created_at
    FROM liquidation_attempts
    ${where}
    ORDER BY created_at DESC
    LIMIT $1
  `;
  const res = await db.query(sql, params);
  return res.rows as AttemptRow[];
}

function getSampleDetails(row: AttemptRow) {
  const details = row.details ?? {};
  const candidate = details.candidate;
  if (!candidate) return null;
  return { candidate, baselinePlan: details.plan, status: row.status };
}

function parseNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function summarizePlan(plan: SimPlan) {
  return {
    repayAmount: plan.repayAmount.toString(),
    estNetBps: plan.estNetBps,
  };
}

export async function runBacktest(options: BacktestOptions = {}): Promise<BacktestResult> {
  const config = options.config ?? loadConfig(options.configPath);
  const limit = options.limit ?? 200;
  const seconds = options.seconds;
  const rows = await fetchAttemptRows(limit, seconds);

  const clientCache = new Map<number, ReturnType<typeof createPublicClient>>();
  const getClient = (rpc: string, chainId: number) => {
    if (!clientCache.has(chainId)) {
      clientCache.set(chainId, createPublicClient({ transport: http(rpc) }));
    }
    return clientCache.get(chainId)!;
  };

  let samples = 0;
  let skipped = 0;
  let newPlans = 0;
  let newNetTotal = 0;
  let baselinePlans = 0;
  let baselineNetTotal = 0;
  let errors = 0;
  const failures: Array<{ borrower: string; chainId: number; reason: string }> = [];

  for (const row of rows) {
    const snapshot = getSampleDetails(row);
    if (!snapshot) {
      skipped += 1;
      continue;
    }
    const { candidate, baselinePlan, status } = snapshot;
    const chain = chainById(config, candidate.chainId);
    if (!chain) {
      skipped += 1;
      failures.push({ borrower: candidate.borrower, chainId: candidate.chainId, reason: 'unknown-chain' });
      continue;
    }
    const debtToken = chain.tokens[candidate.debt.symbol];
    const collateralToken = chain.tokens[candidate.collateral.symbol];
    if (!debtToken || !collateralToken) {
      skipped += 1;
      failures.push({ borrower: candidate.borrower, chainId: candidate.chainId, reason: 'missing-token' });
      continue;
    }
    const market = config.markets.find(
      (m) =>
        m.chainId === candidate.chainId &&
        m.debtAsset === candidate.debt.symbol &&
        m.collateralAsset === candidate.collateral.symbol
    );
    if (!market || !market.enabled) {
      skipped += 1;
      failures.push({ borrower: candidate.borrower, chainId: candidate.chainId, reason: 'market-disabled' });
      continue;
    }
    const policyInfo = resolvePolicy(config, market, candidate.debt.symbol);
    if (!policyInfo) {
      skipped += 1;
      failures.push({ borrower: candidate.borrower, chainId: candidate.chainId, reason: 'missing-policy' });
      continue;
    }

    const client = getClient(chain.rpc, chain.id);
    const debtPrice =
      candidate.debtPriceUsd ?? (await oraclePriceUsd(client, debtToken)) ?? 1;
    const collPrice =
      candidate.collateralPriceUsd ?? (await oraclePriceUsd(client, collateralToken)) ?? debtPrice;

    const routes = buildRouteOptions(config, chain, candidate.debt.symbol, candidate.collateral.symbol).options;
    const plan = await simulate({
      client,
      chain,
      debt: {
        ...debtToken,
        symbol: candidate.debt.symbol,
        amount: bigIntFromString(candidate.debt.amount),
      },
      collateral: {
        ...collateralToken,
        symbol: candidate.collateral.symbol,
        amount: bigIntFromString(candidate.collateral.amount),
      },
      closeFactor: policyInfo.closeFactor,
      bonusBps: policyInfo.bonusBps,
      routes,
      pricesUsd: { debt: debtPrice, coll: collPrice },
      policy: policyInfo.policy,
      gasCapUsd: config.risk.gasCapUsd,
    });

    samples += 1;

    if (baselinePlan && typeof baselinePlan.estNetBps === 'number') {
      baselinePlans += 1;
      baselineNetTotal += baselinePlan.estNetBps;
    }
    if (status === 'error') {
      errors += 1;
    }

    if (plan) {
      newPlans += 1;
      newNetTotal += plan.estNetBps;
    } else {
      failures.push({ borrower: candidate.borrower, chainId: candidate.chainId, reason: 'plan-null-new-config' });
    }
  }

  const newAvgNetBps = newPlans ? newNetTotal / newPlans : 0;
  const baselineAvgNetBps = baselinePlans ? baselineNetTotal / baselinePlans : 0;
  const baselineErrorRate = samples ? errors / samples : 0;

  const summary: BacktestResult = {
    samples,
    newPlans,
    newAvgNetBps,
    baselinePlans,
    baselineAvgNetBps,
    baselineErrorRate,
    skipped,
    failures: failures.slice(0, 25),
  };

  return summary;
}

export async function runBacktestCLI() {
  try {
    const limitArg = process.argv.indexOf('--limit');
    const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : undefined;
    const secondsArg = process.argv.indexOf('--seconds');
    const seconds = secondsArg !== -1 ? Number(process.argv[secondsArg + 1]) : undefined;
    const staged = process.argv.indexOf('--staged') !== -1;

    const config = staged ? loadConfig(process.env.AGENT_STAGE_FILE ?? 'config.staged.yaml') : loadConfig();
    const result = await runBacktest({ config, limit, seconds });
    log.info({ result }, 'backtest-complete');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Backtest failed:', (err as Error).message);
    process.exit(1);
  }
}

if (require.main === module) {
  runBacktestCLI();
}
