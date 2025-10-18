#!/usr/bin/env ts-node
import '../infra/env';
import { createPublicClient, http, BaseError, ContractFunctionRevertedError } from 'viem';
import { loadConfig, chainById, liquidatorForChain } from '../infra/config';
import { executorAddressForChain } from '../infra/accounts';
import { oraclePriceUsd } from '../indexer/price_watcher';
import { simulate, PlanRejectedError } from '../simulator/simulate';
import { buildRouteOptions } from '../util/routes';
import { lookupAssetPolicy, lookupToken, symbolsEqual } from '../util/symbols';
import { db, waitForDb } from '../infra/db';

async function main() {
  const idRaw = process.argv[2];
  if (!idRaw) {
    console.error('Usage: ts-node simulate_attempt.ts <attempt_id>');
    process.exit(1);
  }
  const id = Number(idRaw);
  if (!Number.isFinite(id)) {
    console.error('Invalid id');
    process.exit(1);
  }

  const cfg = loadConfig();
  await waitForDb();
  const res = await db.query(
    `SELECT chain_id, borrower, details
     FROM liquidation_attempts WHERE id = $1`,
    [id]
  );
  if (res.rows.length === 0) {
    console.error('Attempt not found:', id);
    process.exit(1);
  }
  const row = res.rows[0];
  const chain = chainById(cfg, row.chain_id);
  if (!chain) throw new Error('Unknown chain ' + row.chain_id);

  const details = row.details ?? {};
  const cand = details.candidate;
  if (!cand) throw new Error('No candidate snapshot in details');

  const debtSymbol = cand.debt?.symbol as string;
  const collSymbol = cand.collateral?.symbol as string;
  const debtAddr = (cand.debt?.address as string)?.toLowerCase();
  const collAddr = (cand.collateral?.address as string)?.toLowerCase();
  const debtAmt = BigInt(cand.debt?.amount ?? '0');
  const collAmt = BigInt(cand.collateral?.amount ?? '0');

  const debtEntry = lookupToken(chain.tokens, debtSymbol, debtAddr as `0x${string}`);
  const collEntry = lookupToken(chain.tokens, collSymbol, collAddr as `0x${string}`);
  if (!debtEntry || !collEntry) throw new Error('Missing token metadata');

  const policyEntry = lookupAssetPolicy(cfg.assets, debtSymbol);
  if (!policyEntry) throw new Error('Missing policy for ' + debtSymbol);
  const policy = policyEntry.value;

  const market = cfg.markets.find(
    (m) =>
      m.enabled &&
      m.chainId === chain.id &&
      symbolsEqual(m.debtAsset, debtSymbol) &&
      symbolsEqual(m.collateralAsset, collSymbol)
  );
  if (!market) throw new Error('No enabled market for ' + debtSymbol + '-' + collSymbol);

  const client = createPublicClient({ transport: http(chain.rpc) });
  const debtToken = { ...debtEntry.value, symbol: debtSymbol, amount: debtAmt };
  const collToken = { ...collEntry.value, symbol: collSymbol, amount: collAmt };

  const debtPriceUsd = (await oraclePriceUsd(client, debtEntry.value, chain)) ?? 0;
  const collPriceUsd = (await oraclePriceUsd(client, collEntry.value, chain)) ?? 0;

  const { options } = buildRouteOptions(cfg, chain, debtEntry.key, collEntry.key);
  const contract = liquidatorForChain(cfg, chain.id);
  const executor = executorAddressForChain(chain);
  const beneficiary = cfg.beneficiary;
  if (!contract || !executor || !beneficiary) throw new Error('Missing contract/executor/beneficiary');

  console.log('Re-simulating attempt', id, {
    chain: chain.name,
    borrower: row.borrower,
    debt: { symbol: debtSymbol, amount: debtAmt.toString() },
    collateral: { symbol: collSymbol, amount: collAmt.toString() },
    prices: { debtPriceUsd, collPriceUsd },
  });

  try {
    const plan = await simulate({
      client,
      chain,
      contract,
      beneficiary,
      executor,
      borrower: row.borrower,
      debt: debtToken,
      collateral: collToken,
      closeFactor: (market.closeFactorBps ?? 5000) / 10_000,
      bonusBps: market.bonusBps ?? 800,
      routes: options,
      pricesUsd: { debt: debtPriceUsd, coll: collPriceUsd },
      policy,
      gasCapUsd: cfg.risk.gasCapUsd,
      maxRepayUsd: cfg.risk.maxRepayUsd,
      nativePriceUsd: debtPriceUsd,
    });
    console.log('simulate result:', plan);
  } catch (err) {
    if (err instanceof PlanRejectedError) {
      console.error('simulate plan-rejected', {
        code: err.code,
        message: err.message,
        detail: err.detail,
      });
      process.exit(2);
    }
    if (err instanceof BaseError) {
      const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError) {
        const data = revert.data as any;
        console.error('simulate revert', {
          reason: revert.message,
          short: revert.shortMessage,
          errorName: data?.errorName,
          signature: data && 'signature' in data ? data.signature : undefined,
          raw: typeof data === 'object' && data ? data.data ?? data : data,
        });
        process.exit(2);
      }
      console.error('simulate base error', err.shortMessage);
      process.exit(3);
    } else {
      console.error('simulate error', (err as Error).message);
      process.exit(4);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
