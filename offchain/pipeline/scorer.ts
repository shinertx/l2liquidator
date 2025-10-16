import { performance } from 'perf_hooks';
import type { Address } from 'viem';
import { log } from '../infra/logger';
import type { AppConfig, ChainCfg } from '../infra/config';
import { lookupAssetPolicy, lookupToken, symbolsEqual } from '../util/symbols';
import { buildRouteOptions } from '../util/routes';
import { oracleDexGapBps, oraclePriceUsd, dexPriceRatio } from '../indexer/price_watcher';
import { AdaptiveThresholdsProvider } from '../infra/adaptive_thresholds_provider';
import { getPublicClient } from '../infra/rpc_clients';
import { executorAddressForChain, privateKeyForChain } from '../infra/accounts';
import { liquidatorForChain } from '../infra/config';
import { getProtocolAdapter } from '../protocols/registry';
import { serializeCandidate, serializePlan } from '../util/serialize';
import type { QueuedCandidate, ScoredPlan, ScoreRejection } from './types';

const DEFAULT_CLOSE_FACTOR_BPS = 5_000;
const DEFAULT_BONUS_BPS = 800;
const DEFAULT_MIN_NET_USD = Number(process.env.MIN_NET_USD ?? 1.5);
const DEFAULT_PNL_MULT_MIN = Number(process.env.PNL_MULT_MIN ?? 3.5);

export type ScoreOutcome = ScoredPlan | ScoreRejection;

export class Scorer {
  private readonly adaptive: AdaptiveThresholdsProvider;
  private readonly scorerLog = log.child({ module: 'pipeline.scorer' });

  constructor(private readonly cfg: AppConfig) {
    this.adaptive = new AdaptiveThresholdsProvider(process.env.RISK_ENGINE_URL);
  }

