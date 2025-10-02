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
  debtSymbol: string,
  collateralSymbol: string
): RouteBuildResult {
  const options: RouteOption[] = [];
  const chainDex = cfg.dexRouters?.[chain.id];
  const debtToken = chain.tokens[debtSymbol];
  const collateralToken = chain.tokens[collateralSymbol];

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

  const stableSymbols = new Set(['USDC', 'USDT', 'DAI', 'LUSD', 'SUSD', 'USDC.E', 'USDBC']);
  const stableToken = chain.tokens.USDC || chain.tokens.USDbC || chain.tokens['USDC.e'];
  const stableSymbol = stableToken
    ? Object.entries(chain.tokens).find(([, info]) => info.address.toLowerCase() === stableToken.address.toLowerCase())?.[0] ?? 'USDC'
    : 'USDC';
  const wethToken = chain.tokens.WETH ?? chain.tokens.ETH;
  const wethSymbol = wethToken
    ? Object.entries(chain.tokens).find(([, info]) => info.address.toLowerCase() === wethToken.address.toLowerCase())?.[0] ?? 'WETH'
    : 'WETH';

  const multiHopCandidates: Array<{ path: Address[]; fees: number[] }> = [];
  const pickFee = (a: string, b: string) => (stableSymbols.has(a.toUpperCase()) && stableSymbols.has(b.toUpperCase()) ? 100 : 500);

  if (uniV3Router && debtToken && collateralToken) {
    if (stableToken && stableToken.address !== debtToken.address && stableToken.address !== collateralToken.address) {
      multiHopCandidates.push({
        path: [collateralToken.address as Address, stableToken.address as Address, debtToken.address as Address],
        fees: [pickFee(collateralSymbol, stableSymbol), pickFee(stableSymbol, debtSymbol)],
      });
    }
    if (wethToken && wethToken.address !== debtToken.address && wethToken.address !== collateralToken.address) {
      multiHopCandidates.push({
        path: [collateralToken.address as Address, wethToken.address as Address, debtToken.address as Address],
        fees: [pickFee(collateralSymbol, wethSymbol), pickFee(wethSymbol, debtSymbol)],
      });
    }
    for (const candidate of multiHopCandidates) {
      if (new Set(candidate.path.map((addr) => addr.toLowerCase())).size !== candidate.path.length) continue;
      options.push({ type: 'UniV3Multi', router: uniV3Router, path: candidate.path, fees: candidate.fees });
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
