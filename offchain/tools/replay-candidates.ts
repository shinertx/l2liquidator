#!/usr/bin/env ts-node
import fs from 'fs';
import path from 'path';
import { createPublicClient, http } from 'viem';
import { loadConfig, chainById, liquidatorForChain } from '../infra/config';
import { executorAddressForChain } from '../infra/accounts';
import { oraclePriceUsd } from '../indexer/price_watcher';
import { simulate } from '../simulator/simulate';
import { buildRouteOptions } from '../util/routes';
import { lookupAssetPolicy, lookupToken, symbolsEqual } from '../util/symbols';

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

  const debtTokenEntry = lookupToken(chain.tokens, candidate.debt.symbol, candidate.debt.address);
  const collateralTokenEntry = lookupToken(chain.tokens, candidate.collateral.symbol, candidate.collateral.address);
    if (!debtTokenEntry || !collateralTokenEntry) {
      console.warn('Missing token metadata for candidate', candidate);
      continue;
    }
    const { value: debtToken, key: debtTokenSymbol } = debtTokenEntry;
    const { value: collateralToken, key: collateralTokenSymbol } = collateralTokenEntry;

    const policyEntry = lookupAssetPolicy(cfg.assets, candidate.debt.symbol);
    if (!policyEntry) {
      console.warn('Missing policy for asset', candidate.debt.symbol);
      continue;
    }
    const policy = policyEntry.value;

    const market = cfg.markets.find(
      (m) =>
        m.enabled &&
        m.chainId === candidate.chainId &&
        symbolsEqual(m.debtAsset, candidate.debt.symbol) &&
        symbolsEqual(m.collateralAsset, candidate.collateral.symbol)
    );
    if (!market) {
      console.warn('No enabled market for candidate', candidate);
      continue;
    }

    const debtPriceUsd = (await oraclePriceUsd(client, debtToken, chain)) ?? 1;
    const collPriceUsd = (await oraclePriceUsd(client, collateralToken, chain)) ?? debtPriceUsd;
    const contract = liquidatorForChain(cfg, chain.id);
    if (!contract) {
      console.warn('Missing liquidator address for chain', chain.id);
      continue;
    }
    if (!cfg.beneficiary) {
      console.warn('Missing beneficiary in config; cannot simulate payout target');
      continue;
    }

    const executor = executorAddressForChain(chain);
    if (!executor) {
      console.warn('Missing executor address for chain', chain.id);
      continue;
    }

    const nativeToken = chain.tokens.WETH ?? chain.tokens.ETH ?? debtToken;
    let nativePriceUsd = debtPriceUsd;
    if (nativeToken) {
      const maybeNative = await oraclePriceUsd(client, nativeToken, chain);
      if (maybeNative && maybeNative > 0) {
        nativePriceUsd = maybeNative;
      }
    }

  const { options } = buildRouteOptions(cfg, chain, debtTokenSymbol, collateralTokenSymbol);

    const plan = await simulate({
      client,
      chain,
      contract,
      beneficiary: cfg.beneficiary,
      executor,
      borrower: candidate.borrower,
      debt: { ...debtToken, symbol: candidate.debt.symbol, amount: toBigInt(candidate.debt.amount) },
      collateral: { ...collateralToken, symbol: candidate.collateral.symbol, amount: toBigInt(candidate.collateral.amount) },
      closeFactor: (market.closeFactorBps ?? 5000) / 10_000,
      bonusBps: market.bonusBps ?? 800,
      routes: options,
      pricesUsd: { debt: debtPriceUsd, coll: collPriceUsd },
      policy,
      gasCapUsd: cfg.risk.gasCapUsd,
      nativePriceUsd,
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
