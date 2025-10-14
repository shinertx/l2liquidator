import '../infra/env';
import fs from 'fs';
import { Address, createPublicClient, formatEther, formatUnits, getAddress, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, ChainCfg, TokenInfo, AppConfig } from '../infra/config';
import { log } from '../infra/logger';
import { db, waitForDb, classifyDbError, type DbErrorInfo } from '../infra/db';
import { redis } from '../infra/redis';
import { oraclePriceDetails } from '../indexer/price_watcher';

const QUOTER_V2_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const UNIV2_ROUTER_ABI = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const;

const SOLIDLY_ROUTER_ABI = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      {
        name: 'routes',
        type: 'tuple[]',
        components: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'stable', type: 'bool' },
          { name: 'factory', type: 'address' },
        ],
      },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const;

type DiagnosticStatus = 'ok' | 'warn' | 'error';
type Diagnostic = {
  component: string;
  status: DiagnosticStatus;
  message: string;
  hint?: string;
  meta?: Record<string, unknown>;
};

const diagnostics: Diagnostic[] = [];

function recordDiagnostic(component: string, status: DiagnosticStatus, message: string, hint?: string, meta?: Record<string, unknown>) {
  diagnostics.push({ component, status, message, hint, meta });
}

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
] as const;

const LIQUIDATOR_STATE_ABI = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'beneficiary',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'allowedRouters',
    stateMutability: 'view',
    inputs: [{ type: 'address', name: 'router' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

const ENV_KEYS: Record<number, string> = {
  1: 'AAVE_V3_SUBGRAPH_ETH',
  42161: 'AAVE_V3_SUBGRAPH_ARB',
  10: 'AAVE_V3_SUBGRAPH_OP',
  8453: 'AAVE_V3_SUBGRAPH_BASE',
  137: 'AAVE_V3_SUBGRAPH_POLYGON',
};

const SUBGRAPH_IDS: Record<number, string> = {
  1: '',
  42161: 'DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B',
  10: 'DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb',
  8453: 'GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF',
  137: 'Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211',
};

const FALLBACKS: Record<number, string> = {
  1: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3',
  42161: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
  10: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-optimism',
  8453: '',
  137: '',
};

const WALLET_PK_ENV: Record<number, string> = {
  1: 'WALLET_PK_ETH',
  42161: 'WALLET_PK_ARB',
  10: 'WALLET_PK_OP',
  8453: 'WALLET_PK_BASE',
  137: 'WALLET_PK_POLYGON',
};

const SAFE_ADDRESS_ENV: Record<number, string> = {
  1: 'SAFE_ADDRESS_ETH',
  42161: 'SAFE_ADDRESS_ARB',
  10: 'SAFE_ADDRESS_OP',
  8453: 'SAFE_ADDRESS_BASE',
  137: 'SAFE_ADDRESS_POLYGON',
};

const MIN_NATIVE_BALANCE_ENV: Record<number, string> = {
  1: 'MIN_NATIVE_BALANCE_ETH',
  42161: 'MIN_NATIVE_BALANCE_ARB',
  10: 'MIN_NATIVE_BALANCE_OP',
  8453: 'MIN_NATIVE_BALANCE_BASE',
  137: 'MIN_NATIVE_BALANCE_POLYGON',
};

const DEFAULT_MIN_NATIVE_BALANCE = '0.05';

const PING_QUERY = `
  query SubgraphMeta {
    _meta {
      block {
        number
        timestamp
      }
      deployment
    }
  }
`;

function endpointFor(chainId: number): string {
  const key = ENV_KEYS[chainId];
  if (!key) return '';
  const envValue = process.env[key];
  if (envValue && !envValue.includes('<') && !envValue.includes('MISSING')) {
    return envValue;
  }
  const apiKey = process.env.GRAPH_API_KEY?.trim();
  const subgraphId = SUBGRAPH_IDS[chainId];
  if (apiKey && subgraphId) {
    return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;
  }
  return FALLBACKS[chainId] ?? '';
}

async function checkDatabase(): Promise<boolean> {
  if (!process.env.DATABASE_URL) {
    log.warn({ env: 'DATABASE_URL' }, 'preflight-db-missing-env');
    recordDiagnostic('database', 'error', 'DATABASE_URL env var is missing');
    return false;
  }
  try {
    await waitForDb({ attempts: 5, delayMs: 750, backoffFactor: 1.4 });
    log.info({ target: db.target }, 'preflight-db-ok');
    recordDiagnostic('database', 'ok', `Connected to Postgres at ${db.target}`);
    return true;
  } catch (err) {
    const info: DbErrorInfo = classifyDbError(err);
    const payload: Record<string, unknown> = {
      target: db.target,
      err: info.message,
      category: info.category,
      code: info.code,
    };
    if (info.hint) payload.hint = info.hint;
    log.error(payload, 'preflight-db-failed');
    recordDiagnostic('database', 'error', info.message, info.hint, { target: db.target, category: info.category, code: info.code });
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  if (!process.env.REDIS_URL) {
    log.warn({ env: 'REDIS_URL' }, 'preflight-redis-missing-env');
    recordDiagnostic('redis', 'error', 'REDIS_URL env var is missing');
    return false;
  }
  if (!redis) {
    log.error({}, 'preflight-redis-uninitialized');
    recordDiagnostic('redis', 'error', 'Redis client not initialized', 'Instantiate Redis client before running preflight.');
    return false;
  }
  try {
    await redis.ping();
    log.info({}, 'preflight-redis-ok');
    recordDiagnostic('redis', 'ok', 'Redis responded to PING');
    return true;
  } catch (err) {
    const message = (err as Error).message;
    const code = (err as any)?.code as string | undefined;
    const hint = code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')
      ? `Ensure Redis is reachable at ${process.env.REDIS_URL ?? 'configured endpoint'} and running.`
      : undefined;
    const payload: Record<string, unknown> = { err: message };
    if (code) payload.code = code;
    if (hint) payload.hint = hint;
    log.error(payload, 'preflight-redis-failed');
    recordDiagnostic('redis', 'error', message, hint, { code });
    return false;
  }
}

async function checkRpcs(cfg = loadConfig()): Promise<boolean> {
  let ok = true;
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    try {
      const client = createPublicClient({ transport: http(chain.rpc) });
      const block = await client.getBlockNumber();
      log.info({ chainId: chain.id, block: block.toString() }, 'preflight-rpc-ok');
      recordDiagnostic('rpc', 'ok', `RPC reachable for chain ${chain.id}`, undefined, { chainId: chain.id, block: block.toString(), rpc: chain.rpc });
    } catch (err) {
      ok = false;
      const message = (err as Error).message;
      log.error({ chainId: chain.id, err: message }, 'preflight-rpc-failed');
      recordDiagnostic('rpc', 'error', message, undefined, { chainId: chain.id, rpc: chain.rpc });
    }
  }
  return ok;
}

async function pingSubgraph(chainId: number, url: string) {
  if (!url) {
    log.warn({ chainId }, 'preflight-subgraph-missing-url');
    recordDiagnostic('subgraph', 'error', `Missing subgraph URL for chain ${chainId}`, 'Set AAVE_V3_SUBGRAPH_<CHAIN> or provide fallback.', { chainId });
    return false;
  }
  const started = Date.now();
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const apiKey = process.env.GRAPH_API_KEY?.trim();
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: PING_QUERY }),
    });
    const elapsed = Date.now() - started;
    if (!res.ok) {
      const text = await res.text();
      log.error({ chainId, url, status: res.status, text, elapsed }, 'preflight-subgraph-http-failed');
      return false;
    }
    const json = (await res.json()) as { data?: { _meta?: { block?: { number?: number; timestamp?: number }; deployment?: string } }; errors?: unknown };
    if (json.errors) {
      log.error({ chainId, url, errors: json.errors, elapsed }, 'preflight-subgraph-graphql-failed');
      recordDiagnostic('subgraph', 'error', 'GraphQL error from subgraph', undefined, { chainId, url, errors: json.errors, elapsed });
      return false;
    }
    const meta = json.data?._meta ?? {};
    log.info({ chainId, url, block: meta.block?.number, timestamp: meta.block?.timestamp, deployment: meta.deployment, elapsed }, 'preflight-subgraph-ok');
    recordDiagnostic('subgraph', 'ok', `Subgraph responded for chain ${chainId}`, undefined, { chainId, url, block: meta.block?.number, elapsed });
    return true;
  } catch (err) {
    const message = (err as Error).message;
    log.error({ chainId, url, err: message }, 'preflight-subgraph-request-failed');
    recordDiagnostic('subgraph', 'error', message, undefined, { chainId, url });
    return false;
  }
}

