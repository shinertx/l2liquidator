import '../infra/env';
import { Address, createPublicClient, getAddress, http } from 'viem';
import { loadConfig, chainById, ChainCfg } from '../infra/config';
import { log } from '../infra/logger';

const QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
];

const UNIV2_ROUTER_ABI = [
  { type: 'function', name: 'getAmountsOut', stateMutability: 'view', inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ], outputs: [{ name: 'amounts', type: 'uint256[]' }] }
];

const SOLIDLY_ROUTER_ABI = [
  { type: 'function', name: 'getAmountsOut', stateMutability: 'view', inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'routes', type: 'tuple[]', components: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'stable', type: 'bool' },
        { name: 'factory', type: 'address' },
      ] }
    ], outputs: [{ name: 'amounts', type: 'uint256[]' }] },
];

async function checkChainQuotes(chain: ChainCfg) {
  const client = createPublicClient({ transport: http(chain.rpc) });
  const tokens = chain.tokens;
  const usdc = tokens['USDC'] || tokens['USDC.e'] || tokens['USDbC'];
  const weth = tokens['WETH'] || tokens['ETH'];
  if (!usdc || !weth) {
    log.warn({ chain: chain.id }, 'missing-usdc-weth');
    return;
  }
  const usdcAddr = getAddress(usdc.address as Address);
  const wethAddr = getAddress(weth.address as Address);
  const amountIn = 1_000_000n; // 1 USDC (6dp) as a tiny probe

  // UniV3 Quoter V2 across common fee tiers
  const fees = [100, 500, 3000];
  for (const fee of fees) {
    try {
      const quoter = getAddress(chain.quoter as Address);
      const out = await client.readContract({
        address: quoter,
        abi: QUOTER_V2_ABI as any,
        functionName: 'quoteExactInputSingle',
        args: [usdcAddr, wethAddr, fee, amountIn, 0n],
      });
      const amountOut = (out as any).amountOut ?? (Array.isArray(out) ? (out as any)[0] : out);
      log.info({ chain: chain.id, dex: 'UniV3', fee, amountIn: amountIn.toString(), amountOut: amountOut.toString() }, 'quote');
    } catch (err) {
      log.error({ chain: chain.id, dex: 'UniV3', fee, err: (err as Error).message, quoter: chain.quoter }, 'quote-error');
    }
  }

  // UniV2/Camelot
  const camelot = (chain as any).dexRouters?.camelotV2; // likely undefined here; prefer cfg.dexRouters
  // Try pulling from global config dexRouters map
  let uniV2Router: Address | undefined;
  let velodrome: Address | undefined;
  let veloFactory: Address | undefined;
  try {
    // Read from loaded YAML: dexRouters keyed by chain.id
    const cfg = loadConfig();
    const entry = cfg.dexRouters?.[chain.id];
    uniV2Router = entry?.camelotV2 as Address | undefined;
    velodrome = entry?.velodrome as Address | undefined;
    veloFactory = entry?.velodromeFactory as Address | undefined;
  } catch {}

  if (uniV2Router) {
    try {
      const amounts = await client.readContract({
        address: uniV2Router,
        abi: UNIV2_ROUTER_ABI as any,
        functionName: 'getAmountsOut',
  args: [amountIn, [usdcAddr, wethAddr]],
      });
      const out = (amounts as any).amounts ?? amounts;
      const last = Array.isArray(out) ? out[out.length - 1] : out;
      log.info({ chain: chain.id, dex: 'UniV2', router: uniV2Router, amountIn: amountIn.toString(), amountOut: (last as bigint).toString() }, 'quote');
    } catch (err) {
      log.error({ chain: chain.id, dex: 'UniV2', router: uniV2Router, err: (err as Error).message }, 'quote-error');
    }
  }

  if (velodrome && veloFactory) {
    try {
      const amounts = await client.readContract({
        address: velodrome,
        abi: SOLIDLY_ROUTER_ABI as any,
        functionName: 'getAmountsOut',
  args: [amountIn, [{ from: usdcAddr, to: wethAddr, stable: false, factory: veloFactory }]],
      });
      const out = (amounts as any).amounts ?? amounts;
      const last = Array.isArray(out) ? out[out.length - 1] : out;
      log.info({ chain: chain.id, dex: 'Solidly', router: velodrome, amountIn: amountIn.toString(), amountOut: (last as bigint).toString() }, 'quote');
    } catch (err) {
      log.error({ chain: chain.id, dex: 'Solidly', router: velodrome, err: (err as Error).message }, 'quote-error');
    }
  }
}

async function main() {
  const cfg = loadConfig();
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    await checkChainQuotes(chain);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
