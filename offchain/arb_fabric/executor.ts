import { Address, Hex, createPublicClient, formatUnits, http, numberToHex } from 'viem';
import { arbitrum, base, optimism } from 'viem/chains';
import { wallet } from '../executor/mev_protect';
import { log } from '../infra/logger';
import { counter } from '../infra/metrics';
import { privateKeyForChain } from '../infra/accounts';
import type { PairRuntime } from './pair_registry';
import type { QuoteEdge, Leg } from '../pipeline/types';
import { FabricConfig } from './types';
import { getPublicClient } from '../infra/rpc_clients';
import { InventoryManager } from './inventory_manager';
import { fetchOraclePriceUsd } from './oracle';

const CHAINS: Record<number, any> = {
  42161: arbitrum,
  10: optimism,
  8453: base,
};

const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
] as const;

const SWAP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInput',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

const MAX_UINT = 2n ** 256n - 1n;

const successCounter = counter.lafExecSuccess;
const failureCounter = counter.lafExecFailed;

export class FabricExecutor {
  private readonly execLog = log.child({ module: 'fabric.exec' });
  private readonly inventory: InventoryManager;

  constructor(private readonly fabric: FabricConfig) {
    this.inventory = new InventoryManager(fabric);
  }

  async executeEdge(edge: QuoteEdge, pair: PairRuntime): Promise<`0x${string}` | null> {
    const pk = privateKeyForChain(pair.chain);
    if (!pk) {
      this.execLog.error({ chainId: pair.chain.id }, 'fabric-missing-private-key');
      return null;
    }

    const chain = CHAINS[pair.chain.id];
    if (!chain) {
      this.execLog.error({ chainId: pair.chain.id }, 'fabric-chain-unsupported');
      return null;
    }

    const router = pair.chain.uniV3Router as Address;
    const walletClient = wallet(pair.chain.rpc, pk, pair.chain.privtx);
    const account = walletClient.account?.address as Address;
    if (!account) {
      this.execLog.error({ chainId: pair.chain.id }, 'fabric-wallet-missing-account');
      return null;
    }

    const basePriceUsd = await this.basePriceUsd(edge, pair);
    if (!(await this.inventory.ensureBalance(pair, pair.baseToken.address as Address, edge.sizeIn, account, basePriceUsd))) {
      return null;
    }

    await this.ensureAllowance(edge.sizeIn, walletClient, account, router, pair.baseToken.address as Address, pair.chain);

    const path = this.buildPath(edge.legs);
    if (!path) {
      this.execLog.warn({ edgeId: edge.id, source: edge.source }, 'fabric-path-unhandled');
      return null;
    }

    const slippageBps = this.fabric.global.slippageBps ?? 30;
    const expectedOut = this.expectedOutput(edge);
    const minOutRaw = expectedOut > 0n ? expectedOut : edge.sizeIn;
    const minOut = applySlippage(minOutRaw, slippageBps);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + (this.fabric.global.deadlineBufferSec ?? 120));

    const params = {
      path,
      recipient: account,
      deadline,
      amountIn: edge.sizeIn,
      amountOutMinimum: minOut,
    } as const;

    const publicClient = createPublicClient({ transport: http(pair.chain.rpc) });

    try {
      const gas = await publicClient.estimateContractGas({
        account,
        address: router,
        abi: SWAP_ROUTER_ABI,
        functionName: 'exactInput',
        args: [params],
      });

      const hash = (await walletClient.writeContract({
        account,
        chain,
        address: router,
        abi: SWAP_ROUTER_ABI,
        functionName: 'exactInput',
        args: [params],
        gas,
      })) as `0x${string}`;

      successCounter.labels({ source: edge.source }).inc();
      this.inventory.recordFill(pair, pair.baseToken.address as Address, edge.sizeIn, basePriceUsd);
      this.execLog.info({ hash, edgeId: edge.id, chainId: pair.chain.id }, 'fabric-exec-sent');
      return hash;
    } catch (err) {
      failureCounter.labels({ source: edge.source }).inc();
      const message = err instanceof Error ? err.message : String(err);
      this.execLog.error({ err: message, edgeId: edge.id, chainId: pair.chain.id }, 'fabric-exec-error');
      return null;
    }
  }

  private async ensureAllowance(
    required: bigint,
    writeClient: ReturnType<typeof wallet>,
    owner: Address,
    router: Address,
    token: Address,
    chain: PairRuntime['chain'],
  ): Promise<void> {
    const client = getPublicClient(chain);
    const allowance = (await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, router],
    })) as bigint;
    if (allowance >= required) {
      return;
    }
    const chainObj = CHAINS[chain.id];
    await writeClient.writeContract({
      chain: chainObj,
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [router, MAX_UINT],
    });
    this.execLog.info({ token, router, chainId: chain.id }, 'fabric-allowance-updated');
  }
  private async basePriceUsd(edge: QuoteEdge, pair: PairRuntime): Promise<number> {
    const meta = edge.metadata;
    if (meta && typeof meta.basePriceUsd === 'number' && Number.isFinite(meta.basePriceUsd)) {
      return meta.basePriceUsd;
    }
    const client = getPublicClient(pair.chain);
    const oracle = await fetchOraclePriceUsd(client, pair.baseToken);
    if (oracle.priceUsd && !oracle.stale) {
      return oracle.priceUsd;
    }
    const amount = Number(formatUnits(edge.sizeIn, pair.baseToken.decimals));
    if (amount > 0 && edge.estNetUsd > 0) {
      return edge.estNetUsd / Math.max(1e-6, edge.risk.pnlMultiple);
    }
    return 0;
  }

  private expectedOutput(edge: QuoteEdge): bigint {
    const metrics = edge.metrics as Record<string, unknown> | undefined;
    if (metrics) {
      if (metrics.finalOut !== undefined) {
        return readBigIntMetric(metrics.finalOut);
      }
      if (metrics.amountBaseReturned !== undefined) {
        return readBigIntMetric(metrics.amountBaseReturned);
      }
    }
    return 0n;
  }

  private buildPath(legs: readonly Leg[]): Hex | null {
    if (legs.length === 0) return null;
    const tokens: `0x${string}`[] = [];
    const fees: number[] = [];
    for (let i = 0; i < legs.length; i += 1) {
      const leg = legs[i];
      if (!leg.feeBps || leg.feeBps <= 0) {
        return null;
      }
      if (i === 0) {
        tokens.push(leg.tokenIn);
      }
      tokens.push(leg.tokenOut);
      fees.push(leg.feeBps);
    }
    if (fees.length !== tokens.length - 1) {
      return null;
    }
    return encodeUniswapPath(tokens, fees);
  }
}

function readBigIntMetric(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === 'string' && value) {
    try {
      return BigInt(value);
    } catch (err) {
      return 0n;
    }
  }
  return 0n;
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  if (amount === 0n) return 0n;
  const bps = BigInt(10_000 - Math.max(0, Math.min(slippageBps, 10_000)));
  return (amount * bps) / 10_000n;
}

function encodeUniswapPath(tokens: `0x${string}`[], fees: number[]): Hex {
  let path = '0x';
  for (let i = 0; i < fees.length; i += 1) {
    const token = tokens[i];
    const fee = fees[i];
    path += token.slice(2);
    const feeHex = numberToHex(fee, { size: 3 });
    path += feeHex.slice(2);
  }
  path += tokens[tokens.length - 1].slice(2);
  return path as Hex;
}
