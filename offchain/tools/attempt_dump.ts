#!/usr/bin/env ts-node
import '../infra/env';
import { db, waitForDb } from '../infra/db';

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 20;
  let status: string | null = null;
  let minutes = 30;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    switch (key) {
      case 'limit': {
        const parsed = next ? Number(next) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.min(parsed, 200);
          i += 1;
        }
        break;
      }
      case 'status': {
        if (next) {
          status = next;
          i += 1;
        }
        break;
      }
      case 'minutes': {
        const parsed = next ? Number(next) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) {
          minutes = parsed;
          i += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  return { limit, status, minutes };
}

async function fetchAttempts(limit: number, status: string | null, minutes: number) {
  await waitForDb();
  const where: string[] = [];
  const params: Array<number | string> = [];
  let paramIdx = 1;

  if (minutes > 0) {
    where.push(`created_at >= NOW() - $${paramIdx}::interval`);
    params.push(`${minutes} minutes`);
    paramIdx += 1;
  }
  if (status) {
    where.push(`status = $${paramIdx}`);
    params.push(status);
    paramIdx += 1;
  }

  const sql = `SELECT id, chain_id, status, reason, created_at, details
               FROM liquidation_attempts
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY created_at DESC
               LIMIT $${paramIdx}`;
  params.push(limit);

  const res = await db.query<any>(sql, params);
  return res.rows;
}

function prettyPrint(rows: Array<Record<string, any>>) {
  if (rows.length === 0) {
    console.log('No attempts found for the given filters.');
    return;
  }

  const table = rows.map((row) => {
    const details = (row.details ?? {}) as Record<string, any>;
    const candidate = details.candidate ?? {};
    const gapBps = Number(candidate.gapBps ?? candidate.gap_bps ?? NaN);
    const capBps = Number(candidate.adaptiveGapCapBps ?? candidate.capBps ?? NaN);
    const hf = Number(candidate.healthFactor ?? candidate.health_factor ?? NaN);

    const debt = candidate.debt
      ? `${candidate.debt.symbol ?? '?'} ${candidate.debt.amount ?? ''}`
      : undefined;
    const collateral = candidate.collateral
      ? `${candidate.collateral.symbol ?? '?'} ${candidate.collateral.amount ?? ''}`
      : undefined;

    return {
      id: row.id,
      chain: row.chain_id,
      status: row.status,
      reason: row.reason,
      gapBps: Number.isFinite(gapBps) ? gapBps : null,
      capBps: Number.isFinite(capBps) ? capBps : null,
      hf: Number.isFinite(hf) ? hf : null,
      debt,
      collateral,
      createdAt: row.created_at,
    };
  });

  console.table(table);
}

async function main() {
  const { limit, status, minutes } = parseArgs();
  const rows = await fetchAttempts(limit, status, minutes);
  prettyPrint(rows);
}

main()
  .catch((err) => {
    console.error('attempt-dump failed:', err);
    process.exit(1);
  })
  .finally(() => {
    void db.end();
  });