  async score(item: QueuedCandidate): Promise<ScoreOutcome> {
    const { candidate, chain } = item;
    const protocolKey = (candidate as any).protocol ?? 'aavev3';

    const adapter = (() => {
      try {
        return getProtocolAdapter(protocolKey);
      } catch (err) {
        return null;
      }
    })();

    if (!adapter) {
      return { candidate, chain, reason: 'protocol-adapter-missing', detail: protocolKey };
    }

    if (!chain.enabled) {
      return { candidate, chain, reason: 'chain-disabled' };
    }

    const policyEntry = lookupAssetPolicy(this.cfg.assets, candidate.debt.symbol);
    if (!policyEntry) {
      return { candidate, chain, reason: 'policy-missing', detail: candidate.debt.symbol };
    }
    const policy = policyEntry.value;

    const denyAssets = new Set(this.cfg.risk.denyAssets ?? []);
    if (denyAssets.has(candidate.debt.symbol) || denyAssets.has(candidate.collateral.symbol)) {
      return { candidate, chain, reason: 'asset-denylist' };
    }

    const chainRisk = chain.risk ?? {};
    const baseHfMax = chainRisk.healthFactorMax ?? this.cfg.risk.healthFactorMax ?? 0.99;

    const debtTokenEntry = lookupToken(chain.tokens, candidate.debt.symbol, candidate.debt.address);
    const collateralTokenEntry = lookupToken(chain.tokens, candidate.collateral.symbol, candidate.collateral.address);
    if (!debtTokenEntry || !collateralTokenEntry) {
      return { candidate, chain, reason: 'token-metadata-missing' };
    }
    const debtToken = debtTokenEntry.value;
    const collateralToken = collateralTokenEntry.value;

    const market = this.cfg.markets.find(
      (m) =>
        m.enabled &&
        m.chainId === chain.id &&
        symbolsEqual(m.debtAsset, candidate.debt.symbol) &&
        symbolsEqual(m.collateralAsset, candidate.collateral.symbol) &&
        m.protocol === protocolKey
    );
    if (!market) {
      return { candidate, chain, reason: 'market-disabled' };
    }

    const contract = liquidatorForChain(this.cfg, chain.id);
    if (!contract) {
      return { candidate, chain, reason: 'missing-liquidator-address' };
    }

    if (!this.cfg.beneficiary) {
      return { candidate, chain, reason: 'missing-beneficiary' };
    }

    const executor = executorAddressForChain(chain);
    const pk = privateKeyForChain(chain);
    if (!executor || !pk) {
      return { candidate, chain, reason: 'missing-executor-or-pk' };
    }

    const client = getPublicClient(chain);

    let debtPriceUsd = await oraclePriceUsd(client, debtToken);
    let collPriceUsd = await oraclePriceUsd(client, collateralToken);
    if (debtPriceUsd == null || collPriceUsd == null) {
      const { options: routeOptions, gapFee, gapRouter } = buildRouteOptions(
        this.cfg,
        chain,
        debtTokenEntry.key,
        collateralTokenEntry.key,
      );
      if (routeOptions.length > 0) {
        try {
          const ratio = await dexPriceRatio({ client, chain, collateral: collateralToken, debt: debtToken, fee: gapFee, router: gapRouter });
          if (ratio && Number.isFinite(ratio) && ratio > 0) {
            if (collPriceUsd == null && debtPriceUsd != null && debtPriceUsd > 0) {
              collPriceUsd = debtPriceUsd * ratio;
              this.scorerLog.debug({ borrower: candidate.borrower, debt: candidate.debt.symbol, collateral: candidate.collateral.symbol, ratio, inferred: collPriceUsd }, 'price-fallback-dex-collateral');
            } else if (debtPriceUsd == null && collPriceUsd != null && collPriceUsd > 0) {
              debtPriceUsd = collPriceUsd / ratio;
              this.scorerLog.debug({ borrower: candidate.borrower, debt: candidate.debt.symbol, collateral: candidate.collateral.symbol, ratio, inferred: debtPriceUsd }, 'price-fallback-dex-debt');
            }
          }
        } catch (e) {
          this.scorerLog.debug({ borrower: candidate.borrower, err: (e as Error).message }, 'price-fallback-dex-failed');
        }
      }
    }
    if (debtPriceUsd == null || debtPriceUsd <= 0 || collPriceUsd == null || collPriceUsd <= 0) {
      return { candidate, chain, reason: 'price-missing' };
    }

    const nativeToken = chain.tokens.WETH ?? chain.tokens.ETH ?? debtToken;
    let nativePriceUsd = debtPriceUsd;
    if (nativeToken?.chainlinkFeed) {
      const nativePrice = await oraclePriceUsd(client, nativeToken);
      if (nativePrice && nativePrice > 0) {
        nativePriceUsd = nativePrice;
      }
    }

    const { options: routeOptions, gapFee, gapRouter } = buildRouteOptions(
      this.cfg,
      chain,
      debtTokenEntry.key,
      collateralTokenEntry.key,
    );
    if (routeOptions.length === 0) {
      return { candidate, chain, reason: 'routing-unavailable' };
    }

    const gapBps = await oracleDexGapBps({
      client,
      chain,
      collateral: collateralToken,
      debt: debtToken,
      fee: gapFee,
      router: gapRouter,
    });
    const baseGapCapBps = policy.gapCapBps ?? 100;

    const adaptive = await this.adaptive.update({
      chainId: chain.id,
      chainName: chain.name,
      assetKey: `${debtTokenEntry.key}-${collateralTokenEntry.key}`,
      baseHealthFactorMax: baseHfMax,
      baseGapCapBps,
      observedGapBps: gapBps,
    });
    const candidateSnapshot = serializeCandidate({
      candidate,
      debtToken,
      collateralToken,
      debtPriceUsd,
      collateralPriceUsd: collPriceUsd,
      gapBps,
      routeOptions,
      adaptive: {
        healthFactorMax: adaptive.healthFactorMax,
        gapCapBps: adaptive.gapCapBps,
        volatility: adaptive.volatility,
        baseHealthFactorMax: baseHfMax,
        baseGapCapBps,
      },
    });
    const effectiveHfMax = Math.min(baseHfMax, adaptive.healthFactorMax ?? baseHfMax);
    if (candidate.healthFactor !== undefined && Number.isFinite(candidate.healthFactor)) {
      if (candidate.healthFactor >= effectiveHfMax) {
        return {
          candidate,
          chain,
          reason: 'health-factor-above-max',
          detail: { healthFactor: candidate.healthFactor, hfMax: effectiveHfMax },
          snapshot: candidateSnapshot,
          adaptive: {
            healthFactorMax: adaptive.healthFactorMax,
            gapCapBps: adaptive.gapCapBps,
            volatility: adaptive.volatility,
            baseHealthFactorMax: baseHfMax,
            baseGapCapBps,
          },
          gapBps,
          debtPriceUsd,
          collateralPriceUsd: collPriceUsd,
          nativePriceUsd,
        };
      }
    }

    const effectiveGapCap = Math.min(baseGapCapBps, adaptive.gapCapBps ?? baseGapCapBps);
    if (gapBps > effectiveGapCap) {
      return {
        candidate,
        chain,
        reason: 'gap-exceeds-cap',
        detail: { gapBps, gapCap: effectiveGapCap },
        snapshot: candidateSnapshot,
        adaptive: {
          healthFactorMax: adaptive.healthFactorMax,
          gapCapBps: adaptive.gapCapBps,
          volatility: adaptive.volatility,
          baseHealthFactorMax: baseHfMax,
          baseGapCapBps,
        },
        gapBps,
        debtPriceUsd,
        collateralPriceUsd: collPriceUsd,
        nativePriceUsd,
      };
    }


    const closeFactor = (market.closeFactorBps ?? DEFAULT_CLOSE_FACTOR_BPS) / 10_000;
    const bonusBps = market.bonusBps ?? DEFAULT_BONUS_BPS;

    const simulateStart = performance.now();
    const plan = await adapter.simulate({
      client,
      chain,
      contract: contract as Address,
      beneficiary: this.cfg.beneficiary,
      executor,
      borrower: candidate.borrower,
      debt: { ...debtToken, symbol: candidate.debt.symbol, amount: candidate.debt.amount },
      collateral: { ...collateralToken, symbol: candidate.collateral.symbol, amount: candidate.collateral.amount },
      closeFactor,
      bonusBps,
      routes: routeOptions,
      pricesUsd: { debt: debtPriceUsd, coll: collPriceUsd },
      policy,
      gasCapUsd: chainRisk.gasCapUsd ?? this.cfg.risk.gasCapUsd,
      maxRepayUsd: chainRisk.maxRepayUsd ?? this.cfg.risk.maxRepayUsd,
      nativePriceUsd,
    }).catch((err) => {
      this.scorerLog.debug({ err, borrower: candidate.borrower, chain: chain.name }, 'simulate-failed');
      return null;
    });
    const simulateSeconds = (performance.now() - simulateStart) / 1000;
    if (!plan) {
      return {
        candidate,
        chain,
        reason: 'plan-null',
        detail: { simulateSeconds },
        snapshot: candidateSnapshot,
        adaptive: {
          healthFactorMax: adaptive.healthFactorMax,
          gapCapBps: adaptive.gapCapBps,
          volatility: adaptive.volatility,
          baseHealthFactorMax: baseHfMax,
          baseGapCapBps,
        },
        gapBps,
        debtPriceUsd,
        collateralPriceUsd: collPriceUsd,
        nativePriceUsd,
      };
    }

    const pnlPerGas = plan.gasUsd > 0 ? plan.netUsd / plan.gasUsd : Number.POSITIVE_INFINITY;
    const minNetUsd = chainRisk.minNetUsd ?? this.cfg.risk.minNetUsd ?? DEFAULT_MIN_NET_USD;
    if (plan.netUsd < minNetUsd) {
      return {
        candidate,
        chain,
        reason: 'net-below-min',
        detail: { net: plan.netUsd, minNetUsd },
        snapshot: candidateSnapshot,
        adaptive: {
          healthFactorMax: adaptive.healthFactorMax,
          gapCapBps: adaptive.gapCapBps,
          volatility: adaptive.volatility,
          baseHealthFactorMax: baseHfMax,
          baseGapCapBps,
        },
        gapBps,
        debtPriceUsd,
        collateralPriceUsd: collPriceUsd,
        nativePriceUsd,
      };
    }

    const pnlMultMin = chainRisk.pnlMultMin ?? this.cfg.risk.pnlMultMin ?? DEFAULT_PNL_MULT_MIN;
    if (plan.gasUsd > 0 && pnlPerGas < pnlMultMin) {
      return {
        candidate,
        chain,
        reason: 'pnl-mult-below-min',
        detail: { pnlPerGas, pnlMultMin },
        snapshot: candidateSnapshot,
        adaptive: {
          healthFactorMax: adaptive.healthFactorMax,
          gapCapBps: adaptive.gapCapBps,
          volatility: adaptive.volatility,
          baseHealthFactorMax: baseHfMax,
          baseGapCapBps,
        },
        gapBps,
        debtPriceUsd,
        collateralPriceUsd: collPriceUsd,
        nativePriceUsd,
      };
    }

    const metrics = {
      netUsd: plan.netUsd,
      gasUsd: plan.gasUsd,
      pnlPerGas,
      simulateSeconds,
    };

    const planWithPnl = { ...plan, pnlPerGas };
    const planSnapshot = serializePlan(planWithPnl);

    return {
      candidate,
      chain,
      plan: planWithPnl,
      metrics,
      snapshot: {
        candidate: candidateSnapshot,
        plan: planSnapshot,
      },
      adaptive: {
        healthFactorMax: adaptive.healthFactorMax,
        gapCapBps: adaptive.gapCapBps,
        volatility: adaptive.volatility,
        baseHealthFactorMax: baseHfMax,
        baseGapCapBps,
      },
      gapBps,
      debtPriceUsd,
      collateralPriceUsd: collPriceUsd,
      nativePriceUsd,
    };
  }
}
