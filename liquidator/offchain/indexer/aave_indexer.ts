// Aave v3 subgraph driven candidate discovery for near-liquidation accounts
import { log } from '../infra/logger';
import { AppConfig, Market, chainById, ChainCfg, TokenInfo } from '../infra/config';

export type Candidate = {
  borrower: `0x${string}`;
  chainId: number;
  debt: { symbol: string; address: `0x${string}`; decimals: number; amount: bigint };
  collateral: { symbol: string; address: `0x${string}`; decimals: number; amount: bigint };
  healthFactor: number;
};

// Subgraph endpoints (configurable via env vars to allow alternative indexers or hosted mirrors)
const SUBGRAPH_URL: Record<number, string> = {
  42161: process.env.AAVE_V3_SUBGRAPH_ARB || 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
  10: process.env.AAVE_V3_SUBGRAPH_OP || 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-optimism',
};

// Messari-standardized Aave subgraph schema: fetch positions separately for debt (BORROWER) and collateral
const QUERY_BORROWER = `
  query BorrowerPositions($first: Int!, $debt: Bytes!) {
    positions(
      first: $first,
      orderBy: balance,
      orderDirection: desc,
      where: { side: BORROWER, asset_: { id: $debt } }
    ) {
      id
      balance
      account { id }
      asset { id symbol decimals }
      market { id }
    }
  }
`;

const QUERY_COLLATERAL = `
  query CollateralPositions($first: Int!, $coll: Bytes!) {
    positions(
      first: $first,
      orderBy: balance,
      orderDirection: desc,
      where: { side: COLLATERAL, asset_: { id: $coll } }
    ) {
      id
      balance
      account { id }
      asset { id symbol decimals }
      market { id }
    }
  }
`;

type GraphPosition = {
  id: string;
  balance: string; // BigInt string
  account: { id: string };
  asset: { id: string; symbol: string; decimals: number };
  market: { id: string };
};

const POLL_MS = 20_000;
const HF_THRESHOLD = 1.03;
const DEDUPE_MS = 5 * 60 * 1000;

async function graphFetch<T = any>(url: string, query: string, variables: Record<string, any>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`subgraph http ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { data?: any; errors?: any };
  if (json.errors) {
    throw new Error(`subgraph error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

function parseHealthFactor(raw: string): number {
  const numeric = Number(raw);
  if (Number.isNaN(numeric)) return 0;
  if (numeric > 1000) {
    return numeric / 1e18;
  }
  return numeric;
}

function applyIndexAmount(value: string, index: string): number {
  const scaled = Number(value);
  const idx = Number(index);
  if (!Number.isFinite(scaled) || !Number.isFinite(idx)) return 0;
  const ray = idx / 1e27;
  return scaled * ray;
}

// Helper to parse BigInt string safely
function parseBigIntOrZero(v: string | undefined): bigint {
  try { return v ? BigInt(v) : 0n; } catch { return 0n; }
}

function toTokenAmount(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const scaled = Math.floor(amount * 10 ** decimals);
  return BigInt(scaled);
}

function buildCandidateFromPositions(
  account: string,
  market: Market,
  chain: ChainCfg,
  debtToken: TokenInfo,
  collToken: TokenInfo,
  debtPos: GraphPosition,
  collPos: GraphPosition
): Candidate | null {
  const debtAmount = parseBigIntOrZero(debtPos.balance);
  const collateralAmount = parseBigIntOrZero(collPos.balance);
  if (debtAmount === 0n || collateralAmount === 0n) return null;

  return {
    borrower: account as `0x${string}`,
    chainId: market.chainId,
    debt: { symbol: market.debtAsset, address: debtToken.address, decimals: debtToken.decimals, amount: debtAmount },
    collateral: { symbol: market.collateralAsset, address: collToken.address, decimals: collToken.decimals, amount: collateralAmount },
    // healthFactor not provided by this schema; set >0 as placeholder, simulate() will enforce risk
    healthFactor: 0.99,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function* streamCandidates(cfg: AppConfig): AsyncGenerator<Candidate> {
  const dedupe = new Map<string, number>();

  while (true) {
    for (const market of cfg.markets.filter((m) => m.enabled)) {
      const chain = chainById(cfg, market.chainId);
      if (!chain || !chain.enabled) continue;

  const subgraph = SUBGRAPH_URL[market.chainId];
      if (!subgraph) {
        log.warn({ chainId: market.chainId }, 'missing-subgraph-url');
        continue;
      }

      const debtToken = chain.tokens[market.debtAsset];
      const collToken = chain.tokens[market.collateralAsset];
      if (!debtToken || !collToken) {
        log.warn({ market }, 'unknown-token');
        continue;
      }

      try {
        const t0 = Date.now();
        // Fetch top borrowers in the debt asset and top collateral holders in the coll asset
        const [borrowersRes, collRes] = await Promise.all([
          graphFetch<{ positions: GraphPosition[] }>(subgraph, QUERY_BORROWER, { first: 200, debt: debtToken.address.toLowerCase() }),
          graphFetch<{ positions: GraphPosition[] }>(subgraph, QUERY_COLLATERAL, { first: 200, coll: collToken.address.toLowerCase() }),
        ]);
        const borrowers = borrowersRes?.positions ?? [];
        const collaters = collRes?.positions ?? [];
        const dt = Date.now() - t0;
        log.debug({ chainId: chain.id, debt: market.debtAsset, coll: market.collateralAsset, borrowers: borrowers.length, collaters: collaters.length, ms: dt, subgraph }, 'subgraph-poll');

        // Index collateral positions by account
        const collByAcct = new Map<string, GraphPosition>();
        for (const c of collaters) collByAcct.set(c.account.id.toLowerCase(), c);

        // For each borrower, see if they have matching collateral
        let yielded = 0;
        for (const b of borrowers) {
          const acct = b.account.id.toLowerCase();
          const c = collByAcct.get(acct);
          if (!c) continue;
          const candidate = buildCandidateFromPositions(acct, market, chain, debtToken, collToken, b, c);
          if (!candidate) continue;

          const key = `${candidate.chainId}:${candidate.borrower}:${candidate.debt.address}:${candidate.collateral.address}`;
          const now = Date.now();
          const last = dedupe.get(key) ?? 0;
          if (now - last < DEDUPE_MS) continue;
          dedupe.set(key, now);
          yield candidate;
          yielded += 1;
          if (yielded >= 50) break; // backpressure
        }
      } catch (err) {
        // Downgrade to level 30 after repeated failures could be added; keep warn for visibility
        log.warn({ err: String(err), chainId: market.chainId, subgraph }, 'aave-indexer-failed');
      }
    }

    await delay(POLL_MS);
  }
}