async function checkSubgraphs(cfg = loadConfig()): Promise<boolean> {
  const seen = new Set<number>();
  for (const market of cfg.markets.filter((m) => m.enabled)) {
    seen.add(market.chainId);
  }
  let ok = true;
  for (const chainId of seen) {
    const url = endpointFor(chainId);
    const result = await pingSubgraph(chainId, url);
    ok = ok && result;
  }
  return ok;
}

async function checkQuotes(cfg = loadConfig()): Promise<boolean> {
  let ok = true;
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    const client = createPublicClient({ transport: http(chain.rpc) });
    const tokens = chain.tokens;
    const usdc = tokens['USDC'] || tokens['USDC.e'] || tokens['USDbC'];
    const weth = tokens['WETH'] || tokens['ETH'];
    if (!usdc || !weth) {
      log.warn({ chainId: chain.id }, 'preflight-quote-missing-tokens');
      recordDiagnostic('dex-quotes', 'error', `Missing USDC/WETH metadata on chain ${chain.id}`, 'Run npm run sync:aave or update config tokens.', { chainId: chain.id });
      ok = false;
      continue;
    }

    const amountIn = BigInt(1_000_000);
    const usdcAddr = getAddress(usdc.address as Address);
    const wethAddr = getAddress(weth.address as Address);

  const fees = [100, 500, 3000];
    for (const fee of fees) {
      try {
        if (!chain.quoter) {
          log.warn({ chainId: chain.id }, 'preflight-quote-missing-quoter');
          recordDiagnostic('dex-quotes', 'error', `Missing UniV3 quoter for chain ${chain.id}`, 'Add quoter address to config.yaml', { chainId: chain.id });
          ok = false;
          continue;
        }
        const quoter = getAddress(chain.quoter as Address);
        const { result } = await client.simulateContract({
          address: quoter,
          abi: QUOTER_V2_ABI,
          functionName: 'quoteExactInputSingle',
          args: [{ tokenIn: usdcAddr, tokenOut: wethAddr, amountIn, fee, sqrtPriceLimitX96: 0n }],
          account: usdcAddr,
        });
        const amountOut = (result as any)[0] as bigint;
        log.info({ chainId: chain.id, dex: 'UniV3', fee, amountIn: amountIn.toString(), amountOut: amountOut.toString() }, 'preflight-quote-ok');
        recordDiagnostic('dex-quotes', 'ok', `UniV3 quote ok on chain ${chain.id}`, undefined, { chainId: chain.id, dex: 'UniV3', fee, amountOut: amountOut.toString() });
      } catch (err) {
        ok = false;
        const message = (err as Error).message;
        log.error({ chainId: chain.id, dex: 'UniV3', fee, err: message }, 'preflight-quote-failed');
        recordDiagnostic('dex-quotes', 'error', message, undefined, { chainId: chain.id, dex: 'UniV3', fee });
      }
    }

  const dex = cfg.dexRouters?.[chain.id] ?? {};
    if (dex.camelotV2) {
      try {
        const amounts = await client.readContract({
          address: getAddress(dex.camelotV2 as Address),
          abi: UNIV2_ROUTER_ABI,
          functionName: 'getAmountsOut',
          args: [amountIn, [usdcAddr, wethAddr]],
        });
        const out = (amounts as any).amounts ?? amounts;
        const last = Array.isArray(out) ? out[out.length - 1] : out;
        log.info({ chainId: chain.id, dex: 'CamelotV2', amountOut: (last as bigint).toString() }, 'preflight-quote-ok');
        recordDiagnostic('dex-quotes', 'ok', `CamelotV2 quote ok on chain ${chain.id}`, undefined, { chainId: chain.id, dex: 'CamelotV2', amountOut: (last as bigint).toString() });
      } catch (err) {
        ok = false;
        const message = (err as Error).message;
        log.error({ chainId: chain.id, dex: 'CamelotV2', err: message }, 'preflight-quote-failed');
        recordDiagnostic('dex-quotes', 'error', message, undefined, { chainId: chain.id, dex: 'CamelotV2' });
      }
    }

    if (dex.velodrome && dex.velodromeFactory) {
      try {
        const amounts = await client.readContract({
          address: getAddress(dex.velodrome as Address),
          abi: SOLIDLY_ROUTER_ABI,
          functionName: 'getAmountsOut',
          args: [amountIn, [{ from: usdcAddr, to: wethAddr, stable: false, factory: getAddress(dex.velodromeFactory as Address) }]],
        });
        const out = (amounts as any).amounts ?? amounts;
        const last = Array.isArray(out) ? out[out.length - 1] : out;
        log.info({ chainId: chain.id, dex: 'Velodrome', amountOut: (last as bigint).toString() }, 'preflight-quote-ok');
        recordDiagnostic('dex-quotes', 'ok', `Velodrome quote ok on chain ${chain.id}`, undefined, { chainId: chain.id, dex: 'Velodrome', amountOut: (last as bigint).toString() });
      } catch (err) {
        ok = false;
        const message = (err as Error).message;
        log.error({ chainId: chain.id, dex: 'Velodrome', err: message }, 'preflight-quote-failed');
        recordDiagnostic('dex-quotes', 'error', message, undefined, { chainId: chain.id, dex: 'Velodrome' });
      }
    }

    if (dex.aerodrome && dex.aerodromeFactory) {
      try {
        const amounts = await client.readContract({
          address: getAddress(dex.aerodrome as Address),
          abi: SOLIDLY_ROUTER_ABI,
          functionName: 'getAmountsOut',
          args: [amountIn, [{ from: usdcAddr, to: wethAddr, stable: false, factory: getAddress(dex.aerodromeFactory as Address) }]],
        });
        const out = (amounts as any).amounts ?? amounts;
        const last = Array.isArray(out) ? out[out.length - 1] : out;
        log.info({ chainId: chain.id, dex: 'Aerodrome', amountOut: (last as bigint).toString() }, 'preflight-quote-ok');
        recordDiagnostic('dex-quotes', 'ok', `Aerodrome quote ok on chain ${chain.id}`, undefined, { chainId: chain.id, dex: 'Aerodrome', amountOut: (last as bigint).toString() });
      } catch (err) {
        ok = false;
        const message = (err as Error).message;
        log.error({ chainId: chain.id, dex: 'Aerodrome', err: message }, 'preflight-quote-failed');
        recordDiagnostic('dex-quotes', 'error', message, undefined, { chainId: chain.id, dex: 'Aerodrome' });
      }
    }
  }
  return ok;
}

