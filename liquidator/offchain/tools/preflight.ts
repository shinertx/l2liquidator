import '../infra/env';
import { Address, createPublicClient, formatEther, formatUnits, getAddress, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, ChainCfg, TokenInfo, AppConfig } from '../infra/config';
import { log } from '../infra/logger';
import { db } from '../infra/db';
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
  42161: 'AAVE_V3_SUBGRAPH_ARB',
  10: 'AAVE_V3_SUBGRAPH_OP',
  8453: 'AAVE_V3_SUBGRAPH_BASE',
  137: 'AAVE_V3_SUBGRAPH_POLYGON',
};

const SUBGRAPH_IDS: Record<number, string> = {
  42161: 'DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B',
  10: 'DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb',
  8453: 'GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF',
  137: 'Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211',
};

const FALLBACKS: Record<number, string> = {
  42161: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
  10: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-optimism',
  8453: '',
  137: '',
};

const WALLET_PK_ENV: Record<number, string> = {
  42161: 'WALLET_PK_ARB',
  10: 'WALLET_PK_OP',
  8453: 'WALLET_PK_BASE',
  137: 'WALLET_PK_POLYGON',
};

const SAFE_ADDRESS_ENV: Record<number, string> = {
  42161: 'SAFE_ADDRESS_ARB',
  10: 'SAFE_ADDRESS_OP',
  8453: 'SAFE_ADDRESS_BASE',
  137: 'SAFE_ADDRESS_POLYGON',
};

const MIN_NATIVE_BALANCE_ENV: Record<number, string> = {
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
    return false;
  }
  try {
    await db.query('SELECT 1');
    log.info({}, 'preflight-db-ok');
    return true;
  } catch (err) {
    log.error({ err: (err as Error).message }, 'preflight-db-failed');
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  if (!process.env.REDIS_URL) {
    log.warn({ env: 'REDIS_URL' }, 'preflight-redis-missing-env');
    return false;
  }
  if (!redis) {
    log.error({}, 'preflight-redis-uninitialized');
    return false;
  }
  try {
    await redis.ping();
    log.info({}, 'preflight-redis-ok');
    return true;
  } catch (err) {
    log.error({ err: (err as Error).message }, 'preflight-redis-failed');
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
    } catch (err) {
      ok = false;
      log.error({ chainId: chain.id, err: (err as Error).message }, 'preflight-rpc-failed');
    }
  }
  return ok;
}

