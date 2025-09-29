import '../infra/env';
import fastify from 'fastify';
import { createPublicClient, http } from 'viem';
import { Address, getAddress } from 'viem';

import { loadConfig, chainById } from '../infra/config';
import { log } from '../infra/logger';
import { db } from '../infra/db';
import { stageProposal } from './proposals';
import { serializeRoutes } from '../util/serialize';
import { buildRouteOptions } from '../util/routes';
import { bestRoute } from '../simulator/router';
import { oraclePriceDetails } from '../indexer/price_watcher';

const app = fastify({ logger: false });
type AttemptRow = {
  id: number;
  chain_id: number;
  borrower: string;
  status: string;
  reason?: string;
  tx_hash?: string;
  details: any;
  created_at: string;
};
const hasDb = Boolean(process.env.DATABASE_URL);

function getLimit(query: Record<string, any>, fallback = 100): number {
  const raw = query.limit ?? query.n;
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 1000);
}

async function fetchAttempts(limit = 100, seconds?: number) {
  if (!hasDb) {
    throw new Error('DATABASE_URL not configured');
  }
  const params: Array<string | number> = [limit];
  let where = '';
  if (seconds && seconds > 0) {
    params.push(seconds);
    where = `WHERE created_at >= NOW() - ($2 || ' seconds')::interval`;
  }
  const sql = `
    SELECT id, chain_id, borrower, status, reason, tx_hash, details, created_at
    FROM liquidation_attempts
    ${where}
    ORDER BY created_at DESC
    LIMIT $1
  `;
  const res = await db.query(sql, params);
  return (res.rows as AttemptRow[]).map((row) => ({
    id: row.id,
    chainId: row.chain_id,
    borrower: row.borrower,
    status: row.status,
    reason: row.reason,
    txHash: row.tx_hash,
    details: row.details ?? null,
    createdAt: row.created_at,
  }));
}

app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/attempts', async (req, reply) => {
  try {
    const query = req.query as any;
    const limit = getLimit(query ?? {}, 200);
    const seconds = query?.seconds ? Number(query.seconds) : undefined;
    const rows = await fetchAttempts(limit, seconds);
    return { count: rows.length, rows };
  } catch (err) {
    reply.code(503);
    return { error: (err as Error).message };
  }
});

app.get('/metrics', async (req, reply) => {
  try {
    const query = req.query as any;
    const limit = getLimit(query ?? {}, 500);
    const seconds = query?.seconds ? Number(query.seconds) : 3600;
    const rows = await fetchAttempts(limit, seconds);

    const total = rows.length;
    const byStatus: Record<string, number> = {};
    let planned = 0;
    let planTotalBps = 0;
    let errors = 0;

    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      if (row.status === 'error') errors += 1;
      const est = row.details?.plan?.estNetBps;
      if (typeof est === 'number') {
        planned += 1;
        planTotalBps += est;
      }
    }
    const avgNetBps = planned ? planTotalBps / planned : 0;
    const errorRate = total ? errors / total : 0;
    return { total, byStatus, planned, avgNetBps, errorRate };
  } catch (err) {
    reply.code(503);
    return { error: (err as Error).message };
  }
});

app.get('/config', async () => {
  const cfg = loadConfig();
  return cfg;
});

function parsePair(pair: string) {
  const [debt, collateral] = pair.split('-');
  if (!debt || !collateral) throw new Error('pair must be formatted like DEBT-COLLATERAL');
  return { debt, collateral };
}

function decimalToBigInt(value: string, decimals: number): bigint {
  const [intPart, fracPart = ''] = value.split('.');
  const cleanInt = intPart || '0';
  const cleanFrac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  const intBig = BigInt(cleanInt);
  const fracBig = BigInt(cleanFrac || '0');
  const scale = BigInt(10) ** BigInt(decimals);
  return intBig * scale + fracBig;
}

