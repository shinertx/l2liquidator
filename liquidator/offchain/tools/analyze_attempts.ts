#!/usr/bin/env ts-node
import '../infra/env';
import { waitForDb, db } from '../infra/db';

type ArgMap = Record<string, string | boolean>;

function parseArgs(argv: string[]): ArgMap {
  const out: ArgMap = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true;
        i -= 1; // compensate for for-loop increment
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

function toInterval(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return '60 minutes';
  }
  return `${minutes} minutes`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const minutes = Number(args.minutes ?? 60);
  const rowsLimit = Number(args.limit ?? 50);
  const interval = toInterval(minutes);

  await waitForDb();

  const summarySql = `
    SELECT status, reason, COUNT(*)::int AS count,
           MAX(id) AS latest_id
    FROM liquidation_attempts
    WHERE created_at >= NOW() - $1::interval
    GROUP BY status, reason
    ORDER BY count DESC
    LIMIT $2
  `;
  const statusSql = `
    SELECT status, COUNT(*)::int AS count
    FROM liquidation_attempts
    WHERE created_at >= NOW() - $1::interval
    GROUP BY status
    ORDER BY count DESC
  `;
  const planNullSql = `
    SELECT
      COUNT(*)::int AS count,
      AVG( (details->'candidate'->>'healthFactor')::numeric ) AS avg_hf,
      MIN( (details->'candidate'->>'healthFactor')::numeric ) AS min_hf,
      MAX( (details->'candidate'->>'healthFactor')::numeric ) AS max_hf
    FROM liquidation_attempts
    WHERE created_at >= NOW() - $1::interval
      AND reason LIKE 'plan-null%'
  `;

  const [summaryRes, statusRes, planNullRes] = await Promise.all([
    db.query(summarySql, [interval, rowsLimit]),
    db.query(statusSql, [interval]),
    db.query(planNullSql, [interval]),
  ]);

  console.log(`\nLiquidation attempt summary (last ${interval})\n`);

  if (statusRes.rows.length) {
    console.log('By status:');
    console.table(statusRes.rows);
  } else {
    console.log('No attempts recorded in this window.');
  }

  if (summaryRes.rows.length) {
    console.log('\nTop reasons:');
    console.table(summaryRes.rows);
  }

  const planNullRow = planNullRes.rows[0];
  if (planNullRow && planNullRow.count > 0) {
    console.log('\nPlan-null diagnostics:');
    console.table([planNullRow]);
  }

  console.log('\nUsage: npm run analyze:attempts -- --minutes 15 --limit 20');
}

main()
  .catch((err) => {
    console.error('analyze-attempts failed:', err);
    process.exit(1);
  })
  .finally(() => {
    void db.end();
  });
