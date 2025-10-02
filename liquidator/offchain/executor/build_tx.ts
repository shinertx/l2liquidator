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
  path?: `0x${string}`;
  mode?: 'flash' | 'funds';
};

export function encodePlan(args: BuildArgs) {
  const path = args.path ?? ('0x' as `0x${string}`);
  const targetFn = args.mode === 'funds' ? 'liquidateWithFunds' : 'liquidateWithFlash';
  return {
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
        solidlyFactory: args.solidlyFactory ?? ('0x0000000000000000000000000000000000000000' as Address),
        minProfit: args.minProfit,
        amountOutMin: args.amountOutMin,
        deadline: args.deadline,
        path,
      },
    ],
  } as const;
}
