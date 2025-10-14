import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { loadConfig, type AppConfig } from '../infra/config';
import { chainCfgOrThrow, tokenInfoOrThrow } from '../arb_fabric/config';

const DEFAULT_OUTPUT = 'fabric.config.census-full.yaml';

type CliOptions = {
  output: string;
  minNetUsd: number;
  pnlMultipleMin: number;
  enableTriangular: boolean;
  enableCrossChain: boolean;
  chains?: Set<number>;
};

const CHAIN_ALIAS: Record<string, number> = {
  arb: 42161,
  arbitrum: 42161,
  op: 10,
  optimism: 10,
  base: 8453,
  polygon: 137,
  matic: 137,
};

function parseCliOptions(): CliOptions {
  const opts: CliOptions = {
    output: DEFAULT_OUTPUT,
    minNetUsd: 0.75,
    pnlMultipleMin: 1.5,
    enableTriangular: true,
    enableCrossChain: true,
  };

  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const [flag, rawValue] = arg.split('=');
    const value = rawValue ?? 'true';
    switch (flag) {
      case '--output':
        opts.output = value;
        break;
      case '--min-net':
      case '--minNetUsd':
        opts.minNetUsd = Number(value);
        break;
      case '--pnl-multiple':
      case '--pnlMultipleMin':
        opts.pnlMultipleMin = Number(value);
        break;
      case '--no-triangular':
        opts.enableTriangular = false;
        break;
      case '--no-cross-chain':
        opts.enableCrossChain = false;
        break;
      case '--chains': {
        const ids = value
          .split(',')
          .map((alias) => alias.trim().toLowerCase())
          .filter(Boolean)
          .map((alias) => CHAIN_ALIAS[alias])
          .filter((id): id is number => typeof id === 'number');
        opts.chains = new Set(ids);
        break;
      }
      default:
        console.warn(`Unknown flag ${flag} (ignored)`);
    }
  }

  if (!Number.isFinite(opts.minNetUsd) || opts.minNetUsd <= 0) {
    throw new Error('minNetUsd must be a positive number');
  }
  if (!Number.isFinite(opts.pnlMultipleMin) || opts.pnlMultipleMin <= 0) {
    throw new Error('pnlMultipleMin must be a positive number');
  }

  return opts;
}

function buildGlobalOptions(opts: CliOptions) {
  return {
    mode: 'census' as const,
    pollIntervalMs: 1000,
    quoteIntervalMs: 3000,
    enableSingleHop: true,
    enableTriangular: opts.enableTriangular,
    enableCrossChain: opts.enableCrossChain,
    minNetUsd: opts.minNetUsd,
    pnlMultipleMin: opts.pnlMultipleMin,
    revertProbability: 0.01,
    inclusionTargetMs: 100,
    maxEdgeAgeMs: 15000,
    slippageBps: 35,
    deadlineBufferSec: 120,
    maxConcurrentExecutions: 4,
    maxVenuesPerLeg: 2,
    quoterFailureBackoffMs: 120000,
    quoterFailureLogCooldownMs: 30000,
    priceGraphDepthTiers: [0.25, 0.5, 1, 1.5, 2],
  };
}

type PairSpec = {
  id?: string;
  base: string;
  quote: string;
  tradeSize: string;
  fees: number[];
  minNetUsd?: number;
  pnlMultipleMin?: number;
};

type ChainTemplate = {
  chainId: number;
  nativeToken: string;
  treasuryFloatUsd: number;
  gasUnitsEstimate: number;
  gasSafetyMultiplier?: number;
  pairs: PairSpec[];
};

