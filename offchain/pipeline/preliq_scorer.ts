import type { Address } from 'viem';
import type { Candidate } from '../indexer/aave_indexer';
import { getMarketLiquidity, calculateLiquidityScore } from '../tools/public_allocator_probe';
import { loadConfig, liquidatorForChain, type ChainCfg } from '../infra/config';
import { lookupAssetPolicy, lookupToken, symbolsEqual } from '../util/symbols';
import { buildRouteOptions } from '../util/routes';
import { oraclePriceUsd, dexPriceRatio } from '../indexer/price_watcher';
import { getPublicClient } from '../infra/rpc_clients';
import { executorAddressForChain } from '../infra/accounts';
import { simulate } from '../simulator/simulate';
import { log } from '../infra/logger';
import { getMorphoOracleRatio } from '../util/morpho_oracle';

// Configuration constants
const MIN_LIQUIDITY_SCORE = 50; // 0-100 scale
const MAX_ORACLE_DIVERGENCE_BPS = 200; // 2% max divergence
const MIN_INCENTIVE_BPS = 150; // 1.5% minimum incentive
const DEFAULT_MIN_NET_PROFIT_USD = 2.0; // Fallback profit floor if config missing

const DEFAULT_CLOSE_FACTOR_BPS = 5_000;
const DEFAULT_BONUS_BPS = 800;

type PreLiqCandidate = Candidate & {
  preliq: {
    offerAddress: Address;
    effectiveCloseFactor: number;
    effectiveLiquidationIncentive: number;
    oracleAddress: Address;
    expiry: bigint;
  };
};

type PreLiqScore = {
  accepted: boolean;
  reason: string;
  netProfitUsd?: number;
  liquidityScore?: number;
  oracleDivergenceBps?: number;
  effectiveIncentiveBps?: number;
  effectiveLiquidationIncentive?: number;
  gasUsd?: number;
};

const cfg = loadConfig();
const scorerLog = log.child({ module: 'pipeline.preliq_scorer' });

function normalizeChain(chainId: number): ChainCfg | null {
  const chain = cfg.chains.find((c) => c.id === chainId);
  if (!chain) return null;
  if (!chain.enabled) return null;
  return chain;
}

function calculateIncentiveBps(incentive: number): number {
  return Math.floor(incentive * 10_000);
}

function computeOracleDivergenceBps(referenceRatio: number | null, marketRatio: number | null): number | null {
  if (referenceRatio == null || referenceRatio <= 0 || marketRatio == null || marketRatio <= 0) {
    return null;
  }
  const diff = Math.abs(marketRatio - referenceRatio) / referenceRatio;
  return Math.round(diff * 10_000);
}

function resolveLiquidityScore(marketId: string, repayAmount: bigint): number | undefined {
  const snapshot = getMarketLiquidity(marketId);
  if (!snapshot) return undefined;
  return calculateLiquidityScore(marketId, repayAmount);
}

function resolveMinNetUsd(chain: ChainCfg): number {
  return chain.risk?.minNetUsd ?? cfg.risk.minNetUsd ?? DEFAULT_MIN_NET_PROFIT_USD;
}

function resolveGasCapUsd(chain: ChainCfg): number {
  return chain.risk?.gasCapUsd ?? cfg.risk.gasCapUsd ?? 10;
}

