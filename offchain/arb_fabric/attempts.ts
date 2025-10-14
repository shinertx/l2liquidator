import { db, waitForDb, classifyDbError, type DbErrorInfo } from '../infra/db';
import { log } from '../infra/logger';

const hasDb = Boolean(process.env.DATABASE_URL);

function ensureDb(action: string): boolean {
  if (hasDb) return true;
  log.debug({ action }, 'laf-attempt-store-disabled');
  return false;
}

function logDbFailure(action: string, err: unknown, level: 'warn' | 'error' = 'error'): void {
  const info: DbErrorInfo = classifyDbError(err);
  log[level]({ action, code: info.code, category: info.category, message: info.message }, 'laf-attempt-db-error');
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS laf_attempts (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  pair_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  net_usd DOUBLE PRECISION,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const CREATE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_laf_attempts_chain_pair_created
  ON laf_attempts(chain_id, pair_id, created_at DESC)`;

export type LafAttemptStatus = 'throttled' | 'skip' | 'queued' | 'sent' | 'success' | 'error';

export async function ensureLafAttemptTable(): Promise<void> {
  if (!ensureDb('init')) return;
  try {
    await waitForDb();
    await db.query(CREATE_TABLE);
    await db.query(CREATE_INDEX);
  } catch (err) {
    logDbFailure('init', err, 'error');
    throw err;
  }
}

export async function recordLafAttempt(params: {
  chainId: number;
  pairId: string;
  source: string;
  status: LafAttemptStatus;
  txHash?: `0x${string}` | null;
  netUsd?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!ensureDb('record')) return;
  try {
    await db.query(
      'INSERT INTO laf_attempts (chain_id, pair_id, source, status, tx_hash, net_usd, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        params.chainId,
        params.pairId,
        params.source,
        params.status,
        params.txHash ?? null,
        params.netUsd ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ],
    );
  } catch (err) {
    logDbFailure('record', err, 'warn');
  }
}
