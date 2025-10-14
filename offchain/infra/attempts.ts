import { db, waitForDb, classifyDbError, type DbErrorInfo } from './db';
import { log } from './logger';

const hasDb = Boolean(process.env.DATABASE_URL);
let warnedNoDb = false;
let lastDbErrorLoggedAt = 0;
let lastDbErrorKey: string | null = null;
const DB_ERROR_LOG_WINDOW_MS = 60_000;

function ensureDb(action: string): boolean {
  if (hasDb) return true;
  if (!warnedNoDb) {
    log.warn({ action }, 'attempt-store-disabled');
    warnedNoDb = true;
  }
  return false;
}

function logDbFailure(action: string, err: unknown, level: 'warn' | 'error' = 'error'): void {
  const info: DbErrorInfo = classifyDbError(err);
  const key = info.code ?? info.message;
  const now = Date.now();
  const withinWindow = now - lastDbErrorLoggedAt < DB_ERROR_LOG_WINDOW_MS && key === lastDbErrorKey;
  const logLevel: 'debug' | 'warn' | 'error' = withinWindow ? 'debug' : level;
  const payload: Record<string, unknown> = {
    action,
    code: info.code,
    category: info.category,
    message: info.message,
    target: db.target,
  };
  if (info.hint) payload.hint = info.hint;

  log[logLevel](payload, 'attempt-db-error');
  if (!withinWindow) {
    lastDbErrorLoggedAt = now;
    lastDbErrorKey = key;
  }
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS liquidation_attempts (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  borrower TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  tx_hash TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const CREATE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_liquidation_attempts_chain_borrower_created
  ON liquidation_attempts(chain_id, borrower, created_at DESC)`;

const ADD_DETAILS_COLUMN = `
ALTER TABLE liquidation_attempts
  ADD COLUMN IF NOT EXISTS details JSONB`;

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
    await waitForDb();
    await db.query(CREATE_TABLE);
    await db.query(CREATE_INDEX);
    await db.query(ADD_DETAILS_COLUMN);
  } catch (err) {
    logDbFailure('init', err, 'error');
    throw err;
  }
}

export async function recordAttemptRow(params: {
  chainId: number;
  borrower: `0x${string}`;
  status: AttemptStatus;
  reason?: string;
  txHash?: `0x${string}`;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  const { chainId, borrower, status, reason, txHash, details } = params;
  if (!ensureDb('record')) return;
  try {
    await db.query(
      'INSERT INTO liquidation_attempts (chain_id, borrower, status, reason, tx_hash, details) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        chainId,
        borrower.toLowerCase(),
        status,
        reason ?? null,
        txHash ?? null,
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (err) {
    logDbFailure('record', err, 'warn');
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
    logDbFailure('recent', err, 'warn');
    return 0;
  }
}