export async function scorePreLiq(
  candidate: PreLiqCandidate,
  chainId: number,
  marketId: string
): Promise<PreLiqScore> {
  const chain = normalizeChain(chainId);
  if (!chain) {
    return { accepted: false, reason: `chain-disabled:${chainId}` };
  }

  if (!candidate.preliq) {
    return { accepted: false, reason: 'preliq-offer-missing' };
  }

  // 1. Health factor range check (1.0 < HF < 1.05)
  const hf = candidate.healthFactor ?? 0;
  if (hf <= 1.0) {
    return {
      accepted: false,
      reason: `health-factor-too-low: ${hf.toFixed(4)} (should be > 1.0 for pre-liq)`,
    };
  }
  if (hf >= 1.05) {
    return {
      accepted: false,
      reason: `health-factor-too-high: ${hf.toFixed(4)} (should be < 1.05 for pre-liq)`,
    };
  }

  // 2. Offer expiry check
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (candidate.preliq.expiry <= now) {
    return {
      accepted: false,
      reason: `offer-expired: expiry ${candidate.preliq.expiry} <= now ${now}`,
    };
  }

  // 3. Incentive threshold check
  const effectiveIncentiveBps = calculateIncentiveBps(candidate.preliq.effectiveLiquidationIncentive);
  if (effectiveIncentiveBps < MIN_INCENTIVE_BPS) {
    return {
      accepted: false,
      reason: `incentive-too-low: ${effectiveIncentiveBps} bps < ${MIN_INCENTIVE_BPS} bps`,
      effectiveIncentiveBps,
    };
  }

  const debtTokenEntry = lookupToken(chain.tokens, candidate.debt.symbol, candidate.debt.address);
  const collateralTokenEntry = lookupToken(chain.tokens, candidate.collateral.symbol, candidate.collateral.address);
  if (!debtTokenEntry || !collateralTokenEntry) {
    return {
      accepted: false,
      reason: 'token-metadata-missing',
    };
  }

  const policyEntry = lookupAssetPolicy(cfg.assets, candidate.debt.symbol);
  if (!policyEntry) {
    return { accepted: false, reason: `policy-missing:${candidate.debt.symbol}` };
  }
  const policy = policyEntry.value;

  const market = cfg.markets.find(
    (m) =>
      m.enabled &&
      m.chainId === chain.id &&
      symbolsEqual(m.debtAsset, candidate.debt.symbol) &&
      symbolsEqual(m.collateralAsset, candidate.collateral.symbol) &&
      m.protocol === candidate.protocol
  );
  if (!market) {
    return { accepted: false, reason: 'market-disabled' };
  }

  const contract = liquidatorForChain(cfg, chain.id);
  const beneficiary = cfg.beneficiary;
  const executor = executorAddressForChain(chain);

  if (!contract) {
    return { accepted: false, reason: 'missing-liquidator-address' };
  }
  if (!beneficiary) {
    return { accepted: false, reason: 'missing-beneficiary' };
  }
  if (!executor) {
    return { accepted: false, reason: 'missing-executor' };
  }

  const client = getPublicClient(chain);

  let debtPriceUsd = await oraclePriceUsd(client, debtTokenEntry.value, chain);
  let collPriceUsd = await oraclePriceUsd(client, collateralTokenEntry.value, chain);

  const oracleRatio = await getMorphoOracleRatio(client, candidate.preliq.oracleAddress);

  if (oracleRatio && Number.isFinite(oracleRatio) && oracleRatio > 0) {
    if ((collPriceUsd == null || collPriceUsd <= 0) && debtPriceUsd && debtPriceUsd > 0) {
      collPriceUsd = debtPriceUsd * oracleRatio;
      scorerLog.debug({ borrower: candidate.borrower, ratio: oracleRatio, inferred: collPriceUsd }, 'preliq-collateral-price-inferred');
    } else if ((debtPriceUsd == null || debtPriceUsd <= 0) && collPriceUsd && collPriceUsd > 0) {
      debtPriceUsd = collPriceUsd / oracleRatio;
      scorerLog.debug({ borrower: candidate.borrower, ratio: oracleRatio, inferred: debtPriceUsd }, 'preliq-debt-price-inferred');
    }
  }

  if (debtPriceUsd == null || collPriceUsd == null) {
    const { options: routeOptions } = buildRouteOptions(cfg, chain, debtTokenEntry.key, collateralTokenEntry.key);
    if (routeOptions.length > 0) {
      try {
        const ratio = await dexPriceRatio({ client, chain, collateral: collateralTokenEntry.value, debt: debtTokenEntry.value, routeOptions });
        if (ratio && Number.isFinite(ratio) && ratio > 0) {
          if (collPriceUsd == null && debtPriceUsd && debtPriceUsd > 0) {
            collPriceUsd = debtPriceUsd * ratio;
            scorerLog.debug({ borrower: candidate.borrower, ratio, inferred: collPriceUsd }, 'preliq-collateral-price-dex');
          } else if (debtPriceUsd == null && collPriceUsd && collPriceUsd > 0) {
            debtPriceUsd = collPriceUsd / ratio;
            scorerLog.debug({ borrower: candidate.borrower, ratio, inferred: debtPriceUsd }, 'preliq-debt-price-dex');
          }
        }
      } catch (err) {
        scorerLog.debug({ borrower: candidate.borrower, err: (err as Error).message }, 'preliq-dex-fallback-failed');
      }
    }
  }

  if (debtPriceUsd == null || debtPriceUsd <= 0 || collPriceUsd == null || collPriceUsd <= 0) {
    return { accepted: false, reason: 'price-missing' };
  }

  const { options: routeOptions } = buildRouteOptions(cfg, chain, debtTokenEntry.key, collateralTokenEntry.key);
  if (routeOptions.length === 0) {
    return { accepted: false, reason: 'routing-unavailable' };
  }

  const nativeToken = chain.tokens.WETH ?? chain.tokens.ETH ?? debtTokenEntry.value;
  let nativePriceUsd = debtPriceUsd;
  if (nativeToken?.chainlinkFeed) {
    const nativePrice = await oraclePriceUsd(client, nativeToken, chain);
    if (nativePrice && nativePrice > 0) {
      nativePriceUsd = nativePrice;
    }
  }

  const closeFactor = (market.closeFactorBps ?? DEFAULT_CLOSE_FACTOR_BPS) / 10_000;
  const bonusBps = market.bonusBps ?? DEFAULT_BONUS_BPS;

  const simPlan = await simulate({
    client,
    chain,
    contract: contract as Address,
    beneficiary,
    executor,
    borrower: candidate.borrower,
    debt: { ...debtTokenEntry.value, symbol: candidate.debt.symbol, amount: candidate.debt.amount },
    collateral: { ...collateralTokenEntry.value, symbol: candidate.collateral.symbol, amount: candidate.collateral.amount },
    closeFactor,
    bonusBps,
    routes: routeOptions,
    pricesUsd: { debt: debtPriceUsd, coll: collPriceUsd },
    policy: {
      floorBps: policy.floorBps ?? 0,
      gapCapBps: policy.gapCapBps ?? 100,
      slippageBps: policy.slippageBps ?? 100,
    },
    gasCapUsd: resolveGasCapUsd(chain),
    maxRepayUsd: chain.risk?.maxRepayUsd ?? cfg.risk.maxRepayUsd,
    nativePriceUsd,
    protocol: candidate.protocol,
    morpho: candidate.morpho
      ? {
          borrowShares: candidate.morpho.borrowShares,
          market: {
            loanToken: candidate.morpho.marketParams.loanToken,
            collateralToken: candidate.morpho.marketParams.collateralToken,
            oracle: candidate.morpho.marketParams.oracle,
            irm: candidate.morpho.marketParams.irm,
            lltv: candidate.morpho.marketParams.lltv,
          },
        }
      : undefined,
    preliq: candidate.preliq,
  });

  if (!simPlan) {
    return { accepted: false, reason: 'plan-null' };
  }

  const netProfitUsd = simPlan.netUsd;
  const gasUsd = simPlan.gasUsd;

  const minNetUsd = resolveMinNetUsd(chain);
  if (netProfitUsd < minNetUsd) {
    return {
      accepted: false,
      reason: `profit-too-low: ${netProfitUsd.toFixed(2)} < ${minNetUsd.toFixed(2)}`,
      netProfitUsd,
      gasUsd,
      effectiveIncentiveBps,
    };
  }

  if (gasUsd > resolveGasCapUsd(chain)) {
    return {
      accepted: false,
      reason: `gas-cost-too-high: ${gasUsd.toFixed(2)}`,
      netProfitUsd,
      gasUsd,
      effectiveIncentiveBps,
    };
  }

  const liquidityScore = resolveLiquidityScore(marketId, simPlan.repayAmount ?? candidate.debt.amount);
  if (liquidityScore !== undefined && liquidityScore < MIN_LIQUIDITY_SCORE) {
    return {
      accepted: false,
      reason: `liquidity-score-too-low: ${liquidityScore} < ${MIN_LIQUIDITY_SCORE}`,
      liquidityScore,
      netProfitUsd,
      gasUsd,
      effectiveIncentiveBps,
    };
  }

  const marketRatio = collPriceUsd / debtPriceUsd;
  const oracleDivergenceBps = computeOracleDivergenceBps(oracleRatio, marketRatio) ?? 0;
  if (oracleDivergenceBps > MAX_ORACLE_DIVERGENCE_BPS) {
    return {
      accepted: false,
      reason: `oracle-divergence-too-high: ${oracleDivergenceBps} bps > ${MAX_ORACLE_DIVERGENCE_BPS} bps`,
      oracleDivergenceBps,
      netProfitUsd,
      gasUsd,
      effectiveIncentiveBps,
    };
  }

  return {
    accepted: true,
    reason: 'profitable-pre-liquidation',
    netProfitUsd,
    gasUsd,
    liquidityScore,
    oracleDivergenceBps,
    effectiveIncentiveBps,
    effectiveLiquidationIncentive: candidate.preliq.effectiveLiquidationIncentive,
  };
}