async function checkOracles(cfg = loadConfig()): Promise<boolean> {
  let ok = true;
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    const client = createPublicClient({ transport: http(chain.rpc) });
    for (const [symbol, token] of Object.entries(chain.tokens)) {
      if (!token.chainlinkFeed) continue;
      try {
        const detail = await oraclePriceDetails(client, token);
        if (!detail || typeof detail.priceUsd !== 'number') {
          log.warn({ chainId: chain.id, symbol, token: token.address }, 'preflight-oracle-missing-price');
          recordDiagnostic('oracle', 'warn', `Missing oracle price for ${symbol} on chain ${chain.id}`, 'Check Chainlink feed or fallback configuration.', { chainId: chain.id, symbol, feed: token.chainlinkFeed });
          continue;
        }

        if (detail.stale) {
          log.warn({ chainId: chain.id, symbol, price: detail.priceUsd, ageSec: detail.ageSeconds }, 'preflight-oracle-stale');
          recordDiagnostic('oracle', 'warn', `Oracle price stale for ${symbol} on chain ${chain.id}`, 'Validate oracle freshness or enable TWAP fallback.', { chainId: chain.id, symbol, ageSec: detail.ageSeconds });
        } else {
          log.info({ chainId: chain.id, symbol, price: detail.priceUsd, ageSec: detail.ageSeconds }, 'preflight-oracle-ok');
          recordDiagnostic('oracle', 'ok', `Oracle healthy for ${symbol} on chain ${chain.id}`, undefined, { chainId: chain.id, symbol, ageSec: detail.ageSeconds });
        }
      } catch (err) {
        ok = false;
        const message = (err as Error).message;
        log.error({ chainId: chain.id, symbol, err: message }, 'preflight-oracle-failed');
        recordDiagnostic('oracle', 'error', message, undefined, { chainId: chain.id, symbol });
      }
    }
  }
  return ok;
}

