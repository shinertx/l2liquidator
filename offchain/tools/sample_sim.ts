import '../infra/env';
import { createPublicClient, http, BaseError, ContractFunctionRevertedError } from 'viem';
import type { Address, Chain, PublicClient, Transport } from 'viem';
import { loadConfig, chainById, liquidatorForChain } from '../infra/config';
import type { ChainCfg, AssetPolicy } from '../infra/config';
import { streamCandidates } from '../indexer/aave_indexer';
import type { Candidate } from '../indexer/aave_indexer';
import { executorAddressForChain } from '../infra/accounts';
import { oraclePriceUsd } from '../indexer/price_watcher';
import { simulate } from '../simulator/simulate';
import { buildRouteOptions } from '../util/routes';
import { lookupAssetPolicy, lookupToken, symbolsEqual } from '../util/symbols';
import { bestRoute } from '../simulator/router';

type RpcClient = PublicClient<Transport, Chain | undefined, any>;

async function main() {
  const cfg = loadConfig();
  const candidates = streamCandidates(cfg);
  let count = 0;
  let attempts = 0;
  const maxAttempts = Number.parseInt(process.env.SAMPLE_SIM_MAX_ATTEMPTS ?? '5', 10);

  for await (const candidate of candidates) {
    count += 1;
    const chain = chainById(cfg, candidate.chainId);
    if (!chain) {
      console.warn('Unknown chain', candidate.chainId);
      continue;
    }
    const debtTokenEntry = lookupToken(chain.tokens, candidate.debt.symbol, candidate.debt.address);
    const collateralTokenEntry = lookupToken(chain.tokens, candidate.collateral.symbol, candidate.collateral.address);
    if (!debtTokenEntry || !collateralTokenEntry) {
      console.warn('Missing token metadata', candidate);
      continue;
    }
    const policyEntry = lookupAssetPolicy(cfg.assets, candidate.debt.symbol);
    if (!policyEntry) {
      console.warn('Missing policy for', candidate.debt.symbol);
      continue;
    }
    const market = cfg.markets.find(
      (m) =>
        m.enabled &&
        m.chainId === candidate.chainId &&
        symbolsEqual(m.debtAsset, candidate.debt.symbol) &&
        symbolsEqual(m.collateralAsset, candidate.collateral.symbol)
    );
    if (!market) {
      console.warn('No enabled market', candidate);
      continue;
    }

    const client = createPublicClient({ transport: http(chain.rpc) });
    const debtToken = { ...debtTokenEntry.value, symbol: candidate.debt.symbol, amount: candidate.debt.amount };
    const collateralToken = { ...collateralTokenEntry.value, symbol: candidate.collateral.symbol, amount: candidate.collateral.amount };
    const policy = policyEntry.value;

    const debtPriceUsd = (await oraclePriceUsd(client, debtTokenEntry.value, chain)) ?? 0;
    const collPriceUsd = (await oraclePriceUsd(client, collateralTokenEntry.value, chain)) ?? 0;

    const nativeToken = chain.tokens.WETH ?? chain.tokens.ETH ?? debtTokenEntry.value;
    let nativePriceUsd = debtPriceUsd;
    if (nativeToken) {
      const maybe = await oraclePriceUsd(client, nativeToken, chain);
      if (maybe && maybe > 0) nativePriceUsd = maybe;
    }

    const { options } = buildRouteOptions(cfg, chain, debtTokenEntry.key, collateralTokenEntry.key);
    const contract = liquidatorForChain(cfg, chain.id);
    const executor = executorAddressForChain(chain);
    const beneficiary = cfg.beneficiary;
    if (!contract || !executor || !beneficiary) {
      console.warn('Missing contract/executor/beneficiary', { contract, executor, beneficiary });
      continue;
    }

    attempts += 1;
    console.log('Candidate', count, {
      borrower: candidate.borrower,
      chain: chain.name,
      debt: { symbol: candidate.debt.symbol, amount: candidate.debt.amount.toString() },
      collateral: { symbol: candidate.collateral.symbol, amount: candidate.collateral.amount.toString() },
      debtPriceUsd,
      collPriceUsd,
    });

    try {
      const plan = await simulate({
        client,
        chain,
  contract,
  beneficiary,
        executor,
        borrower: candidate.borrower,
  debt: { ...debtToken, amount: candidate.debt.amount as bigint },
  collateral: { ...collateralToken, amount: candidate.collateral.amount as bigint },
        closeFactor: (market.closeFactorBps ?? 5000) / 10_000,
        bonusBps: market.bonusBps ?? 800,
        routes: options,
        pricesUsd: { debt: debtPriceUsd, coll: collPriceUsd },
        policy,
        gasCapUsd: cfg.risk.gasCapUsd,
        maxRepayUsd: process.env.SAMPLE_SIM_MAX_REPAY ? Number(process.env.SAMPLE_SIM_MAX_REPAY) : cfg.risk.maxRepayUsd,
        nativePriceUsd,
      });

      console.log('plan', plan);
    } catch (err) {
      const maxRepayUsd = process.env.SAMPLE_SIM_MAX_REPAY ? Number(process.env.SAMPLE_SIM_MAX_REPAY) : cfg.risk.maxRepayUsd;
      const debugPlan = await tryBuildPlan({
        chain,
        client,
        debtToken,
        collateralToken,
        debtPriceUsd,
        collPriceUsd,
        candidate,
        policy,
        routes: options,
        closeFactorBps: market.closeFactorBps ?? 5000,
        bonusBps: market.bonusBps ?? 800,
        maxRepayUsd,
      });
      if (err instanceof BaseError) {
        const revert = err.walk((error) => error instanceof ContractFunctionRevertedError);
        if (revert instanceof ContractFunctionRevertedError) {
          const data = revert.data as any;
          console.error('simulate revert', {
            reason: revert.message,
            short: revert.shortMessage,
            errorName: data?.errorName,
            signature: data && 'signature' in data ? data.signature : undefined,
            raw: typeof data === 'object' && data ? data.data ?? data : data,
            revertReason: revert.reason,
            planArgs: debugPlan?.planArgs,
            economics: debugPlan?.economics,
          });
        } else {
          console.error('simulate base error', err.shortMessage);
        }
      } else {
        console.error('simulate error', (err as Error).message);
      }
    }

    if (attempts >= maxAttempts) break;
  }
}

