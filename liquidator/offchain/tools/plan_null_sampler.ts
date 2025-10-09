#!/usr/bin/env ts-node
import '../infra/env';
import { db, waitForDb } from '../infra/db';

interface Args {
  limit: number;
  minutes: number | null;
}

function parseArgs(argv: string[]): Args {
  let limit = 10_000;
  let minutes: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (key === 'limit' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.floor(parsed);
        i += 1;
        continue;
      }
    }
    if (key === 'minutes' && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        minutes = parsed;
        i += 1;
        continue;
      }
    }
  }
  return { limit, minutes };
}

function toInterval(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return `${minutes} minutes`;
}

function safeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return null;
}

async function main() {
  const { limit, minutes } = parseArgs(process.argv.slice(2));
  const interval = toInterval(minutes);

  await waitForDb();

  const params: Array<string | number> = [limit];
  const where: string[] = ["reason LIKE 'plan-null%'"];
  if (interval) {
    where.push('created_at >= NOW() - $2::interval');
    params.push(interval);
  }

  const rows = await db.query(
    `SELECT id, chain_id, reason, created_at, details
     FROM liquidation_attempts
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $1`,
    params,
  );

  if (rows.rowCount === 0) {
    console.log('No plan-null attempts found in the selected window.');
    const fallback = await db.query(
      `SELECT reason, COUNT(*)::int AS count
         FROM liquidation_attempts
         WHERE reason LIKE 'policy_skip%'
           ${interval ? 'AND created_at >= NOW() - $1::interval' : ''}
         GROUP BY reason
         ORDER BY count DESC
         LIMIT 10`,
      interval ? [interval] : undefined,
    );
    if (fallback.rowCount > 0) {
      console.log('\nTop policy_skip reasons instead:');
      console.table(fallback.rows);
    }
    return;
  }

  type ChainStats = {
    chainId: number;
    count: number;
    avgHf: number;
    minHf: number;
    maxHf: number;
    adaptiveCount: number;
    avgAdaptiveMax: number | null;
  };

  const stats = new Map<number, ChainStats>();
  const histogram: number[] = [];
  const adaptive: number[] = [];

  for (const row of rows.rows) {
    const chainId: number = Number(row.chain_id);
    const details: any = row.details ?? {};
    const candidate = details.candidate ?? {};
    const hf = safeNumber(candidate.healthFactor) ?? safeNumber(candidate.healthFactorApprox);
    const adaptiveMax = safeNumber(candidate.adaptiveHealthFactorMax ?? candidate.baseHealthFactorMax);
    const stat = stats.get(chainId) ?? {
      chainId,
      count: 0,
      avgHf: 0,
      minHf: Number.POSITIVE_INFINITY,
      maxHf: Number.NEGATIVE_INFINITY,
      adaptiveCount: 0,
      avgAdaptiveMax: null,
    };
    stat.count += 1;
    if (hf !== null) {
      stat.avgHf = stat.avgHf + (hf - stat.avgHf) / stat.count;
      stat.minHf = Math.min(stat.minHf, hf);
      stat.maxHf = Math.max(stat.maxHf, hf);
      histogram.push(hf);
    }
    if (adaptiveMax !== null) {
      adaptive.push(adaptiveMax);
      stat.adaptiveCount += 1;
      const current = stat.avgAdaptiveMax ?? adaptiveMax;
      stat.avgAdaptiveMax = current + (adaptiveMax - current) / stat.adaptiveCount;
    }
    stats.set(chainId, stat);
  }

  const table = Array.from(stats.values()).map((stat) => ({
    chainId: stat.chainId,
    count: stat.count,
    avgHf: Number(stat.avgHf.toFixed(5)),
    minHf: stat.minHf === Number.POSITIVE_INFINITY ? null : Number(stat.minHf.toFixed(5)),
    maxHf: stat.maxHf === Number.NEGATIVE_INFINITY ? null : Number(stat.maxHf.toFixed(5)),
    avgAdaptiveMax: stat.avgAdaptiveMax === null ? null : Number(stat.avgAdaptiveMax.toFixed(5)),
  }));

  console.log(`Sampled ${rows.rowCount} plan-null attempts${interval ? ` from the last ${interval}` : ''}.`);
  console.table(table);

  if (histogram.length > 0) {
    histogram.sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (histogram.length === 0) return NaN;
      const idx = Math.min(histogram.length - 1, Math.floor((p / 100) * (histogram.length - 1)));
      return histogram[idx];
    };
    console.log('\nHealth factor distribution (plan-null sample):');
    console.table([
      {
        p5: Number(percentile(5).toFixed(5)),
        p25: Number(percentile(25).toFixed(5)),
        median: Number(percentile(50).toFixed(5)),
        p75: Number(percentile(75).toFixed(5)),
        p95: Number(percentile(95).toFixed(5)),
      },
    ]);
  }

  if (adaptive.length > 0) {
    adaptive.sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (adaptive.length === 0) return NaN;
      const idx = Math.min(adaptive.length - 1, Math.floor((p / 100) * (adaptive.length - 1)));
      return adaptive[idx];
    };
    console.log('\nAdaptive max distribution (plan-null sample):');
    console.table([
      {
        p5: Number(percentile(5).toFixed(5)),
        p25: Number(percentile(25).toFixed(5)),
        median: Number(percentile(50).toFixed(5)),
        p75: Number(percentile(75).toFixed(5)),
        p95: Number(percentile(95).toFixed(5)),
      },
    ]);
  }
}

main()
  .catch((err) => {
    console.error('plan-null sampler failed:', err);
    process.exit(1);
  })
  .finally(() => {
    void db.end();
  });
