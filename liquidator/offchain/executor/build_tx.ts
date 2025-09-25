import { Address } from 'viem';

export type BuildArgs = {
  borrower: Address;
  debtAsset: Address;
  collateralAsset: Address;
  repayAmount: bigint;
  dexId: number;
  router: Address;
  uniFee: number;
  solidlyStable?: boolean;
  solidlyFactory?: Address;
  minProfit: bigint;
  amountOutMin: bigint;
  deadline: bigint;
};

export function encodePlan(args: BuildArgs) {
  // ABI for Liquidator.liquidateWithFlash((...))
  return {
    functionName: 'liquidateWithFlash',
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
        solidlyFactory: args.solidlyFactory ?? ('0x0000000000000000000000000000000000000000' as Address),
        minProfit: args.minProfit,
        amountOutMin: args.amountOutMin,
        deadline: args.deadline,
      },
    ],
  } as const;
}
