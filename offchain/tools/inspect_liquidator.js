#!/usr/bin/env node
// Lightweight JS inspector to avoid ts-node dependency in container
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { createPublicClient, http, parseAbi, getAddress } = require('viem');

function loadConfig(cfgPath) {
  const candidates = [];
  if (cfgPath) candidates.push(cfgPath);
  if (process.env.CONFIG_PATH) candidates.push(process.env.CONFIG_PATH);
  // Common container paths
  candidates.push('/app/config.yaml');
  // Relative to this file when copied to /app/tools
  candidates.push(path.resolve(__dirname, '../config.yaml'));
  // Relative to this file when running from repo (offchain/tools)
  candidates.push(path.resolve(__dirname, '../../config.yaml'));
  candidates.push('config.yaml');

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = YAML.parse(raw);
        return interpolateEnv(parsed);
      }
    } catch (_) {}
  }
  throw new Error('config.yaml not found; tried: ' + candidates.join(', '));
}

function interpolateEnv(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return obj.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? `MISSING:${n}`);
  if (Array.isArray(obj)) return obj.map(interpolateEnv);
  if (typeof obj === 'object') {
    const out = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) out[k] = interpolateEnv(v);
    return out;
  }
  return obj;
}

function chainByArg(cfg, arg) {
  const asNum = Number(arg);
  if (Number.isFinite(asNum)) return cfg.chains.find((c) => c.id === asNum);
  return cfg.chains.find((c) => c.name.toLowerCase() === String(arg).toLowerCase());
}

function privateKeyForChain(chain) {
  // Prefer WALLET_PK_<NAME>
  const key = `WALLET_PK_${chain.name.toUpperCase()}`;
  if (process.env[key]) return process.env[key];
  // Fallback aliases
  switch (chain.name.toLowerCase()) {
    case 'arbitrum':
      return process.env.WALLET_PK_ARB;
    case 'optimism':
    case 'op':
      return process.env.WALLET_PK_OP;
    case 'base':
      return process.env.WALLET_PK_BASE;
    case 'polygon':
      return process.env.WALLET_PK_POLYGON;
    default:
      return undefined;
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node offchain/tools/inspect_liquidator.js <chainName|chainId>');
    process.exit(1);
  }

  // Load env if present
  try { require('dotenv').config(); } catch (_) {}

  const cfg = loadConfig();
  const chain = chainByArg(cfg, arg);
  if (!chain) throw new Error('Unknown chain ' + arg);
  const liq = cfg.contracts && cfg.contracts.liquidator && cfg.contracts.liquidator[String(chain.id)];
  if (!liq) throw new Error('No liquidator address for chain ' + chain.id);
  let rpc = chain.rpc;
  const unresolved = !rpc || /\$\{/.test(rpc) || /^MISSING:/.test(rpc);
  if (unresolved) {
    // Public defaults as a last resort
    const publicRpc = {
      42161: 'https://arb1.arbitrum.io/rpc',
      10: 'https://mainnet.optimism.io',
      8453: 'https://mainnet.base.org',
      137: 'https://polygon-rpc.com',
    }[chain.id];
    if (publicRpc) rpc = publicRpc;
  }
  if (!rpc || /\$\{/.test(rpc) || /^MISSING:/.test(rpc)) {
    // Fallback: try to read from orchestrator logs which print rpc on boot
    try {
      const logPath = '/app/logs/live.log';
      if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).slice(-1000);
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (!line) continue;
          if (line.includes('rpc-http-client-created') && line.includes(`"chainId":${chain.id}`)) {
            try {
              const obj = JSON.parse(line);
              if (obj && typeof obj.rpc === 'string' && obj.rpc.startsWith('http')) { rpc = obj.rpc; break; }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }
  if (!rpc || /\$\{/.test(rpc) || /^MISSING:/.test(rpc)) throw new Error('RPC not resolved for ' + chain.name + ' (check env)');

  const client = createPublicClient({ transport: http(rpc) });
  const address = getAddress(liq);
  const uniV3 = getAddress(chain.uniV3Router);

  const abi = parseAbi([
    'function owner() view returns (address)',
    'function executors(address) view returns (bool)',
    'function allowedRouters(address) view returns (bool)'
  ]);

  let botAddr;
  try {
    const pk = privateKeyForChain(chain);
    if (pk && /^0x[0-9a-fA-F]{64}$/.test(pk)) {
      const { privateKeyToAccount } = require('viem/accounts');
      botAddr = privateKeyToAccount(pk).address;
    }
  } catch (_) {}

  const code = await client.getBytecode({ address });
  let owner = null, isExec = null, routerAllowed = null, execErr = null;
  try { owner = await client.readContract({ address, abi, functionName: 'owner' }); } catch (e) { execErr = String(e.message || e); }
  try { if (botAddr) isExec = await client.readContract({ address, abi, functionName: 'executors', args: [botAddr] }); } catch (e) { execErr = String(e.message || e); }
  try { routerAllowed = await client.readContract({ address, abi, functionName: 'allowedRouters', args: [uniV3] }); } catch (e) { execErr = String(e.message || e); }

  const out = { chain: chain.name, chainId: chain.id, rpc, contract: address, bytecode: code ? code.length : 0, uniV3, owner, bot: botAddr, isExec, routerAllowed, error: execErr };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
