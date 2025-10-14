import { Pool } from 'pg';
import { instrument } from './instrument';
import { log } from './logger';

type QueryInput = string | { text: string; name?: string; values?: readonly unknown[] };

type DbErrorCategory = 'connection' | 'timeout' | 'auth' | 'serialization' | 'other';

type DbErrorInfo = {
  code?: string;
  message: string;
  category: DbErrorCategory;
  retryable: boolean;
  hint?: string;
};

function parseNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const lowered = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(lowered)) return false;
  return fallback;
}

function connectionTarget(url?: string): { label: string; host?: string; port?: string; database?: string } {
  if (!url) return { label: 'unconfigured' };
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port || undefined;
    const database = parsed.pathname?.replace(/^\//, '') || undefined;
    const label = port ? `${host}:${port}` : host;
    return { label, host, port, database };
  } catch {
    return { label: 'primary' };
  }
}

const connectionString = process.env.DATABASE_URL;
const target = connectionTarget(connectionString);

function buildPoolConfig(): Record<string, unknown> | null {
  if (!connectionString) {
    log.warn({ env: 'DATABASE_URL' }, 'db-missing-connection-string');
    return null;
  }

  const config: Record<string, unknown> = {
    connectionString,
    max: parseNumberEnv('DATABASE_POOL_MAX', 10),
    min: parseNumberEnv('DATABASE_POOL_MIN', 0),
    idleTimeoutMillis: parseNumberEnv('DATABASE_IDLE_MS', 30_000),
    connectionTimeoutMillis: parseNumberEnv('DATABASE_CONN_TIMEOUT_MS', 5_000),
    keepAlive: true,
    allowExitOnIdle: false,
  };

  const keepAliveDelay = parseNumberEnv('DATABASE_KEEPALIVE_INITIAL_DELAY_MS', -1);
  if (keepAliveDelay >= 0) {
    (config as any).keepAliveInitialDelayMillis = keepAliveDelay;
  }

  if (parseBoolEnv('DATABASE_SSL', false)) {
    const rejectUnauthorized = parseBoolEnv('DATABASE_SSL_REJECT_UNAUTHORIZED', true);
  config.ssl = { rejectUnauthorized };
  }

  return config;
}

export const retryableErrorCodes = new Set<string>([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  'HY000',
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

const connectionErrorCodes = new Set<string>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EPIPE',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08006',
]);

const authErrorCodes = new Set<string>(['28P01', '28000']);

const serializationErrorCodes = new Set<string>(['40001', '40P01']);

function classifyDbError(err: unknown): DbErrorInfo {
  const error = err as { code?: string; message?: string; name?: string } | undefined;
  const code = error?.code;
  const message = error?.message ?? 'database error';
  const name = error?.name;

  let category: DbErrorCategory = 'other';
  if (code && connectionErrorCodes.has(code)) {
    category = 'connection';
  } else if (code && authErrorCodes.has(code)) {
    category = 'auth';
  } else if (code && serializationErrorCodes.has(code)) {
    category = 'serialization';
  } else if (code === '57014' || code === 'ERR_ABORTED' || name === 'AbortError' || (message && message.toLowerCase().includes('timeout'))) {
    category = 'timeout';
  } else if (!code && message.toLowerCase().includes('timeout')) {
    category = 'timeout';
  } else if (!code && /(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET)/i.test(message)) {
    category = 'connection';
  }

  const retryable = code ? retryableErrorCodes.has(code) || category === 'connection' || category === 'timeout' : category === 'connection' || category === 'timeout';

  let hint: string | undefined;
  if (category === 'connection') {
    const targetLabel = target.label;
    hint = `Ensure Postgres is running and reachable at ${targetLabel}. If using docker-compose, set DATABASE_URL to postgresql://<user>:<pass>@db:5432/<db>.`;
  } else if (category === 'auth') {
    hint = 'Verify that the DATABASE_URL username and password match the configured Postgres credentials.';
  } else if (category === 'timeout') {
    hint = 'Postgres is reachable but slow to respond; check for overload or increase DATABASE_CONN_TIMEOUT_MS.';
  } else if (category === 'serialization') {
    hint = 'Retry the transaction or adjust isolation levels to avoid serialization conflicts.';
  }

  return { code, message, category, retryable, hint };
}

function isRetryable(err: unknown): boolean {
  const info = classifyDbError(err);
  return info.retryable;
}

const poolConfig = buildPoolConfig();
const dbPool = poolConfig ? new Pool(poolConfig as any) : null;

