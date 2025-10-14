import { RiskManager } from '../arb_fabric/risk';
import type { FabricConfig } from '../arb_fabric/types';
import type { QuoteEdge } from '../pipeline/types';
import type { PairRuntime } from '../arb_fabric/pair_registry';
import type { ChainCfg, TokenInfo } from '../infra/config';
import { test, expect, expectEqual } from './test_harness';

const now = Date.now();

function makeFabricConfig(mode: 'census' | 'active'): FabricConfig {
  return {
    global: {
      mode,
      pollIntervalMs: 1_000,
      quoteIntervalMs: 1_000,
      enableSingleHop: true,
      enableTriangular: false,
      enableCrossChain: false,
      minNetUsd: 1,
      pnlMultipleMin: 2,
      revertProbability: 0.01,
      inclusionTargetMs: 100,
      maxEdgeAgeMs: 5_000,
      slippageBps: 30,
      deadlineBufferSec: 120,
      maxConcurrentExecutions: 1,
      maxVenuesPerLeg: 1,
    },
    chains: [],
  };
}

const tokenWeth: TokenInfo = { address: '0x0000000000000000000000000000000000000001', decimals: 18 };
const tokenUsdc: TokenInfo = { address: '0x0000000000000000000000000000000000000002', decimals: 6 };

const chainCfg: ChainCfg = {
  id: 42161,
  name: 'arbitrum',
  rpc: 'http://localhost:8545',
  aaveProvider: '0x0000000000000000000000000000000000000001',
  uniV3Router: '0x0000000000000000000000000000000000000002',
  quoter: '0x0000000000000000000000000000000000000003',
  enabled: true,
  tokens: {
    WETH: tokenWeth,
    USDC: tokenUsdc,
  },
};

const pairRuntime: PairRuntime = {
  config: {
    id: 'arb-weth-usdc',
    symbol: 'WETH/USDC',
    chainId: 42161,
    baseToken: 'WETH',
    quoteToken: 'USDC',
    tradeSize: { baseAmount: '0.1' },
    venues: [],
  },
  fabricChain: {
    chainId: 42161,
    enabled: true,
    nativeToken: 'WETH',
    treasuryFloatUsd: 1_000,
    gasUnitsEstimate: 900_000,
    gasSafetyMultiplier: 1.2,
    pairs: [],
  },
  chain: chainCfg,
  baseToken: tokenWeth,
  quoteToken: tokenUsdc,
  tradeSizeBase: 10n ** 17n, // 0.1 WETH
  venues: [],
};

function sampleEdge(source: 'single-hop' | 'triangular' | 'cross-chain', createdAtOffsetMs = 0): QuoteEdge {
  return {
    id: `${source}-${createdAtOffsetMs}`,
    source,
    legs: [
      {
        chainId: 42161,
        venue: 'univ3-500',
        action: 'swap',
        tokenIn: tokenWeth.address,
        tokenOut: tokenUsdc.address,
        amountIn: 10n ** 17n,
        minAmountOut: 25000000n,
        feeBps: 500,
      },
    ],
    sizeIn: 10n ** 17n,
    estNetUsd: 2,
    estGasUsd: 0.1,
    estSlippageUsd: 0,
    estFailCostUsd: 0.1,
    risk: {
      minNetUsd: 1,
      pnlMultiple: 4,
      revertProbability: 0.01,
      inclusionP95Ms: 100,
      mode: 'active',
    },
    createdAtMs: now - createdAtOffsetMs,
  };
}

test('RiskManager allows fresh profitable edge', () => {
  const fabric = makeFabricConfig('active');
  const risk = new RiskManager(fabric);
  const edge = sampleEdge('single-hop');
  const result = risk.evaluate(edge, pairRuntime);
  expect(result.ok, 'Expected edge to pass risk checks');
});

test('RiskManager rejects stale edge', () => {
  const fabric = makeFabricConfig('active');
  fabric.global.maxEdgeAgeMs = 1_000;
  const risk = new RiskManager(fabric);
  const edge = sampleEdge('single-hop', 5_000);
  const result = risk.evaluate(edge, pairRuntime);
  expect(!result.ok, 'Expected stale edge to be rejected');
  if (result.ok) {
    throw new Error('Expected stale edge to be rejected');
  }
  expectEqual(result.reason, 'edge-stale', 'Expected reason edge-stale');
});

test('RiskManager disables sources when feature flag false', () => {
  const fabric = makeFabricConfig('active');
  fabric.global.enableTriangular = false;
  const risk = new RiskManager(fabric);
  const edge = sampleEdge('triangular');
  const result = risk.evaluate(edge, pairRuntime);
  expect(!result.ok, 'Expected triangular edge to be rejected when disabled');
  if (result.ok) {
    throw new Error('Expected triangular edge to be rejected when disabled');
  }
  expectEqual(result.reason, 'source-disabled');
});

test('RiskManager applies backoff after consecutive failures', () => {
  const fabric = makeFabricConfig('active');
  const risk = new RiskManager(fabric);
  const edge = sampleEdge('single-hop');

  risk.record(pairRuntime, false);
  risk.record(pairRuntime, false);
  risk.record(pairRuntime, false);

  const result = risk.evaluate(edge, pairRuntime);
  expect(!result.ok, 'Expected edge to be rejected due to backoff');
  if (result.ok) {
    throw new Error('Expected edge to be rejected due to backoff');
  }
  expectEqual(result.reason, 'backoff');
});
