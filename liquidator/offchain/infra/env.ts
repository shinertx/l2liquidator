import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';

// Load .env from project root (../.. from this file) or current working dir fallback
const ROOT = path.resolve(__dirname, '..', '..');
const CANDIDATES = [
  path.join(ROOT, '.env'),               // liquidator/.env (preferred)
  path.resolve(ROOT, '..', '.env'),      // repo root .env fallback
];

for (const p of CANDIDATES) {
  if (fs.existsSync(p)) {
  const result = dotenv.config({ path: p, override: true });
    dotenvExpand.expand(result as any);
    break;
  }
}

// Minimal validation for critical vars (non-fatal warnings only)
function warn(name: string) {
  if (!process.env[name] || /\$\{.*\}/.test(process.env[name] as string)) {
    // eslint-disable-next-line no-console
    console.warn(`[env] WARN missing or unexpanded var: ${name}`);
  }
}

['RPC_ARB','WALLET_PK_ARB','SAFE_ADDRESS_ARB','DATABASE_URL','REDIS_URL'].forEach(warn);
