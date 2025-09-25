import type { Chain, PublicClient, Transport } from 'viem';
import { Address, getAddress } from 'viem';
import { ChainCfg, TokenInfo } from '../infra/config';

export const DEX_ID = {
  UNI_V3: 0,
  SOLIDLY_V2: 1,
  UNI_V2: 2,
} as const;

export type RouteOption =
  | { type: 'UniV3'; router: Address; fee: number }
  | { type: 'SolidlyV2'; router: Address; factory: Address; stable: boolean }
  | { type: 'UniV2'; router: Address };

export type RouteQuote = {
  dexId: number;
  router: Address;
  uniFee?: number;
  solidlyStable?: boolean;
  solidlyFactory?: Address;
  amountOutMin: bigint;
  quotedOut: bigint;
};

type RpcClient = PublicClient<Transport, Chain | undefined, any>;

const QUOTER_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const UNI_V2_ABI = [
  {
    name: 'getAmountsOut',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const;

const SOLIDLY_ABI = [
  {
    name: 'getAmountsOut',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      {
        name: 'routes',
        type: 'tuple[]',
        components: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'stable', type: 'bool' },
          { name: 'factory', type: 'address' },
        ],
      },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const;

async function quoteUniV3(
  client: RpcClient,
  chain: ChainCfg,
  option: Extract<RouteOption, { type: 'UniV3' }>,
  collateral: TokenInfo,
  debt: TokenInfo,
  seizeAmount: bigint
): Promise<bigint> {
  const [amountOut] = (await client.readContract({
    address: getAddress(chain.quoter as Address),
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn: collateral.address,
        tokenOut: debt.address,
        amountIn: seizeAmount,
        fee: option.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })) as [bigint, bigint, number, bigint];
  return amountOut;
}

async function quoteUniV2(
  client: RpcClient,
  option: Extract<RouteOption, { type: 'UniV2' }>,
  collateral: TokenInfo,
  debt: TokenInfo,
  seizeAmount: bigint
): Promise<bigint> {
  const path = [collateral.address, debt.address];
  const amounts = (await client.readContract({
    address: getAddress(option.router),
    abi: UNI_V2_ABI,
    functionName: 'getAmountsOut',
    args: [seizeAmount, path],
  })) as bigint[];
  return amounts[amounts.length - 1];
}

async function quoteSolidlyV2(
  client: RpcClient,
  option: Extract<RouteOption, { type: 'SolidlyV2' }>,
  collateral: TokenInfo,
  debt: TokenInfo,
  seizeAmount: bigint
): Promise<bigint> {
  const routes = [
    {
      from: collateral.address,
      to: debt.address,
      stable: option.stable,
      factory: option.factory,
    },
  ];
  const amounts = (await client.readContract({
    address: getAddress(option.router),
    abi: SOLIDLY_ABI,
    functionName: 'getAmountsOut',
    args: [seizeAmount, routes],
  })) as bigint[];
  return amounts[amounts.length - 1];
}

export async function bestRoute({
  client,
  chain,
  collateral,
  debt,
  seizeAmount,
  slippageBps,
  options,
}: {
  client: RpcClient;
  chain: ChainCfg;
  collateral: TokenInfo;
  debt: TokenInfo;
  seizeAmount: bigint;
  slippageBps: number;
  options: RouteOption[];
}): Promise<RouteQuote | null> {
  if (seizeAmount === 0n || options.length === 0) {
    return null;
  }

  let best: RouteQuote | null = null;

  for (const option of options) {
    try {
      let quoted: bigint;
      if (option.type === 'UniV3') {
        quoted = await quoteUniV3(client, chain, option, collateral, debt, seizeAmount);
      } else if (option.type === 'SolidlyV2') {
        quoted = await quoteSolidlyV2(client, option, collateral, debt, seizeAmount);
      } else {
        quoted = await quoteUniV2(client, option, collateral, debt, seizeAmount);
      }

      const amountOutMin = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
      const quote: RouteQuote = {
        dexId:
          option.type === 'UniV3'
            ? DEX_ID.UNI_V3
            : option.type === 'SolidlyV2'
            ? DEX_ID.SOLIDLY_V2
            : DEX_ID.UNI_V2,
        router: option.router,
        uniFee: option.type === 'UniV3' ? option.fee : undefined,
        solidlyStable: option.type === 'SolidlyV2' ? option.stable : undefined,
        solidlyFactory: option.type === 'SolidlyV2' ? option.factory : undefined,
        amountOutMin,
        quotedOut: quoted,
      };

      if (!best || quoted > best.quotedOut) {
        best = quote;
      }
    } catch (err) {
      // soft-fail and continue
      continue;
    }
  }

  return best;
}
