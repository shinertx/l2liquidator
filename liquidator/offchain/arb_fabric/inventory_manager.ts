import { formatUnits } from 'viem';
import type { Address } from 'viem';
import type { FabricConfig, PairRuntime } from './types';
import { getPublicClient } from '../infra/rpc_clients';
import { log } from '../infra/logger';

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
] as const;

type InventoryState = {
  balance: bigint;
  fetchedAt: number;
  lastSpendUsd: number;
};

type BridgeIntent = {
  chainId: number;
  token: `0x${string}`;
  deficitUsd: number;
  priority: 'low' | 'medium' | 'high';
};

export class InventoryManager {
  private readonly floatsUsd: Map<number, number> = new Map();
  private readonly cache: Map<string, InventoryState> = new Map();
  private readonly pendingBridges: BridgeIntent[] = [];
  private readonly inventoryLog = log.child({ module: 'fabric.inventory' });

  constructor(private readonly fabric: FabricConfig) {
    for (const chain of fabric.chains) {
      if (!chain.enabled) continue;
      this.floatsUsd.set(chain.chainId, chain.treasuryFloatUsd ?? fabric.global.minNetUsd * 10);
    }
  }

  async ensureBalance(
    pair: PairRuntime,
    token: `0x${string}`,
    amount: bigint,
    account: Address,
    priceUsd: number,
  ): Promise<boolean> {
    const key = this.cacheKey(pair.chain.id, token);
    const now = Date.now();
    const cached = this.cache.get(key);
    const client = getPublicClient(pair.chain);

    let balance = cached?.balance ?? 0n;
    if (!cached || now - cached.fetchedAt > 5_000) {
      balance = (await client.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account],
      })) as bigint;
      this.cache.set(key, { balance, fetchedAt: now, lastSpendUsd: cached?.lastSpendUsd ?? 0 });
    }

    if (balance >= amount) {
      return true;
    }

    const deficit = amount - balance;
    const deficitUsd = Number(formatUnits(deficit, pair.baseToken.decimals)) * priceUsd;
    const floatUsd = this.floatsUsd.get(pair.chain.id) ?? 0;
    if (deficitUsd <= floatUsd * 0.1) {
      this.inventoryLog.warn(
        {
          chainId: pair.chain.id,
          token,
          required: Number(formatUnits(amount, pair.baseToken.decimals)),
          balance: Number(formatUnits(balance, pair.baseToken.decimals)),
        },
        'fabric-inventory-low',
      );
    } else {
      this.enqueueBridge(pair.chain.id, token, deficitUsd);
    }
    return false;
  }

  recordFill(pair: PairRuntime, token: `0x${string}`, amountSpent: bigint, priceUsd: number): void {
    const key = this.cacheKey(pair.chain.id, token);
    const cached = this.cache.get(key);
    if (cached) {
      const newBalance = cached.balance >= amountSpent ? cached.balance - amountSpent : 0n;
      cached.balance = newBalance;
      cached.lastSpendUsd = Number(formatUnits(amountSpent, pair.baseToken.decimals)) * priceUsd;
      cached.fetchedAt = Date.now();
      this.cache.set(key, cached);
    }
    const floatUsd = this.floatsUsd.get(pair.chain.id) ?? 0;
    if (priceUsd * Number(formatUnits(amountSpent, pair.baseToken.decimals)) > floatUsd * 0.5) {
      this.enqueueBridge(pair.chain.id, token, priceUsd * Number(formatUnits(amountSpent, pair.baseToken.decimals)));
    }
  }

  drains(): BridgeIntent[] {
    return [...this.pendingBridges];
  }

  clearDrains(): void {
    this.pendingBridges.length = 0;
  }

  private enqueueBridge(chainId: number, token: `0x${string}`, deficitUsd: number): void {
    const priority = deficitUsd > 10_000 ? 'high' : deficitUsd > 2_500 ? 'medium' : 'low';
    this.pendingBridges.push({ chainId, token, deficitUsd, priority });
    this.inventoryLog.warn({ chainId, token, deficitUsd, priority }, 'fabric-bridge-request');
  }

  private cacheKey(chainId: number, token: `0x${string}`): string {
    return `${chainId}:${token.toLowerCase()}`;
  }
}