type BuildPlanInput = {
  chain: ChainCfg;
  client: RpcClient;
  debtToken: TokenPosition;
  collateralToken: TokenPosition;
  debtPriceUsd: number;
  collPriceUsd: number;
  candidate: Candidate;
  policy: AssetPolicy;
  routes: ReturnType<typeof buildRouteOptions>['options'];
  closeFactorBps: number;
  bonusBps: number;
  maxRepayUsd?: number;
};

type TokenPosition = {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  amount: bigint;
  chainlinkFeed?: `0x${string}`;
};

async function tryBuildPlan(input: BuildPlanInput): Promise<{ planArgs: any; economics: any } | null> {
  const {
    chain,
    client,
    debtToken,
    collateralToken,
    debtPriceUsd,
    collPriceUsd,
    candidate,
    policy,
    routes,
    closeFactorBps,
    bonusBps,
    maxRepayUsd,
  } = input;

  if (debtPriceUsd <= 0 || collPriceUsd <= 0) return null;
  if (routes.length === 0) return null;

  const cfBps = Math.floor((closeFactorBps ?? 0) / 1);
  if (cfBps <= 0) return null;

  let repay = (candidate.debt.amount * BigInt(cfBps)) / 10_000n;
  if (repay === 0n) return null;

  const pow10 = 10n ** BigInt(debtToken.decimals);
  const repayTokens = Number(repay) / Number(pow10);
  let repayUsd = repayTokens * debtPriceUsd;

  if (maxRepayUsd && maxRepayUsd > 0 && repayUsd > maxRepayUsd) {
    const maxRepayTokens = maxRepayUsd / debtPriceUsd;
    const maxRepayAmount = BigInt(Math.floor(maxRepayTokens * Number(pow10)));
    if (maxRepayAmount <= 0n) return null;
    repay = maxRepayAmount < repay ? maxRepayAmount : repay;
    repayUsd = (Number(repay) / Number(pow10)) * debtPriceUsd;
  }

  const bonusFactor = 1 + bonusBps / 10_000;
  const seizeUsd = repayUsd * bonusFactor;
  const seizeTokens = seizeUsd / collPriceUsd;
  const collPow = 10n ** BigInt(collateralToken.decimals);
  const seizeAmount = BigInt(Math.floor(seizeTokens * Number(collPow)));
  if (seizeAmount === 0n) return null;

  const route = await bestRoute({
    client,
    chain,
    contract: liquidatorForChain(loadConfig(), chain.id) as Address,
    collateral: collateralToken,
    debt: debtToken,
    seizeAmount,
    slippageBps: policy.slippageBps,
    options: routes,
  });

  if (!route) return null;

  const repayAmount = repay;
  const minProfit = (repayAmount * BigInt(policy.floorBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const planArgs = {
    borrower: candidate.borrower,
    debtAsset: candidate.debt.address,
    collateralAsset: candidate.collateral.address,
    repayAmount,
    dexId: route.dexId,
    router: route.router,
    uniFee: route.uniFee ?? 0,
    solidlyStable: route.solidlyStable,
    solidlyFactory: route.solidlyFactory,
    minProfit,
    amountOutMin: route.amountOutMin,
    deadline,
    path: route.path ?? '0x',
  };

  const amountOutMinTokens = Number(route.amountOutMin) / Number(pow10);
  const proceedsUsd = amountOutMinTokens * debtPriceUsd;
  const netUsd = proceedsUsd - repayUsd;
  const estNetBps = repayUsd > 0 ? (netUsd / repayUsd) * 10_000 : 0;

  return {
    planArgs,
    economics: {
      repayUsd,
      proceedsUsd,
      minProfit: Number(minProfit) / Number(pow10) * debtPriceUsd,
      estNetBps,
      seizeAmount: seizeAmount.toString(),
      routeQuotedOut: route.quotedOut.toString(),
    },
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
