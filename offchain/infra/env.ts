import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';

// Load .env from project root (../.. from this file) or current working dir fallback
const ROOT = path.resolve(__dirname, '..', '..');
const CANDIDATES = [
  path.join(ROOT, '.env'),               // project root .env (preferred)
  path.resolve(ROOT, '..', '.env'),      // parent repo .env fallback
];

const PRESERVE_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'RISK_ENGINE_URL',
  'PROM_PORT',
  'RISK_ENGINE_PORT',
];

const preserved: Record<string, string | undefined> = {};
for (const key of PRESERVE_KEYS) {
  preserved[key] = process.env[key];
}

for (const p of CANDIDATES) {
  if (fs.existsSync(p)) {
    const result = dotenv.config({ path: p, override: true });
    dotenvExpand.expand(result as any);
    break;
  }
}

for (const key of PRESERVE_KEYS) {
  const val = preserved[key];
  if (val && val.trim() !== '' && !/\$\{.*\}/.test(val)) {
    process.env[key] = val;
  }
}

// Minimal validation for critical vars (non-fatal warnings only)
function warn(name: string) {
  if (!process.env[name] || /\$\{.*\}/.test(process.env[name] as string)) {
    console.warn(`[env] WARN missing or unexpanded var: ${name}`);
  }
}

['RPC_ARB','WALLET_PK_ARB','SAFE_ADDRESS_ARB','DATABASE_URL','REDIS_URL'].forEach(warn);