if (dbPool) {
  dbPool.on('error', (err: unknown) => {
    const info = classifyDbError(err);
    const payload: Record<string, unknown> = {
      code: info.code,
      category: info.category,
      target: target.label,
      message: info.message,
    };
    if (info.hint) payload.hint = info.hint;
    log.error(payload, 'db-pool-error');
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_BOOT_ATTEMPTS = parseNumberEnv('DATABASE_BOOT_ATTEMPTS', 20);
const DEFAULT_BOOT_DELAY_MS = parseNumberEnv('DATABASE_BOOT_DELAY_MS', 1_500);
const DEFAULT_BOOT_BACKOFF = (() => {
  const raw = Number(process.env.DATABASE_BOOT_BACKOFF);
  return Number.isFinite(raw) && raw > 0 ? raw : 1.5;
})();
const DEFAULT_QUERY_RETRIES = parseNumberEnv('DATABASE_QUERY_MAX_RETRIES', 3);
const DEFAULT_QUERY_RETRY_DELAY_MS = parseNumberEnv('DATABASE_QUERY_RETRY_DELAY_MS', 250);
const DEFAULT_QUERY_RETRY_BACKOFF = (() => {
  const raw = Number(process.env.DATABASE_QUERY_RETRY_BACKOFF);
  return Number.isFinite(raw) && raw > 0 ? raw : 1.5;
})();

const queryTimeoutMs = parseNumberEnv('DATABASE_QUERY_TIMEOUT_MS', 30_000);

async function runQuery<T = any>(queryTextOrConfig: QueryInput, values: readonly unknown[] | undefined, attempt = 1): Promise<T> {
  if (!dbPool) {
    throw new Error('DATABASE_URL is not configured; unable to execute query');
  }

  const queryName = typeof queryTextOrConfig === 'string'
    ? queryTextOrConfig.split(' ')[0]?.toLowerCase() || 'unknown'
    : queryTextOrConfig.name || 'unknown';

  try {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      timeout = setTimeout(() => controller.abort(), queryTimeoutMs);
      const config = typeof queryTextOrConfig === 'string'
        ? { text: queryTextOrConfig, values }
        : { ...queryTextOrConfig, values: queryTextOrConfig.values ?? values };
      const result = await instrument('db', queryName, () => dbPool.query({ ...(config as Record<string, unknown>), signal: controller.signal }), { target: target.label });
      return result as T;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } catch (err) {
    if (isRetryable(err) && attempt < DEFAULT_QUERY_RETRIES) {
      const info = classifyDbError(err);
      const delay = DEFAULT_QUERY_RETRY_DELAY_MS * Math.pow(DEFAULT_QUERY_RETRY_BACKOFF, attempt - 1);
      const payload: Record<string, unknown> = {
        attempt,
        retries: DEFAULT_QUERY_RETRIES,
        code: info.code,
        category: info.category,
        target: target.label,
        delayMs: Math.round(delay),
        query: queryName,
      };
      if (info.hint) payload.hint = info.hint;
      log.warn(payload, 'db-query-retry');
      await sleep(delay);
      return runQuery<T>(queryTextOrConfig, values, attempt + 1);
    }
    const info = classifyDbError(err);
    const payload: Record<string, unknown> = {
      attempt,
      retries: DEFAULT_QUERY_RETRIES,
      code: info.code,
      category: info.category,
      target: target.label,
      query: queryName,
    };
    if (info.hint) payload.hint = info.hint;
    log.error(payload, 'db-query-failed');
    throw err;
  }
}

export async function waitForDb(options: { attempts?: number; delayMs?: number; backoffFactor?: number } = {}): Promise<void> {
  if (!dbPool) {
    throw new Error('DATABASE_URL is not configured');
  }

  const attempts = options.attempts ?? DEFAULT_BOOT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_BOOT_DELAY_MS;
  const backoff = options.backoffFactor ?? DEFAULT_BOOT_BACKOFF;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await runQuery('SELECT 1', undefined, 1);
      if (attempt > 1) {
        log.info({ attempt, attempts, target: target.label }, 'db-connect-recovered');
      } else {
        log.info({ target: target.label }, 'db-connect-ok');
      }
      return;
    } catch (err) {
      lastError = err;
      const info = classifyDbError(err);
      const payload: Record<string, unknown> = {
        attempt,
        attempts,
        code: info.code,
        category: info.category,
        target: target.label,
        delayMs: Math.round(delayMs * Math.pow(backoff, attempt - 1)),
      };
      if (info.hint) payload.hint = info.hint;
      if (attempt < attempts && info.retryable) {
        log.warn(payload, 'db-connect-retry');
        await sleep(delayMs * Math.pow(backoff, attempt - 1));
        continue;
      }
      log.error(payload, 'db-connect-failed');
      throw err;
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error('Failed to connect to database');
}

export const db = {
  query: <T = any>(queryTextOrConfig: QueryInput, values?: readonly unknown[]): Promise<T> => {
    return runQuery<T>(queryTextOrConfig, values);
  },
  end: async (): Promise<void> => {
    if (!dbPool) return;
    await dbPool.end();
  },
  classifyError: classifyDbError,
  target: target.label,
};

export { classifyDbError };
export type { DbErrorInfo };