app.get('/quotes', async (req, reply) => {
  const query = req.query as any;
  const cfg = loadConfig();
  const chainId = Number(query.chain ?? query.chainId ?? cfg.chains[0]?.id);
  const pairInput = query.pair ?? 'USDC-WETH';
  const amountInput = query.amount ?? '1';
  const slippageBps = Number(query.slippage ?? 0);

  const chain = chainById(cfg, chainId);
  if (!chain) {
    reply.code(400);
    return { error: `Unknown chain ${chainId}` };
  }

  const { debt, collateral } = parsePair(pairInput);
  const debtToken = chain.tokens[debt];
  const collateralToken = chain.tokens[collateral];
  if (!debtToken || !collateralToken) {
    reply.code(400);
    return { error: `Unsupported pair ${pairInput} on chain ${chainId}` };
  }

  const amountIn = decimalToBigInt(String(amountInput), debtToken.decimals);
  const client = createPublicClient({ transport: http(chain.rpc) });
  const { options } = buildRouteOptions(cfg, chain, debt, collateral);

  const quotes = await Promise.all(
    options.map(async (option) => {
      const routeSnapshot = serializeRoutes([option])[0];
      try {
        const result = await bestRoute({
          client,
          chain,
          collateral: collateralToken,
          debt: debtToken,
          seizeAmount: amountIn,
          slippageBps,
          options: [option],
        });
        if (!result) {
          return { route: routeSnapshot, error: 'no-quote' };
        }
        return {
          route: routeSnapshot,
          amountOutMin: result.amountOutMin.toString(),
          quotedOut: result.quotedOut.toString(),
        };
      } catch (err) {
        return { route: routeSnapshot, error: (err as Error).message };
      }
    })
  );

  const best = await bestRoute({
    client,
    chain,
    collateral: collateralToken,
    debt: debtToken,
    seizeAmount: amountIn,
    slippageBps,
    options,
  });

  return {
    chainId,
    pair: pairInput,
    amountIn: amountIn.toString(),
    quotes,
    best: best
      ? {
          dexId: best.dexId,
          router: best.router,
          uniFee: best.uniFee,
          solidlyStable: best.solidlyStable,
          solidlyFactory: best.solidlyFactory,
          amountOutMin: best.amountOutMin.toString(),
          quotedOut: best.quotedOut.toString(),
        }
      : null,
  };
});

app.get('/oracles', async (req, reply) => {
  const query = req.query as any;
  const cfg = loadConfig();
  const chainId = Number(query.chain ?? query.chainId ?? cfg.chains[0]?.id);
  const chain = chainById(cfg, chainId);
  if (!chain) {
    reply.code(400);
    return { error: `Unknown chain ${chainId}` };
  }
  const client = createPublicClient({ transport: http(chain.rpc) });
  const results = [] as Array<Record<string, unknown>>;
  for (const [symbol, token] of Object.entries(chain.tokens)) {
    const detail = await oraclePriceDetails(client, token);
    results.push({ symbol, address: token.address, ...detail });
  }
  return { chainId, results };
});

app.post('/propose', async (req, reply) => {
  try {
    const body = req.body as any;
    if (!body?.patch) {
      reply.code(400);
      return { error: 'patch field is required' };
    }
    const metadata = await stageProposal({
      patch: body.patch,
      hypothesis: body.hypothesis,
      successMetric: body.successMetric,
      killSwitch: body.killSwitch,
      author: body.author,
      source: body.source,
    });
    return { staged: metadata.stagedConfig, metadata };
  } catch (err) {
    reply.code(400);
    return { error: (err as Error).message };
  }
});

const port = Number(process.env.AGENT_API_PORT ?? 8787);
const host = process.env.AGENT_API_HOST ?? '0.0.0.0';

app
  .listen({ port, host })
  .then(() => {
    log.info({ port, host }, 'agent-api-started');
  })
  .catch((err: unknown) => {
    log.error({ err }, 'agent-api-failed');
    process.exit(1);
  });
