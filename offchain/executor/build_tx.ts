import { Address } from 'viem';
import { ProtocolKey } from '../infra/config';
import LiquidatorAbi from './Liquidator.abi.json';
import MorphoBlueLiquidatorAbi from './MorphoBlueLiquidator.abi.json';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

type NonMorphoProtocols = Exclude<ProtocolKey, 'morphoblue'>;

type BaseArgs = {
  protocol: ProtocolKey;
  borrower: Address;
  repayAmount: bigint;
  dexId: number;
  router: Address;
  uniFee: number;
  solidlyStable?: boolean;
  solidlyFactory?: Address;
  minProfit: bigint;
  amountOutMin: bigint;
  deadline: bigint;
  path?: `0x${string}`;
  mode?: 'flash' | 'funds';
};

type LegacyBuildArgs = BaseArgs & {
  protocol: NonMorphoProtocols;
  debtAsset: Address;
  collateralAsset: Address;
};

type MorphoBuildArgs = BaseArgs & {
  protocol: 'morphoblue';
  market: {
    loanToken: Address;
    collateralToken: Address;
    oracle: Address;
    irm: Address;
    lltv: bigint;
  };
  repayShares: bigint;
  callbackData?: `0x${string}`;
};

export type BuildArgs = LegacyBuildArgs | MorphoBuildArgs;

export function encodePlan(args: BuildArgs) {
  const targetFn = args.mode === 'funds' ? 'liquidateWithFunds' : 'liquidateWithFlash';
  const path = args.path ?? ('0x' as `0x${string}`);

  if (args.protocol === 'morphoblue') {
    return {
      abi: MorphoBlueLiquidatorAbi,
      functionName: targetFn,
      args: [
        {
          market: args.market,
          borrower: args.borrower,
          repayAmount: args.repayAmount,
          repayShares: args.repayShares,
          dexId: args.dexId,
          router: args.router,
          uniFee: args.uniFee,
          solidlyStable: args.solidlyStable ?? false,
          solidlyFactory: args.solidlyFactory ?? ZERO_ADDRESS,
          minProfit: args.minProfit,
          amountOutMin: args.amountOutMin,
          deadline: args.deadline,
          path,
          callbackData: args.callbackData ?? ('0x' as `0x${string}`),
        },
      ],
    } as const;
  }

  return {
    abi: LiquidatorAbi,
    functionName: targetFn,
    args: [
      {
        borrower: args.borrower,
        debtAsset: args.debtAsset,
        collateralAsset: args.collateralAsset,
        repayAmount: args.repayAmount,
        dexId: args.dexId,
        router: args.router,
        uniFee: args.uniFee,
        solidlyStable: args.solidlyStable ?? false,
        solidlyFactory: args.solidlyFactory ?? ZERO_ADDRESS,
        minProfit: args.minProfit,
        amountOutMin: args.amountOutMin,
        deadline: args.deadline,
        path,
      },
    ],
  } as const;
}
