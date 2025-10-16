#!/usr/bin/env ts-node
import '../infra/env';
import { loadConfig, chainById } from '../infra/config';
import { db, waitForDb } from '../infra/db';
import { lookupToken, symbolsEqual } from '../util/symbols';

function parseArgs() {
  const args = process.argv.slice(2);
  let hours: number | null = 24;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (key === 'hours' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        hours = parsed;
        i += 1;
      }
    }
    if (key === 'hours' && !next) {
      hours = null;
    }
  }
  return { hours };
}

function bigIntToNumber(amount: bigint, decimals: number): number {
  const negative = amount < 0n;
  let value = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const integer = value / base;
  const fraction = value % base;
  let fractionStr = fraction.toString().padStart(decimals, '0');
  fractionStr = fractionStr.replace(/0+$/, '');
  const str = `${integer.toString()}${fractionStr ? `.${fractionStr}` : ''}`;
  const num = Number(str);
  return negative ? -num : num;
}

const BONUS_DIVISOR = 10_000;

type MissedRow = {
  id: number;
  chainId: number;
  createdAt: Date;
  borrower: string;
  debtSymbol: string;
  collateralSymbol: string;
  healthFactor: number;
  repayUsd: number;
  seizeUsd: number;
  profitUsd: number;
};

async function fetchMissed(hours: number | null): Promise<MissedRow[]> {
  await waitForDb();
  const params: Array<string | number> = [];
  const where: string[] = ["reason LIKE 'plan-null %'"];
  if (hours !== null) {
    where.push('created_at >= NOW() - $1::interval');
    params.push(`${hours} hours`);
  }
  const sql = `SELECT id, chain_id, borrower, reason, details, created_at
               FROM liquidation_attempts
               WHERE ${where.join(' AND ')}
               ORDER BY created_at DESC`;
  const res = await db.query(sql, params);
  const cfg = loadConfig();
  const rows: MissedRow[] = [];

  for (const row of res.rows) {
    const details = (row.details ?? {}) as Record<string, any>;
    const candidate = details.candidate;
    if (!candidate) continue;

    const hf = Number(candidate.healthFactor ?? candidate.healthFactorApprox ?? NaN);
    if (!Number.isFinite(hf) || hf >= 1) continue;

    const chain = chainById(cfg, Number(row.chain_id));
    if (!chain) continue;

    const debt = candidate.debt ?? {};
    const collateral = candidate.collateral ?? {};
    const debtSymbol = String(debt.symbol ?? '');
    const collSymbol = String(collateral.symbol ?? '');
    if (!debtSymbol || !collSymbol) continue;

    const debtToken = lookupToken(chain.tokens, debtSymbol, debt.address);
    const collToken = lookupToken(chain.tokens, collSymbol, collateral.address);
    if (!debtToken || !collToken) continue;

    const market = cfg.markets.find(
      (m) =>
        m.enabled &&
        m.chainId === chain.id &&
        symbolsEqual(m.debtAsset, debtSymbol) &&
        symbolsEqual(m.collateralAsset, collSymbol)
    );
    if (!market) continue;

    const closeFactorBps = market.closeFactorBps ?? 5000;
    const bonusBps = market.bonusBps ?? 0;

    const debtAmountRaw = BigInt(debt.amount ?? '0');
    const collAmountRaw = BigInt(collateral.amount ?? '0');

    if (debtAmountRaw === 0n || collAmountRaw === 0n) continue;

    const debtTokens = bigIntToNumber(debtAmountRaw, debtToken.value.decimals);
    const collTokens = bigIntToNumber(collAmountRaw, collToken.value.decimals);

    const debtPriceUsd = Number(candidate.debtPriceUsd ?? candidate.debt.priceUsd ?? NaN);
    const collPriceUsd = Number(candidate.collateralPriceUsd ?? candidate.collateral.priceUsd ?? NaN);

    if (!Number.isFinite(debtPriceUsd) || !Number.isFinite(collPriceUsd) || debtPriceUsd <= 0 || collPriceUsd <= 0) {
      continue;
    }

    const repayTokens = debtTokens * (closeFactorBps / BONUS_DIVISOR);
    if (!Number.isFinite(repayTokens) || repayTokens <= 0) continue;

    const repayUsd = repayTokens * debtPriceUsd;
    if (!Number.isFinite(repayUsd) || repayUsd <= 0) continue;

    const collateralUsdAvailable = collTokens * collPriceUsd;
    if (!Number.isFinite(collateralUsdAvailable) || collateralUsdAvailable <= 0) continue;

    const maxSeizeUsd = repayUsd * (1 + bonusBps / BONUS_DIVISOR);
    const seizeUsd = Math.min(collateralUsdAvailable, maxSeizeUsd);
    const profitUsd = Math.max(0, seizeUsd - repayUsd);

    rows.push({
      id: Number(row.id),
      chainId: chain.id,
      createdAt: new Date(row.created_at),
      borrower: String(row.borrower),
      debtSymbol,
      collateralSymbol: collSymbol,
      healthFactor: hf,
      repayUsd,
      seizeUsd,
      profitUsd,
    });
  }

  return rows;
}

function summarize(rows: MissedRow[]) {
  const totalProfit = rows.reduce((sum, r) => sum + r.profitUsd, 0);
  const totalRepay = rows.reduce((sum, r) => sum + r.repayUsd, 0);
  const byDay = new Map<string, { profit: number; count: number }>();
  const byChain = new Map<number, { profit: number; count: number }>();

  for (const row of rows) {
    const dayKey = row.createdAt.toISOString().slice(0, 10);
    const dayEntry = byDay.get(dayKey) ?? { profit: 0, count: 0 };
    dayEntry.profit += row.profitUsd;
    dayEntry.count += 1;
    byDay.set(dayKey, dayEntry);

    const chainEntry = byChain.get(row.chainId) ?? { profit: 0, count: 0 };
    chainEntry.profit += row.profitUsd;
    chainEntry.count += 1;
    byChain.set(row.chainId, chainEntry);
  }

  console.log(`\nEstimated missed profit: $${totalProfit.toFixed(2)} (across ${rows.length} plan-null liquidatable attempts)`);
  console.log(`Estimated repay notional: $${totalRepay.toFixed(2)}`);

  if (byDay.size > 0) {
    console.log('\nBreakdown by day (UTC):');
    console.table(
      Array.from(byDay.entries()).map(([day, data]) => ({
        day,
        count: data.count,
        profitUsd: Number(data.profit.toFixed(2)),
      }))
    );
  }

  if (byChain.size > 0) {
    console.log('\nBreakdown by chain:');
    console.table(
      Array.from(byChain.entries()).map(([chainId, data]) => ({
        chainId,
        count: data.count,
        profitUsd: Number(data.profit.toFixed(2)),
      }))
    );
  }

  const top = rows
    .sort((a, b) => b.profitUsd - a.profitUsd)
    .slice(0, 10)
    .map((row) => ({
      id: row.id,
      when: row.createdAt.toISOString(),
      chainId: row.chainId,
      pair: `${row.debtSymbol}->${row.collateralSymbol}`,
      hf: Number(row.healthFactor.toFixed(4)),
      profitUsd: Number(row.profitUsd.toFixed(2)),
    }));
  if (top.length > 0) {
    console.log('\nTop missed opportunities:');
    console.table(top);
  }
}

async function main() {
  const { hours } = parseArgs();
  const rows = await fetchMissed(hours);
  summarize(rows);
}

main()
  .catch((err) => {
    console.error('missed-profit failed:', err);
    process.exit(1);
  })
  .finally(() => {
    void db.end();
  });
