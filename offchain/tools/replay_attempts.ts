#!/usr/bin/env ts-node
import '../infra/env';
import fs from 'fs';
import path from 'path';
import { loadConfig, chainById } from '../infra/config';
import { waitForDb, db } from '../infra/db';
import { Scorer } from '../pipeline/scorer';
import type { QueuedCandidate, ScoredPlan, ScoreRejection } from '../pipeline/types';
import { log } from '../infra/logger';

interface Args {
  minutes: number;
  limit: number;
  status?: string;
  file?: string;
}

function parseArgs(argv: string[]): Args {
  let minutes = Number(process.env.REPLAY_MINUTES ?? 180);
  let limit = Number(process.env.REPLAY_LIMIT ?? 200);
  let status: string | undefined;
  let file: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];

    switch (key) {
      case 'minutes': {
        if (next && !next.startsWith('--')) {
          const parsed = Number(next);
          if (Number.isFinite(parsed) && parsed > 0) {
            minutes = parsed;
            i += 1;
          }
        }
        break;
      }
      case 'limit': {
        if (next && !next.startsWith('--')) {
          const parsed = Number(next);
          if (Number.isFinite(parsed) && parsed > 0) {
            limit = Math.floor(parsed);
            i += 1;
          }
        }
        break;
      }
      case 'status': {
        if (next && !next.startsWith('--')) {
          status = next;
          i += 1;
        }
        break;
      }
      case 'file': {
        if (next && !next.startsWith('--')) {
          file = next;
          i += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  return { minutes, limit, status, file };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const scorer = new Scorer(cfg);

  type ScoreOutcome = ScoredPlan | ScoreRejection;

  let rows: Array<{
    id: number | string;
    chain_id: number;
    status?: string;
    reason?: string | null;
    details?: any;
    created_at?: unknown;
  }> = [];

  if (args.file) {
    rows = loadFromFile(args.file).map((entry, idx) => ({
      id: entry.id ?? `file-${idx}`,
      chain_id: entry.chainId,
      status: entry.status,
      reason: entry.reason,
      details: entry.details ?? { candidate: entry.candidate },
    }));
  } else {
    await waitForDb();

    const where: string[] = ['created_at >= NOW() - $1::interval'];
    const params: Array<string | number> = [`${args.minutes} minutes`, args.limit];
    if (args.status) {
      where.push('status = $3');
      params.push(args.status);
    }

    const dbRows = await db.query(
      `SELECT id, chain_id, status, reason, details, created_at
       FROM liquidation_attempts
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $2`,
      params,
    );
    rows = dbRows.rows;
  }

  const rowsToProcess = args.limit ? rows.slice(0, args.limit) : rows;

  const summary = {
    total: 0,
    missingSnapshot: 0,
    missingChain: 0,
    replayed: 0,
    planMatches: 0,
    planRegressions: 0,
    rejections: 0,
    errors: 0,
  };

  for (const row of rowsToProcess) {
    summary.total += 1;
    const details = row.details ?? {};
    const candidate = details.candidate;
    if (!candidate) {
      summary.missingSnapshot += 1;
      continue;
    }

    const chain = chainById(cfg, row.chain_id);
    if (!chain) {
      summary.missingChain += 1;
      continue;
    }

    const item: QueuedCandidate = {
      candidate,
      chain,
      source: 'retry',
    };

    let outcome: ScoreOutcome;
    try {
      outcome = await scorer.score(item);
    } catch (err) {
      summary.errors += 1;
      log.warn({ id: row.id, err: (err as Error).message }, 'replay-score-failed');
      continue;
    }

    summary.replayed += 1;

    if ('plan' in outcome) {
      const scored = outcome as ScoredPlan;
      if (row.status === 'sent' || row.status === 'dry_run') {
        summary.planMatches += 1;
      } else {
        summary.planRegressions += 1;
        log.info({
          id: row.id,
          status: row.status,
          borrower: scored.candidate.borrower,
          chain: chain.name,
          netUsd: scored.plan.netUsd,
          estNetBps: scored.plan.estNetBps,
        }, 'replay-plan-regression');
      }
      continue;
    }

    summary.rejections += 1;
    const reject = outcome as ScoreRejection;
    if (row.status === 'sent') {
      summary.planRegressions += 1;
      log.info({
        id: row.id,
        status: row.status,
        borrower: reject.candidate.borrower,
        chain: chain.name,
        reason: reject.reason,
        detail: reject.detail,
      }, 'replay-rejected-previously-sent');
    }
  }

  console.log('\nReplay summary');
  console.table([
    {
      total: summary.total,
      replayed: summary.replayed,
      missingSnapshot: summary.missingSnapshot,
      missingChain: summary.missingChain,
      planMatches: summary.planMatches,
      planRegressions: summary.planRegressions,
      rejections: summary.rejections,
      errors: summary.errors,
    },
  ]);

  console.log('\nUsage: npm run replay:attempts -- --minutes 60 --limit 100 --status sent');
  console.log('      npm run replay:attempts -- --file fixtures/candidates.jsonl');

  if (!args.file) {
    await db.end();
  }
}

main()
  .catch((err) => {
    console.error('replay-attempts failed:', err);
    process.exit(1);
  });

function loadFromFile(filePath: string): Array<{
  id?: number | string;
  chainId: number;
  status?: string;
  reason?: string;
  candidate: unknown;
  details?: any;
}> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`replay file not found: ${resolved}`);
  }

  const rows: Array<{
    id?: number | string;
    chainId: number;
    status?: string;
    reason?: string;
    candidate: unknown;
    details?: any;
  }> = [];

  if (resolved.endsWith('.jsonl')) {
    const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as any;
        rows.push(normalizeFileEntry(parsed));
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'replay-file-parse-failed');
      }
    }
  } else {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as any;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        rows.push(normalizeFileEntry(entry));
      }
    } else {
      rows.push(normalizeFileEntry(parsed));
    }
  }

  return rows;
}

function normalizeFileEntry(entry: any): {
  id?: number | string;
  chainId: number;
  status?: string;
  reason?: string;
  candidate: any;
  details?: any;
} {
  if (!entry || typeof entry !== 'object') {
    throw new Error('invalid replay entry');
  }
  const chainId = Number(entry.chainId ?? entry.chain_id ?? entry.details?.chainId ?? entry.details?.chain_id);
  if (!Number.isFinite(chainId)) {
    throw new Error('replay entry missing chainId');
  }
  const candidate = entry.candidate ?? entry.details?.candidate;
  if (!candidate) {
    throw new Error('replay entry missing candidate snapshot');
  }
  return {
    id: entry.id,
    chainId,
    status: entry.status,
    reason: entry.reason,
    candidate,
    details: entry.details ?? { candidate },
  };
}