function minNativeBalanceWei(chainId: number): bigint {
  const specific = process.env[MIN_NATIVE_BALANCE_ENV[chainId] ?? ''] ?? process.env.MIN_NATIVE_BALANCE_DEFAULT;
  const raw = (specific && specific.trim().length > 0 ? specific : DEFAULT_MIN_NATIVE_BALANCE).trim();
  try {
    return parseEther(raw);
  } catch {
    log.warn({ chainId, raw }, 'preflight-native-balance-threshold-invalid');
    return parseEther(DEFAULT_MIN_NATIVE_BALANCE);
  }
}

async function checkWalletBalances(cfg = loadConfig()): Promise<boolean> {
  let ok = true;
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    const pkEnv = WALLET_PK_ENV[chain.id];
    if (!pkEnv) {
      log.warn({ chainId: chain.id }, 'preflight-wallet-missing-env-mapping');
      recordDiagnostic('wallet', 'error', `No WALLET_PK mapping for chain ${chain.id}`, 'Add entry to WALLET_PK env map.', { chainId: chain.id });
      ok = false;
      continue;
    }
    const pk = process.env[pkEnv];
    if (!pk || pk.includes('MISSING')) {
      log.warn({ chainId: chain.id, env: pkEnv }, 'preflight-wallet-missing');
  recordDiagnostic('wallet', 'error', `Missing private key env ${pkEnv}`, `Populate ${pkEnv} with a funded wallet.`, { chainId: chain.id, env: pkEnv });
      ok = false;
      continue;
    }
    let account;
    try {
      account = privateKeyToAccount(pk as `0x${string}`);
    } catch (err) {
      log.error({ chainId: chain.id, env: pkEnv, err: (err as Error).message }, 'preflight-wallet-invalid');
      recordDiagnostic('wallet', 'error', `Invalid private key in ${pkEnv}`, 'Ensure the env var contains a 0x-prefixed hex key.', { chainId: chain.id, env: pkEnv });
      ok = false;
      continue;
    }
    const client = createPublicClient({ transport: http(chain.rpc) });
    try {
      const balance = await client.getBalance({ address: account.address });
      const minBalance = minNativeBalanceWei(chain.id);
      const balanceEth = formatEther(balance);
      const minEth = formatEther(minBalance);
      if (balance < minBalance) {
        log.warn({ chainId: chain.id, address: account.address, balanceEth, minEth }, 'preflight-wallet-low-balance');
        recordDiagnostic('wallet', 'warn', `Wallet low balance on chain ${chain.id}`, 'Top up native token for gas.', { chainId: chain.id, address: account.address, balanceEth, minEth });
        ok = false;
      } else {
        log.info({ chainId: chain.id, address: account.address, balanceEth }, 'preflight-wallet-ok');
        recordDiagnostic('wallet', 'ok', `Wallet funded on chain ${chain.id}`, undefined, { chainId: chain.id, address: account.address, balanceEth });
      }
    } catch (err) {
      ok = false;
      const message = (err as Error).message;
      log.error({ chainId: chain.id, err: message }, 'preflight-wallet-balance-failed');
      recordDiagnostic('wallet', 'error', message, undefined, { chainId: chain.id, address: account.address });
    }
  }
  return ok;
}

