import type { Address } from 'viem';
import { AppConfig, ChainCfg } from '../infra/config';
import { RouteOption } from '../simulator/router';

const DEFAULT_UNI_FEES = [500, 3000, 10000];

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
  const prefer = cfg.routing?.prefer?.[chain.id]?.[`${debtSymbol}-${collateralSymbol}`]
    ?? cfg.routing?.prefer?.[chain.id]?.[`${collateralSymbol}-${debtSymbol}`];
  const chainDex = cfg.dexRouters?.[chain.id];
  const uniRouter = (chainDex?.uniV3 ?? chain.uniV3Router) as Address | undefined;
  const options: RouteOption[] = [];
  const seenUni = new Set<number>();
  let gapFee: number | undefined;
  let gapRouter: Address | undefined;

  const pushUni = (fee: number) => {
    if (!uniRouter || !Number.isFinite(fee)) return;
    if (seenUni.has(fee)) return;
    seenUni.add(fee);
    options.push({ type: 'UniV3', router: uniRouter, fee });
    if (gapFee === undefined) {
      gapFee = fee;
      gapRouter = uniRouter;
    }
  };

  const pushUniDefaults = () => {
    for (const fee of DEFAULT_UNI_FEES) pushUni(fee);
  };

  const pushCamelot = () => {
    const router = chainDex?.camelotV2 as Address | undefined;
    if (router) options.push({ type: 'UniV2', router });
  };

  const pushSolidly = (router?: string, factory?: string, stable = false) => {
    if (!router || !factory) return;
    options.push({ type: 'SolidlyV2', router: router as Address, factory: factory as Address, stable });
  };

  if (Array.isArray(prefer) && prefer.length) {
    for (const raw of prefer) {
      const entry = String(raw).trim();
      const lower = entry.toLowerCase();
      const uniMatch = /^univ3:(\d+)$/.exec(lower);
      if (uniMatch) {
        pushUni(Number(uniMatch[1]));
        continue;
      }
      if (lower === 'univ3') {
        pushUniDefaults();
        continue;
      }
      if (lower.startsWith('camelot')) {
        pushCamelot();
        continue;
      }
      if (lower.startsWith('velodrome')) {
        const stable = lower.includes(':stable');
        pushSolidly(chainDex?.velodrome, chainDex?.velodromeFactory, stable);
        continue;
      }
      if (lower.startsWith('aerodrome')) {
        const stable = lower.includes(':stable');
        pushSolidly(chainDex?.aerodrome, chainDex?.aerodromeFactory, stable);
        continue;
      }
    }
  }

  if (!options.length) {
    pushUniDefaults();
  }

  if (gapRouter === undefined && uniRouter) {
    gapRouter = uniRouter;
  }

  return { options, gapFee: gapFee ?? DEFAULT_UNI_FEES[0], gapRouter };
}
