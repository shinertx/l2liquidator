import { Address } from 'viem';
import { chainCfgOrThrow, loadFabricConfig, tokenInfoOrThrow } from './config';
import type { FabricConfig, FabricChainConfig, PairConfig, VenueConfig } from './types';
import type { AppConfig, ChainCfg, TokenInfo } from '../infra/config';
import { getPublicClient } from '../infra/rpc_clients';
import { log } from '../infra/logger';
import { parseTokenAmount } from './utils';

const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

const UNISWAP_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const;

export type VenueRuntime = {
  config: VenueConfig;
  poolAddress: Address;
  quoter: Address;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  token0: Address;
  token1: Address;
};

export type PairRuntime = {
  config: PairConfig;
  fabricChain: FabricChainConfig;
  chain: ChainCfg;
  baseToken: TokenInfo;
  quoteToken: TokenInfo;
  tradeSizeBase: bigint;
  venues: VenueRuntime[];
};

type PairRegistryOptions = {
  appConfig?: AppConfig;
  fabricConfig?: FabricConfig;
  fabricPath?: string;
};

export class PairRegistry {
  public readonly fabric: FabricConfig;
  public readonly app: AppConfig;
  private readonly pairs: PairRuntime[] = [];

  constructor(opts: PairRegistryOptions = {}) {
    if (opts.fabricConfig && opts.appConfig) {
      this.fabric = opts.fabricConfig;
      this.app = opts.appConfig;
    } else {
      const path = opts.fabricPath ?? process.env.FABRIC_CONFIG ?? 'fabric.config.yaml';
      const { fabric, app } = loadFabricConfig(opts.appConfig, path);
      this.fabric = fabric;
      this.app = app;
    }
  }

  async init(): Promise<void> {
    this.pairs.length = 0;
    for (const chainCfg of this.fabric.chains) {
      if (!chainCfg.enabled) continue;
      const chain = chainCfgOrThrow(this.app, chainCfg.chainId);
      const baseClient = getPublicClient(chain);
      for (const pair of chainCfg.pairs) {
        try {
          const runtime = await this.buildPairRuntime(chainCfg, pair, chain, baseClient);
          this.pairs.push(runtime);
          log.info(
            {
              chainId: chain.id,
              pairId: pair.id,
              venues: runtime.venues.map((v) => ({ id: v.config.id, pool: v.poolAddress })),
            },
            'fabric-pair-registered',
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ chainId: chainCfg.chainId, pairId: pair.id, err: message }, 'fabric-pair-register-failed');
        }
      }
    }
    log.info({ pairs: this.pairs.length }, 'fabric-pair-registry-ready');
  }

  getPairs(): readonly PairRuntime[] {
    return this.pairs;
  }

  private async buildPairRuntime(
    chainCfg: FabricChainConfig,
    pair: PairConfig,
    chain: ChainCfg,
    client: ReturnType<typeof getPublicClient>,
  ): Promise<PairRuntime> {
    const baseToken = tokenInfoOrThrow(chain, pair.baseToken);
    const quoteToken = tokenInfoOrThrow(chain, pair.quoteToken);
    const tradeSizeBase = parseTokenAmount(pair.tradeSize.baseAmount, baseToken.decimals);
    const venues: VenueRuntime[] = [];
    for (const venue of pair.venues) {
      if (venue.kind !== 'uniswap_v3') {
        throw new Error(`Unsupported venue kind ${(venue as any)?.kind ?? 'unknown'}`);
      }
      const factoryAddress = (venue.factory ?? UNISWAP_V3_FACTORY) as Address;
      const quoterAddress = (venue.quoter ?? chain.quoter) as Address | undefined;
      if (!quoterAddress) {
        throw new Error(`No quoter configured for venue ${venue.id} on chain ${chain.id}`);
      }
      const [token0, token1] = sortTokens(baseToken.address, quoteToken.address);
      const poolAddress = (await client.readContract({
        address: factoryAddress,
        abi: UNISWAP_FACTORY_ABI,
        functionName: 'getPool',
        args: [token0, token1, venue.feeBps],
      })) as Address;
      if (poolAddress === '0x0000000000000000000000000000000000000000') {
        throw new Error(`Pool not found for ${pair.id} venue ${venue.id}`);
      }
      venues.push({
        config: venue,
        poolAddress,
        quoter: quoterAddress,
        tokenIn: baseToken,
        tokenOut: quoteToken,
        token0,
        token1,
      });
    }
    return {
      config: pair,
      fabricChain: chainCfg,
      chain,
      baseToken,
      quoteToken,
      tradeSizeBase,
      venues,
    };
  }
}

function sortTokens(a: `0x${string}`, b: `0x${string}`): [`0x${string}`, `0x${string}`] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}
