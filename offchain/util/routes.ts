import type { Address } from 'viem';
import { getAddress } from 'viem';
import { AppConfig, ChainCfg } from '../infra/config';
import { RouteOption } from '../simulator/router';

const DEFAULT_UNI_FEES = [100, 500, 3000, 10000];

const STABLE_SYMBOLS = new Set([
  'USDC',
  'USDCN',
  'USDC.E',
  'USDCPLUS',
  'USDBC',
  'USDB',
  'USDT',
  'DAI',
  'LUSD',
  'SUSD',
  'USDE',
  'USDS',
  'USDL',
  'GHO',
  'FRAX',
  'MAI',
  'EURS',
  'EURC',
  'EUROC',
  'CUSD',
]);

const PEGGED_PAIR_KEYS = new Set([
  // ETH staking derivatives
  'ETH-WSTETH',
  'WETH-WSTETH',
  'WSTETH-WETH',
  'WETH-RETH',
  'RETH-WETH',
  'WETH-CBETH',
  'CBETH-WETH',
  'WETH-SFRXETH',
  'SFRXETH-WETH',
  // Polygon staking derivatives
  'WPOL-MATICX',
  'MATICX-WPOL',
  'WMATIC-MATICX',
  'MATICX-WMATIC',
]);

function normalizeSymbol(symbol?: string): string | null {
  if (!symbol) return null;
  return symbol.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function isStableSymbol(symbol?: string): boolean {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return false;
  if (STABLE_SYMBOLS.has(normalized)) return true;
  return /USD|EUR|DAI|FRAX|GHO|MAI/.test(normalized);
}

function isPeggedPair(a?: string, b?: string): boolean {
  const na = normalizeSymbol(a);
  const nb = normalizeSymbol(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const key = `${na}-${nb}`;
  if (PEGGED_PAIR_KEYS.has(key)) return true;
  const reverseKey = `${nb}-${na}`;
  return PEGGED_PAIR_KEYS.has(reverseKey);
}

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
  const isStablePair = (isStableSymbol(debtSymbol) && isStableSymbol(collateralSymbol)) || isPeggedPair(debtSymbol, collateralSymbol);
  const uniFeesForPair = DEFAULT_UNI_FEES.filter((fee) => fee !== 100 || isStablePair);

  if (!chainDex) {
    // Fallback to default UniV3 if no dexRouters are configured for the chain
    const uniRouter = chain.uniV3Router as Address | undefined;
    if (uniRouter) {
      for (const fee of uniFeesForPair) {
        options.push({ type: 'UniV3', router: uniRouter, fee });
      }
    }
    const gapFee = uniFeesForPair[0] ?? 500;
    return { options, gapFee, gapRouter: uniRouter };
  }

  // Uniswap V3
  const uniV3Router = (chainDex.uniV3 ?? chain.uniV3Router) as Address | undefined;
  if (uniV3Router) {
    for (const fee of uniFeesForPair) {
      options.push({ type: 'UniV3', router: uniV3Router, fee });
    }
  }
  const stableToken = chain.tokens.USDC || chain.tokens.USDbC || chain.tokens['USDC.e'];
  const stableSymbol = stableToken
    ? Object.entries(chain.tokens).find(([, info]) => info.address.toLowerCase() === stableToken.address.toLowerCase())?.[0] ?? 'USDC'
    : 'USDC';
  const wethToken = chain.tokens.WETH ?? chain.tokens.ETH;
  const wethSymbol = wethToken
    ? Object.entries(chain.tokens).find(([, info]) => info.address.toLowerCase() === wethToken.address.toLowerCase())?.[0] ?? 'WETH'
    : 'WETH';

  const multiHopCandidates: Array<{ path: Address[]; fees: number[] }> = [];
  const pickFee = (a: string, b: string) => {
    if ((isStableSymbol(a) && isStableSymbol(b)) || isPeggedPair(a, b)) return 100;
    return 500;
  };

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

  const dedupe = new Set<string>();
  const pushUniV2 = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) pushUniV2(item);
      return;
    }
    if (typeof value !== 'string') return;
    try {
      const router = getAddress(value as Address);
      const key = `uniV2:${router.toLowerCase()}`;
      if (dedupe.has(key)) return;
      dedupe.add(key);
      options.push({ type: 'UniV2', router });
    } catch {
      // ignore invalid address
    }
  };

  pushUniV2(chainDex.camelotV2);
  pushUniV2(chainDex.uniV2);
  pushUniV2(chainDex.sushiV2);
  pushUniV2(chainDex.quickSwapV2);
  pushUniV2(chainDex.uniV2Routers);

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
  let gapFee: number;
  if (isStablePair) {
    gapFee = 100;
  } else if (uniFeesForPair.includes(3000)) {
    gapFee = 3000;
  } else {
    gapFee = uniFeesForPair[0] ?? 500;
  }

  return { options, gapFee, gapRouter };
}
