import type { Chain, PublicClient, Transport } from 'viem';
import { Buffer } from 'buffer';
import { Address, getAddress } from 'viem';
import { ChainCfg, TokenInfo } from '../infra/config';

export const DEX_ID = {
  UNI_V3: 0,
  SOLIDLY_V2: 1,
  UNI_V2: 2,
  UNI_V3_MULTI: 3,
} as const;

export type RouteOption =
  | { type: 'UniV3'; router: Address; fee: number }
  | { type: 'SolidlyV2'; router: Address; factory: Address; stable: boolean }
  | { type: 'UniV2'; router: Address }
  | { type: 'UniV3Multi'; router: Address; path: Address[]; fees: number[] };

export type RouteQuote = {
  dexId: number;
  router: Address;
  uniFee?: number;
  solidlyStable?: boolean;
  solidlyFactory?: Address;
  path?: `0x${string}`;
  fees?: number[];
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
  {
    name: 'quoteExactInput',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'amountIn', type: 'uint256' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
      { name: 'initializedTicksCrossedList', type: 'uint32[]' },
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

function encodeUniV3Path(tokens: Address[], fees: number[]): `0x${string}` {
  if (tokens.length !== fees.length + 1) {
    throw new Error('invalid path');
  }
  const parts: number[] = [];
  for (let i = 0; i < fees.length; i += 1) {
    const token = tokens[i];
    const fee = fees[i];
    const tokenBytes = token.toLowerCase().replace(/^0x/, '');
    if (tokenBytes.length !== 40) throw new Error('token length');
    for (let j = 0; j < tokenBytes.length; j += 2) {
      parts.push(parseInt(tokenBytes.slice(j, j + 2), 16));
    }
    const feeHex = fee.toString(16).padStart(6, '0');
    for (let j = 0; j < feeHex.length; j += 2) {
      parts.push(parseInt(feeHex.slice(j, j + 2), 16));
    }
  }
  const lastToken = tokens[tokens.length - 1].toLowerCase().replace(/^0x/, '');
  if (lastToken.length !== 40) throw new Error('token length');
  for (let j = 0; j < lastToken.length; j += 2) {
    parts.push(parseInt(lastToken.slice(j, j + 2), 16));
  }
  return (`0x${Buffer.from(parts).toString('hex')}`) as `0x${string}`;
}

async function quoteUniV3(
  client: RpcClient,
  chain: ChainCfg,
  option: Extract<RouteOption, { type: 'UniV3' }>,
  collateral: TokenInfo,
  debt: TokenInfo,
  seizeAmount: bigint
): Promise<bigint> {
  const { result } = await client.simulateContract({
    address: getAddress(chain.quoter as Address),
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn: getAddress(collateral.address as Address),
        tokenOut: getAddress(debt.address as Address),
        amountIn: seizeAmount,
        fee: option.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const [amountOut] = result as unknown as [bigint, bigint, number, bigint];
  return amountOut;
}

async function quoteUniV3Multi(
  client: RpcClient,
  chain: ChainCfg,
  option: Extract<RouteOption, { type: 'UniV3Multi' }>,
  seizeAmount: bigint
): Promise<{ quoted: bigint; path: `0x${string}` }> {
  const encodedPath = encodeUniV3Path(option.path, option.fees);
  const { result } = await client.simulateContract({
    address: getAddress(chain.quoter as Address),
    abi: QUOTER_ABI,
    functionName: 'quoteExactInput',
    args: [
      {
        path: encodedPath,
        amountIn: seizeAmount,
      },
    ],
  });
  const [amountOut] = result as unknown as [bigint, bigint[], number[], bigint];
  return { quoted: amountOut, path: encodedPath };
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
      let quotePath: `0x${string}` | undefined;
      if (option.type === 'UniV3') {
        quoted = await quoteUniV3(client, chain, option, collateral, debt, seizeAmount);
      } else if (option.type === 'SolidlyV2') {
        quoted = await quoteSolidlyV2(client, option, collateral, debt, seizeAmount);
      } else if (option.type === 'UniV2') {
        quoted = await quoteUniV2(client, option, collateral, debt, seizeAmount);
      } else {
        const multi = await quoteUniV3Multi(client, chain, option, seizeAmount);
        quoted = multi.quoted;
        quotePath = multi.path;
      }

      const amountOutMin = (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
      const quote: RouteQuote = {
        dexId:
          option.type === 'UniV3'
            ? DEX_ID.UNI_V3
            : option.type === 'SolidlyV2'
            ? DEX_ID.SOLIDLY_V2
            : option.type === 'UniV2'
            ? DEX_ID.UNI_V2
            : DEX_ID.UNI_V3_MULTI,
        router: option.router,
        uniFee: option.type === 'UniV3' ? option.fee : undefined,
        solidlyStable: option.type === 'SolidlyV2' ? option.stable : undefined,
        solidlyFactory: option.type === 'SolidlyV2' ? option.factory : undefined,
        path: quotePath,
        fees: option.type === 'UniV3Multi' ? option.fees : undefined,
        amountOutMin,
        quotedOut: quoted,
      };

      if (!best || quoted > best.quotedOut) {
        best = quote;
      }
    } catch {
      // soft-fail and continue
      continue;
    }
  }

  return best;
}
