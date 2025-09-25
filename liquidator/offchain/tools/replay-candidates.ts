#!/usr/bin/env ts-node
import fs from 'fs';
import path from 'path';
import { createPublicClient, http } from 'viem';
import { loadConfig, chainById } from '../infra/config';
import { oraclePriceUsd } from '../indexer/price_watcher';
import { simulate } from '../simulator/simulate';
import { buildRouteOptions } from '../util/routes';

import '../infra/env';

interface RawCandidate {
  borrower: `0x${string}`;
  chainId: number;
  debt: { symbol: string; address: `0x${string}`; decimals: number; amount: bigint | string | number };
  collateral: { symbol: string; address: `0x${string}`; decimals: number; amount: bigint | string | number };
}

function usage(): never {
  console.error('Usage: ts-node replay-candidates.ts <file.json> [--limit N]');
  process.exit(1);
}

function toBigInt(value: bigint | string | number): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.floor(value));
  if (typeof value === 'string') return value.startsWith('0x') ? BigInt(value) : BigInt(value);
  throw new Error(`unsupported amount type ${typeof value}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) usage();
  const file = path.resolve(process.cwd(), args[0]);
  const limitIndex = args.findIndex((a) => a === '--limit');
  const limit = (() => {
    if (limitIndex === -1) return undefined;
    const value = args[limitIndex + 1];
    if (!value) usage();
    const parsed = Number(value);
    if (Number.isNaN(parsed)) usage();
    return parsed;
  })();
  if (!fs.existsSync(file)) {
    console.error('File not found:', file);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawCandidate[];
  const cfg = loadConfig();
  const clients = new Map<number, ReturnType<typeof createPublicClient>>();

  let processed = 0;
  let ready = 0;
  let viable = 0;

  for (const candidate of raw) {
    if (limit !== undefined && processed >= limit) break;
    processed += 1;

    const chain = chainById(cfg, candidate.chainId);
    if (!chain) {
      console.warn('Unknown chain', candidate.chainId);
      continue;
    }
    const client = (() => {
      const cached = clients.get(chain.id);
      if (cached) return cached;
      const next = createPublicClient({ transport: http(chain.rpc) });
      clients.set(chain.id, next);
      return next;
    })();

    const debtToken = chain.tokens[candidate.debt.symbol];
    const collateralToken = chain.tokens[candidate.collateral.symbol];
    if (!debtToken || !collateralToken) {
      console.warn('Missing token metadata for candidate', candidate);
      continue;
    }

    const policy = cfg.assets[candidate.debt.symbol];
    if (!policy) {
      console.warn('Missing policy for asset', candidate.debt.symbol);
      continue;
    }

    const market = cfg.markets.find(
      (m) =>
        m.enabled &&
        m.chainId === candidate.chainId &&
        m.debtAsset === candidate.debt.symbol &&
        m.collateralAsset === candidate.collateral.symbol
    );
    if (!market) {
      console.warn('No enabled market for candidate', candidate);
      continue;
    }

    const debtPriceUsd = (await oraclePriceUsd(client, debtToken)) ?? 1;
    const collPriceUsd = (await oraclePriceUsd(client, collateralToken)) ?? debtPriceUsd;
    const { options } = buildRouteOptions(cfg, chain, candidate.debt.symbol, candidate.collateral.symbol);

    const plan = await simulate({
      client,
      chain,
      debt: { ...debtToken, symbol: candidate.debt.symbol, amount: toBigInt(candidate.debt.amount) },
      collateral: { ...collateralToken, symbol: candidate.collateral.symbol, amount: toBigInt(candidate.collateral.amount) },
      closeFactor: (market.closeFactorBps ?? 5000) / 10_000,
      bonusBps: market.bonusBps ?? 800,
      routes: options,
      pricesUsd: { debt: debtPriceUsd, coll: collPriceUsd },
      policy,
      gasCapUsd: cfg.risk.gasCapUsd,
    });

    ready += 1;
    if (!plan) continue;
    viable += 1;
    console.log(
      JSON.stringify(
        {
          borrower: candidate.borrower,
          chainId: candidate.chainId,
          repay: plan.repayAmount.toString(),
          netBps: Number(plan.estNetBps.toFixed(2)),
          router: plan.router,
          dex: plan.dexId,
        },
        null,
        2
      )
    );
  }

  console.log('\nReplay summary');
  console.log({ processed, ready, viable });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