async function pingSubgraph(chainId: number, url: string) {
  if (!url) {
    log.warn({ chainId }, 'preflight-subgraph-missing-url');
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
      return false;
    }
    const meta = json.data?._meta ?? {};
    log.info({ chainId, url, block: meta.block?.number, timestamp: meta.block?.timestamp, deployment: meta.deployment, elapsed }, 'preflight-subgraph-ok');
    return true;
  } catch (err) {
    log.error({ chainId, url, err: (err as Error).message }, 'preflight-subgraph-request-failed');
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
      } catch (err) {
        ok = false;
        log.error({ chainId: chain.id, dex: 'UniV3', fee, err: (err as Error).message }, 'preflight-quote-failed');
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
      } catch (err) {
        ok = false;
        log.error({ chainId: chain.id, dex: 'CamelotV2', err: (err as Error).message }, 'preflight-quote-failed');
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
      } catch (err) {
        ok = false;
        log.error({ chainId: chain.id, dex: 'Velodrome', err: (err as Error).message }, 'preflight-quote-failed');
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
      } catch (err) {
        ok = false;
        log.error({ chainId: chain.id, dex: 'Aerodrome', err: (err as Error).message }, 'preflight-quote-failed');
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
          continue;
        }

        if (detail.stale) {
          log.warn({ chainId: chain.id, symbol, price: detail.priceUsd, ageSec: detail.ageSeconds }, 'preflight-oracle-stale');
        } else {
          log.info({ chainId: chain.id, symbol, price: detail.priceUsd, ageSec: detail.ageSeconds }, 'preflight-oracle-ok');
        }
      } catch (err) {
        ok = false;
        log.error({ chainId: chain.id, symbol, err: (err as Error).message }, 'preflight-oracle-failed');
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
      ok = false;
      continue;
    }
    const pk = process.env[pkEnv];
    if (!pk || pk.includes('MISSING')) {
      log.warn({ chainId: chain.id, env: pkEnv }, 'preflight-wallet-missing');
      ok = false;
      continue;
    }
    let account;
    try {
      account = privateKeyToAccount(pk as `0x${string}`);
    } catch (err) {
      log.error({ chainId: chain.id, env: pkEnv, err: (err as Error).message }, 'preflight-wallet-invalid');
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
        ok = false;
      } else {
        log.info({ chainId: chain.id, address: account.address, balanceEth }, 'preflight-wallet-ok');
      }
    } catch (err) {
      ok = false;
      log.error({ chainId: chain.id, err: (err as Error).message }, 'preflight-wallet-balance-failed');
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
      } else {
        log.info({ chainId: chain.id, owner: chainOwner }, 'preflight-liquidator-owner');
      }
      if (isPaused) {
        log.error({ chainId: chain.id }, 'preflight-liquidator-paused');
        ok = false;
      } else {
        log.info({ chainId: chain.id }, 'preflight-liquidator-unpaused');
      }
      if (beneficiary && beneficiary.toLowerCase() !== contractBeneficiary.toLowerCase()) {
        log.warn({ chainId: chain.id, beneficiary: contractBeneficiary, expected: beneficiary }, 'preflight-liquidator-beneficiary-mismatch');
      } else {
        log.info({ chainId: chain.id, beneficiary: contractBeneficiary }, 'preflight-liquidator-beneficiary');
      }

      for (const router of routersForChain(chain, cfg)) {
        try {
          const allowed = await client.readContract({ address, abi: LIQUIDATOR_STATE_ABI, functionName: 'allowedRouters', args: [router] });
          if (!allowed) {
            log.warn({ chainId: chain.id, router }, 'preflight-router-not-allowed');
            ok = false;
          } else {
            log.info({ chainId: chain.id, router }, 'preflight-router-allowed');
          }
        } catch (err) {
          ok = false;
          log.error({ chainId: chain.id, router, err: (err as Error).message }, 'preflight-router-check-failed');
        }
      }

      const tokens = tokensForChain(cfg, chain.id);
      for (const { symbol, info } of tokens) {
        try {
          const balance = (await client.readContract({ address: getAddress(info.address as Address), abi: ERC20_ABI, functionName: 'balanceOf', args: [address] })) as bigint;
          const formatted = formatUnits(balance, info.decimals);
          log.info({ chainId: chain.id, contract: address, token: symbol, balance: formatted }, 'preflight-liquidator-token-balance');
        } catch (err) {
          ok = false;
          log.error({ chainId: chain.id, contract: address, token: symbol, err: (err as Error).message }, 'preflight-liquidator-token-balance-failed');
        }
      }
    } catch (err) {
      ok = false;
      log.error({ chainId: chain.id, err: (err as Error).message }, 'preflight-liquidator-state-failed');
    }

    try {
      const nativeBalance = await client.getBalance({ address });
      if (nativeBalance > 0n) {
        log.info({ chainId: chain.id, contract: address, balanceEth: formatEther(nativeBalance) }, 'preflight-liquidator-native-balance');
      }
    } catch (err) {
      log.warn({ chainId: chain.id, contract: address, err: (err as Error).message }, 'preflight-liquidator-native-check-failed');
    }
  }
  return ok;
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

  if (redis) {
    try {
      await redis.quit();
    } catch {}
  }
  try {
    await db.end();
  } catch {}

  const allOk = results.every(Boolean);
  if (!allOk) {
    log.error({}, 'preflight-failed');
    process.exit(1);
  }
  log.info({}, 'preflight-ok');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