function routersForChain(chain: ChainCfg, cfg: AppConfig): `0x${string}`[] {
  const routers = new Set<string>();
  if (chain.uniV3Router) routers.add(getAddress(chain.uniV3Router as Address));
  const extra = cfg.dexRouters?.[chain.id];
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value !== 'string' || !value.startsWith('0x') || value.length !== 42) continue;
      const keyLower = key.toLowerCase();
      if (keyLower.includes('factory') || keyLower === 'tokens') continue;
      routers.add(getAddress(value as Address));
    }
  }
  return Array.from(routers) as `0x${string}`[];
}

function tokensForChain(cfg: AppConfig, chainId: number): { symbol: string; info: TokenInfo }[] {
  const chain = cfg.chains.find((c) => c.id === chainId);
  if (!chain) return [];
  const markets = cfg.markets.filter((m) => m.enabled && m.chainId === chainId);
  const seen = new Set<string>();
  const out: { symbol: string; info: TokenInfo }[] = [];
  for (const market of markets) {
    for (const asset of [market.debtAsset, market.collateralAsset]) {
      const info = chain.tokens[asset];
      if (!info) {
        log.warn({ chainId, asset }, 'preflight-token-missing-config');
        continue;
      }
      const key = info.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ symbol: asset, info });
    }
  }
  return out;
}