const CHAINS: ChainTemplate[] = [
  {
    chainId: 42161,
    nativeToken: 'WETH',
    treasuryFloatUsd: 6000,
    gasUnitsEstimate: 950000,
    gasSafetyMultiplier: 1.25,
    pairs: [
      { base: 'WETH', quote: 'USDC', tradeSize: '0.35', fees: [500, 3000] },
      { base: 'WETH', quote: 'USDT', tradeSize: '0.35', fees: [500, 3000] },
      { base: 'USDC', quote: 'USDT', tradeSize: '1200', fees: [500] },
      { base: 'WETH', quote: 'DAI', tradeSize: '0.30', fees: [500, 3000] },
      { base: 'DAI', quote: 'USDC', tradeSize: '1500', fees: [500] },
      { base: 'WETH', quote: 'ARB', tradeSize: '0.28', fees: [3000] },
      { base: 'ARB', quote: 'USDC', tradeSize: '1600', fees: [500, 3000] },
      { base: 'WETH', quote: 'WBTC', tradeSize: '0.35', fees: [3000] },
      { base: 'WBTC', quote: 'USDC', tradeSize: '1.0', fees: [3000] },
      { base: 'WETH', quote: 'FRAX', tradeSize: '0.35', fees: [3000] },
      { base: 'FRAX', quote: 'USDC', tradeSize: '1500', fees: [500] },
      { base: 'WETH', quote: 'GHO', tradeSize: '0.35', fees: [3000] },
      { base: 'GHO', quote: 'USDC', tradeSize: '1500', fees: [500] },
    ],
  },
  {
    chainId: 10,
    nativeToken: 'WETH',
    treasuryFloatUsd: 5000,
    gasUnitsEstimate: 900000,
    gasSafetyMultiplier: 1.25,
    pairs: [
      { base: 'WETH', quote: 'USDC', tradeSize: '0.30', fees: [500, 3000] },
      { base: 'WETH', quote: 'USDT', tradeSize: '0.30', fees: [500, 3000] },
      { base: 'USDC', quote: 'USDT', tradeSize: '1000', fees: [500] },
      { base: 'WETH', quote: 'DAI', tradeSize: '0.28', fees: [500, 3000] },
      { base: 'DAI', quote: 'USDC', tradeSize: '1200', fees: [500] },
      { base: 'WETH', quote: 'OP', tradeSize: '0.25', fees: [3000] },
      { base: 'OP', quote: 'USDC', tradeSize: '1400', fees: [500, 3000] },
      { base: 'WETH', quote: 'WBTC', tradeSize: '0.30', fees: [3000] },
      { base: 'WBTC', quote: 'USDC', tradeSize: '0.8', fees: [3000] },
      { base: 'WETH', quote: 'wstETH', tradeSize: '0.30', fees: [500] },
      { base: 'wstETH', quote: 'USDC', tradeSize: '0.30', fees: [3000], minNetUsd: 0.5 },
      { base: 'rETH', quote: 'WETH', tradeSize: '0.20', fees: [500], minNetUsd: 0.5 },
      { base: 'rETH', quote: 'USDC', tradeSize: '0.20', fees: [3000], minNetUsd: 0.5 },
    ],
  },
  {
    chainId: 8453,
    nativeToken: 'WETH',
    treasuryFloatUsd: 4500,
    gasUnitsEstimate: 920000,
    gasSafetyMultiplier: 1.35,
    pairs: [
      { base: 'WETH', quote: 'USDC', tradeSize: '0.30', fees: [500, 3000] },
      { base: 'WETH', quote: 'USDbC', tradeSize: '0.30', fees: [500, 3000] },
      { base: 'USDC', quote: 'USDbC', tradeSize: '1200', fees: [500], minNetUsd: 0.5 },
      { base: 'WETH', quote: 'cbETH', tradeSize: '0.25', fees: [500] },
      { base: 'cbETH', quote: 'USDC', tradeSize: '0.25', fees: [3000], minNetUsd: 0.5 },
      { base: 'WETH', quote: 'wstETH', tradeSize: '0.25', fees: [500] },
  { base: 'wstETH', quote: 'USDC', tradeSize: '0.25', fees: [100, 500], minNetUsd: 0.5 },
      { base: 'WETH', quote: 'weETH', tradeSize: '0.25', fees: [500] },
  { base: 'weETH', quote: 'USDC', tradeSize: '0.25', fees: [100, 500], minNetUsd: 0.5 },
      { base: 'WETH', quote: 'EURC', tradeSize: '0.25', fees: [3000], minNetUsd: 0.8 },
      { base: 'EURC', quote: 'USDC', tradeSize: '1000', fees: [500], minNetUsd: 0.8 },
      { base: 'WETH', quote: 'GHO', tradeSize: '0.25', fees: [3000], minNetUsd: 0.8 },
      { base: 'GHO', quote: 'USDC', tradeSize: '1000', fees: [500], minNetUsd: 0.8 },
    ],
  },
  {
    chainId: 137,
    nativeToken: 'WETH',
    treasuryFloatUsd: 4000,
    gasUnitsEstimate: 1100000,
    gasSafetyMultiplier: 1.4,
    pairs: [
      { base: 'WETH', quote: 'USDC', tradeSize: '0.35', fees: [500, 3000] },
      { base: 'WETH', quote: 'USDT', tradeSize: '0.35', fees: [500, 3000] },
      { base: 'USDC', quote: 'USDT', tradeSize: '1500', fees: [500] },
      { base: 'WETH', quote: 'DAI', tradeSize: '0.30', fees: [500, 3000] },
      { base: 'DAI', quote: 'USDC', tradeSize: '1500', fees: [500] },
      { base: 'WETH', quote: 'WMATIC', tradeSize: '0.30', fees: [3000] },
      { base: 'WMATIC', quote: 'USDC', tradeSize: '2000', fees: [3000] },
      { base: 'WETH', quote: 'WBTC', tradeSize: '0.35', fees: [3000] },
      { base: 'WBTC', quote: 'USDC', tradeSize: '1.0', fees: [3000] },
      { base: 'WETH', quote: 'LINK', tradeSize: '0.25', fees: [3000], minNetUsd: 0.8 },
      { base: 'LINK', quote: 'USDC', tradeSize: '0.25', fees: [3000], minNetUsd: 0.8 },
      { base: 'WETH', quote: 'BAL', tradeSize: '0.25', fees: [3000], minNetUsd: 0.8 },
      { base: 'BAL', quote: 'USDC', tradeSize: '0.25', fees: [3000], minNetUsd: 0.8 },
    ],
  },
];

