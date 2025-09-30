import type { Address } from 'viem';
import { AppConfig, ChainCfg } from '../infra/config';
import { RouteOption } from '../simulator/router';

const DEFAULT_UNI_FEES = [100, 500, 3000, 10000];

type RouteBuildResult = {
  options: RouteOption[];
  gapFee: number;
  gapRouter?: Address;
};

export function buildRouteOptions(
  cfg: AppConfig,
  chain: ChainCfg,
  _debtSymbol: string,
  _collateralSymbol: string
): RouteBuildResult {
  const options: RouteOption[] = [];
  const chainDex = cfg.dexRouters?.[chain.id];

  if (!chainDex) {
    // Fallback to default UniV3 if no dexRouters are configured for the chain
    const uniRouter = chain.uniV3Router as Address | undefined;
    if (uniRouter) {
      for (const fee of DEFAULT_UNI_FEES) {
        options.push({ type: 'UniV3', router: uniRouter, fee });
      }
    }
    return { options, gapFee: DEFAULT_UNI_FEES[1], gapRouter: uniRouter };
  }

  // Uniswap V3
  const uniV3Router = (chainDex.uniV3 ?? chain.uniV3Router) as Address | undefined;
  if (uniV3Router) {
    for (const fee of DEFAULT_UNI_FEES) {
      options.push({ type: 'UniV3', router: uniV3Router, fee });
    }
  }

  // Camelot (Uniswap V2 fork)
  if (chainDex.camelotV2) {
    options.push({ type: 'UniV2', router: chainDex.camelotV2 as Address });
  }

  // Velodrome (Solidly V2 fork)
  if (chainDex.velodrome && chainDex.velodromeFactory) {
    options.push({
      type: 'SolidlyV2',
      router: chainDex.velodrome as Address,
      factory: chainDex.velodromeFactory as Address,
      stable: true,
    });
    options.push({
      type: 'SolidlyV2',
      router: chainDex.velodrome as Address,
      factory: chainDex.velodromeFactory as Address,
      stable: false,
    });
  }

  // Aerodrome (Solidly V2 fork)
  if (chainDex.aerodrome && chainDex.aerodromeFactory) {
    options.push({
      type: 'SolidlyV2',
      router: chainDex.aerodrome as Address,
      factory: chainDex.aerodromeFactory as Address,
      stable: true,
    });
    options.push({
      type: 'SolidlyV2',
      router: chainDex.aerodrome as Address,
      factory: chainDex.aerodromeFactory as Address,
      stable: false,
    });
  }
  
  // Determine a sensible default for price gap checking
  const gapRouter = uniV3Router ?? (chainDex.camelotV2 as Address) ?? (chainDex.velodrome as Address);
  const gapFee = DEFAULT_UNI_FEES[1]; // 500 bps is a common default

  return { options, gapFee, gapRouter };
}