async function checkContracts(cfg = loadConfig()): Promise<boolean> {
  let ok = true;
  const { contracts, beneficiary } = cfg;
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    const address = contracts?.liquidator?.[chain.id];
    if (!address) {
      log.warn({ chainId: chain.id }, 'preflight-liquidator-missing');
      recordDiagnostic('contracts', 'error', `Missing liquidator address for chain ${chain.id}`, 'Deploy contract and update config.', { chainId: chain.id });
      ok = false;
      continue;
    }
    const client = createPublicClient({ transport: http(chain.rpc) });
    try {
      const [owner, paused, chainBeneficiary] = await Promise.all([
        client.readContract({ address, abi: LIQUIDATOR_STATE_ABI, functionName: 'owner' }),
        client.readContract({ address, abi: LIQUIDATOR_STATE_ABI, functionName: 'paused' }),
        client.readContract({ address, abi: LIQUIDATOR_STATE_ABI, functionName: 'beneficiary' }),
      ]);
      const chainOwner = owner as `0x${string}`;
      const isPaused = Boolean(paused);
      const contractBeneficiary = chainBeneficiary as `0x${string}`;
      const safeEnv = SAFE_ADDRESS_ENV[chain.id];
      const expectedOwner = safeEnv && process.env[safeEnv] ? getAddress(process.env[safeEnv] as Address) : undefined;
      if (expectedOwner && expectedOwner.toLowerCase() !== chainOwner.toLowerCase()) {
        log.warn({ chainId: chain.id, owner: chainOwner, expectedOwner }, 'preflight-liquidator-owner-mismatch');
        recordDiagnostic('contracts', 'warn', 'Liquidator owner mismatch', 'Update SAFE address or transfer ownership.', { chainId: chain.id, owner: chainOwner, expectedOwner });
      } else {
        log.info({ chainId: chain.id, owner: chainOwner }, 'preflight-liquidator-owner');
        recordDiagnostic('contracts', 'ok', `Owner verified on chain ${chain.id}`, undefined, { chainId: chain.id, owner: chainOwner });
      }
      if (isPaused) {
        log.error({ chainId: chain.id }, 'preflight-liquidator-paused');
        recordDiagnostic('contracts', 'error', 'Liquidator is paused', 'Unpause contract before running orchestrator.', { chainId: chain.id });
        ok = false;
      } else {
        log.info({ chainId: chain.id }, 'preflight-liquidator-unpaused');
        recordDiagnostic('contracts', 'ok', `Liquidator active on chain ${chain.id}`);
      }
      if (beneficiary && beneficiary.toLowerCase() !== contractBeneficiary.toLowerCase()) {
        log.warn({ chainId: chain.id, beneficiary: contractBeneficiary, expected: beneficiary }, 'preflight-liquidator-beneficiary-mismatch');
        recordDiagnostic('contracts', 'warn', 'Beneficiary mismatch', 'Align beneficiary in config or contract.', { chainId: chain.id, beneficiary: contractBeneficiary, expected: beneficiary });
      } else {
        log.info({ chainId: chain.id, beneficiary: contractBeneficiary }, 'preflight-liquidator-beneficiary');
        recordDiagnostic('contracts', 'ok', `Beneficiary verified on chain ${chain.id}`, undefined, { chainId: chain.id, beneficiary: contractBeneficiary });
      }

      for (const router of routersForChain(chain, cfg)) {
        try {
          const allowed = await client.readContract({ address, abi: LIQUIDATOR_STATE_ABI, functionName: 'allowedRouters', args: [router] });
          if (!allowed) {
            log.warn({ chainId: chain.id, router }, 'preflight-router-not-allowed');
            recordDiagnostic('contracts', 'warn', 'Router not allowed', 'Call allowRouter on liquidator.', { chainId: chain.id, router });
            ok = false;
          } else {
            log.info({ chainId: chain.id, router }, 'preflight-router-allowed');
            recordDiagnostic('contracts', 'ok', `Router ${router} allowed on chain ${chain.id}`, undefined, { chainId: chain.id, router });
          }
        } catch (err) {
          ok = false;
          const message = (err as Error).message;
          log.error({ chainId: chain.id, router, err: message }, 'preflight-router-check-failed');
          recordDiagnostic('contracts', 'error', message, undefined, { chainId: chain.id, router });
        }
      }

      const tokens = tokensForChain(cfg, chain.id);
      for (const { symbol, info } of tokens) {
        try {
          const balance = (await client.readContract({ address: getAddress(info.address as Address), abi: ERC20_ABI, functionName: 'balanceOf', args: [address] })) as bigint;
          const formatted = formatUnits(balance, info.decimals);
          log.info({ chainId: chain.id, contract: address, token: symbol, balance: formatted }, 'preflight-liquidator-token-balance');
          recordDiagnostic('inventory', 'ok', `Liquidator holds ${symbol} on chain ${chain.id}`, undefined, { chainId: chain.id, token: symbol, balance: formatted });
        } catch (err) {
          ok = false;
          const message = (err as Error).message;
          log.error({ chainId: chain.id, contract: address, token: symbol, err: message }, 'preflight-liquidator-token-balance-failed');
          recordDiagnostic('inventory', 'error', message, undefined, { chainId: chain.id, token: symbol });
        }
      }
    } catch (err) {
      ok = false;
      const message = (err as Error).message;
      log.error({ chainId: chain.id, err: message }, 'preflight-liquidator-state-failed');
      recordDiagnostic('contracts', 'error', message, undefined, { chainId: chain.id });
    }

    try {
      const nativeBalance = await client.getBalance({ address });
      if (nativeBalance > 0n) {
        log.info({ chainId: chain.id, contract: address, balanceEth: formatEther(nativeBalance) }, 'preflight-liquidator-native-balance');
        recordDiagnostic('inventory', 'ok', `Liquidator native balance ${formatEther(nativeBalance)} on chain ${chain.id}`, undefined, { chainId: chain.id, balanceEth: formatEther(nativeBalance) });
      }
    } catch (err) {
      const message = (err as Error).message;
      log.warn({ chainId: chain.id, contract: address, err: message }, 'preflight-liquidator-native-check-failed');
      recordDiagnostic('inventory', 'warn', message, undefined, { chainId: chain.id });
    }
  }
  return ok;
}