function buildPairs(template: ChainTemplate, appCfg: AppConfig, opts: CliOptions) {
  const chainCfg = chainCfgOrThrow(appCfg, template.chainId);
  return template.pairs.map((pair) => {
    tokenInfoOrThrow(chainCfg, pair.base);
    tokenInfoOrThrow(chainCfg, pair.quote);
    const slug = `${chainCfg.name}-${pair.base.toLowerCase()}-${pair.quote.toLowerCase()}`.replace(/[^a-z0-9-]/g, '');
    const id = pair.id ?? slug;
    return {
      id,
      symbol: `${pair.base}/${pair.quote}`,
      chainId: template.chainId,
      baseToken: pair.base,
      quoteToken: pair.quote,
      tradeSize: { baseAmount: pair.tradeSize },
      venues: pair.fees.map((fee) => ({
        id: `univ3-${fee}`,
        kind: 'uniswap_v3' as const,
        feeBps: fee,
      })),
      ...(pair.minNetUsd ? { minNetUsd: pair.minNetUsd } : opts.minNetUsd ? { minNetUsd: opts.minNetUsd } : {}),
      ...(pair.pnlMultipleMin ? { pnlMultipleMin: pair.pnlMultipleMin } : opts.pnlMultipleMin ? { pnlMultipleMin: opts.pnlMultipleMin } : {}),
    };
  });
}

function buildChains(appCfg: AppConfig, opts: CliOptions) {
  return CHAINS.filter((template) => {
    if (!opts.chains) return true;
    return opts.chains.has(template.chainId);
  }).map((template) => ({
    chainId: template.chainId,
    enabled: true,
    nativeToken: template.nativeToken,
    treasuryFloatUsd: template.treasuryFloatUsd,
    gasUnitsEstimate: template.gasUnitsEstimate,
    ...(template.gasSafetyMultiplier ? { gasSafetyMultiplier: template.gasSafetyMultiplier } : {}),
    pairs: buildPairs(template, appCfg, opts),
  }));
}

function main() {
  const opts = parseCliOptions();
  const appCfg = loadConfig();
  const chains = buildChains(appCfg, opts);

  if (chains.length === 0) {
    throw new Error('No chains selected. Provide --chains=alias1,alias2 with valid identifiers.');
  }

  const fabricConfig = {
    global: buildGlobalOptions(opts),
    chains,
  };

  const outputPath = path.isAbsolute(opts.output)
    ? opts.output
    : path.resolve(__dirname, '..', '..', opts.output);

  const yaml = YAML.stringify(fabricConfig, { indent: 2, aliasDuplicateObjects: false });
  fs.writeFileSync(outputPath, yaml);
  const pairCount = chains.reduce((acc, c) => acc + c.pairs.length, 0);
  console.log(`Wrote ${path.basename(outputPath)} with ${pairCount} pairs across ${chains.length} chains.`);
}

main();
