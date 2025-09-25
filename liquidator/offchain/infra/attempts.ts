import { db } from './db';
import { log } from './logger';

const hasDb = Boolean(process.env.DATABASE_URL);
let warnedNoDb = false;

function ensureDb(action: string): boolean {
  if (hasDb) return true;
  if (!warnedNoDb) {
    log.warn({ action }, 'attempt-store-disabled');
    warnedNoDb = true;
  }
  return false;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS liquidation_attempts (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  borrower TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const CREATE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_liquidation_attempts_chain_borrower_created
  ON liquidation_attempts(chain_id, borrower, created_at DESC)`;

export type AttemptStatus =
  | 'throttled'
  | 'gap_skip'
  | 'policy_skip'
  | 'dry_run'
  | 'sent'
  | 'success'
  | 'error';

export async function ensureAttemptTable(): Promise<void> {
  if (!ensureDb('init')) return;
  try {
    await db.query(CREATE_TABLE);
    await db.query(CREATE_INDEX);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'attempt-table-init-failed');
  }
}

export async function recordAttemptRow(params: {
  chainId: number;
  borrower: `0x${string}`;
  status: AttemptStatus;
  reason?: string;
  txHash?: `0x${string}`;
}): Promise<void> {
  const { chainId, borrower, status, reason, txHash } = params;
  if (!ensureDb('record')) return;
  try {
    await db.query(
      'INSERT INTO liquidation_attempts (chain_id, borrower, status, reason, tx_hash) VALUES ($1, $2, $3, $4, $5)',
      [chainId, borrower.toLowerCase(), status, reason ?? null, txHash ?? null]
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'attempt-row-insert-failed');
  }
}

export async function recentFailureCount(params: {
  chainId: number;
  borrower: `0x${string}`;
  withinMinutes: number;
}): Promise<number> {
  if (!ensureDb('recent')) return 0;
  try {
    const res = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM liquidation_attempts
       WHERE chain_id = $1 AND borrower = $2 AND status = 'error' AND created_at >= NOW() - INTERVAL '$3 minutes'`,
      [params.chainId, params.borrower.toLowerCase(), params.withinMinutes]
    );
    return res.rows[0]?.count ?? 0;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'attempt-recent-failure-query-failed');
    return 0;
  }
}