function checkKillSwitchStatus(): boolean {
  const killPath = process.env.KILL_SWITCH_FILE;
  if (!killPath) {
    recordDiagnostic('kill-switch', 'ok', 'No kill switch configured');
    return true;
  }
  if (fs.existsSync(killPath)) {
    log.warn({ killSwitchFile: killPath }, 'preflight-kill-switch-active');
    recordDiagnostic('kill-switch', 'error', `Kill switch file present at ${killPath}`, 'Remove the file to resume operations.', { killSwitchFile: killPath });
    return false;
  }
  log.info({ killSwitchFile: killPath }, 'preflight-kill-switch-clear');
  recordDiagnostic('kill-switch', 'ok', 'Kill switch clear', undefined, { killSwitchFile: killPath });
  return true;
}

async function main() {
  const cfg = loadConfig();
  const results = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkRpcs(cfg),
    checkSubgraphs(cfg),
    checkQuotes(cfg),
    checkOracles(cfg),
    checkWalletBalances(cfg),
    checkContracts(cfg),
  ]);

  const killSwitchOk = checkKillSwitchStatus();

  const nonOkDiagnostics = diagnostics.filter((d) => d.status !== 'ok');
  const okHighlights = diagnostics.filter((d) => d.status === 'ok' && ['database', 'redis', 'kill-switch'].includes(d.component));
  const diagnosticSummary = nonOkDiagnostics.length > 0 ? nonOkDiagnostics : okHighlights;
  if (diagnosticSummary.length > 0) {
    log.info({ diagnostics: diagnosticSummary }, 'preflight-diagnostics');
  }

  if (redis) {
    try {
      await redis.quit();
    } catch {}
  }
  try {
    await db.end();
  } catch {}

  const allOk = results.every(Boolean) && killSwitchOk;
  if (!allOk) {
    log.error({}, 'preflight-failed');
    process.exit(1);
  }
  log.info({}, 'preflight-ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
