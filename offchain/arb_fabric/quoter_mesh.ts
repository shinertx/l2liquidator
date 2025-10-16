import { Address } from 'viem';
import { getPublicClient } from '../infra/rpc_clients';
import { log } from '../infra/logger';
import { PairRegistry, PairRuntime, VenueRuntime } from './pair_registry';
import { VenueQuoteResult } from './types';

const QUOTER_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        internalType: 'struct IQuoterV2.QuoteExactInputSingleParams',
        name: 'params',
        type: 'tuple',
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

export class QuoterMesh {
  private readonly poolSqrtCache = new Map<string, { value: bigint; fetchedAt: number }>();
  private readonly splSaturationBackoff = new Map<string, { until: number; failCount: number; lastLog?: number }>();

  private static readonly MIN_SQRT_RATIO = 4295128739n;
  private static readonly MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
  private static readonly CACHE_TTL_MS = 30_000;
  private static readonly SPL_SATURATION_BACKOFF_MS = 250;
  private static readonly SPL_SATURATION_BACKOFF_MAX_MS = 5_000;
  private static readonly SPL_SATURATION_LOG_COOLDOWN_MS = 1_000;

  constructor(private readonly registry: PairRegistry) {}

  async quotePair(pair: PairRuntime): Promise<Map<string, VenueQuoteResult>> {
    const client = getPublicClient(pair.chain);
    const results = new Map<string, VenueQuoteResult>();
    for (const venue of pair.venues) {
      try {
        const baseOut = await this.quoteExactInput(
          client,
          venue,
          pair.tradeSizeBase,
          venue.tokenIn.address,
          venue.tokenOut.address,
        );
        if (baseOut.amountOut === 0n) {
          log.debug({ pairId: pair.config.id, venue: venue.config.id }, 'fabric-quote-zero-base-to-quote');
          continue;
        }
        const quoteToBase = await this.quoteExactInput(
          client,
          venue,
          baseOut.amountOut,
          venue.tokenOut.address,
          venue.tokenIn.address,
        );
        results.set(venue.config.id, {
          venueId: venue.config.id,
          baseToQuoteOut: baseOut.amountOut,
          quoteToBaseOut: quoteToBase.amountOut,
          gasEstimate: quoteToBase.gasEstimate,
          sqrtPriceAfterBaseToQuote: baseOut.sqrtPriceX96After,
          sqrtPriceAfterQuoteToBase: quoteToBase.sqrtPriceX96After,
          timestampMs: Date.now(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { pairId: pair.config.id, venue: venue.config.id, err: message },
          'fabric-quote-venue-failed',
        );
      }
    }
    return results;
  }

  async quoteExactInput(
    client: ReturnType<typeof getPublicClient>,
    venue: VenueRuntime,
    amountIn: bigint,
    tokenIn: Address,
    tokenOut: Address,
  ): Promise<{
    amountOut: bigint;
    sqrtPriceX96After: bigint;
    gasEstimate: bigint;
  }> {
    const fee = (venue.config.kind === 'uniswap_v3' ? venue.config.feeBps : 0) as number;
    const SCALE_FACTOR = 4n;
    const sqrtPriceLimits = await this.buildSqrtPriceLimits(client, venue, tokenIn, tokenOut);

    const saturationKey = this.buildSaturationKey(venue, tokenIn, tokenOut);
    const now = Date.now();
    const suppressed = this.splSaturationBackoff.get(saturationKey);
    if (suppressed && suppressed.until > now) {
      if (!suppressed.lastLog || now - suppressed.lastLog >= QuoterMesh.SPL_SATURATION_LOG_COOLDOWN_MS) {
        log.debug(
          {
            venue: venue.config.id,
            tokenIn,
            tokenOut,
            retryAtMs: suppressed.until,
            failCount: suppressed.failCount,
          },
          'fabric-quoter-spl-suppressed',
        );
        this.splSaturationBackoff.set(saturationKey, { ...suppressed, lastLog: now });
      }
      return { amountOut: 0n, sqrtPriceX96After: 0n, gasEstimate: 0n };
    }
    if (suppressed && suppressed.until <= now) {
      this.splSaturationBackoff.delete(saturationKey);
    }

    let lastError: unknown;

    for (const sqrtPriceLimit of sqrtPriceLimits) {
      let attemptAmount = amountIn;
      let scaled = false;
      while (attemptAmount > 0n) {
        try {
          const [amountOutRaw, sqrtPriceX96After, , gasEstimate] = (await client.readContract({
            address: venue.quoter,
            abi: QUOTER_ABI,
            functionName: 'quoteExactInputSingle',
            args: [
              {
                tokenIn,
                tokenOut,
                amountIn: attemptAmount,
                fee,
                sqrtPriceLimitX96: sqrtPriceLimit,
              },
            ],
          })) as readonly [bigint, bigint, number, bigint];

          const amountOut = scaled && attemptAmount !== 0n
            ? (amountOutRaw * amountIn) / attemptAmount
            : amountOutRaw;

          if (scaled) {
            log.debug(
              {
                venue: venue.config.id,
                originalAmountIn: amountIn.toString(),
                attemptAmountIn: attemptAmount.toString(),
                scaledAmountOut: amountOut.toString(),
                sqrtPriceLimit: sqrtPriceLimit.toString(),
              },
              'fabric-quoter-scaled-amount',
            );
          }

          this.splSaturationBackoff.delete(saturationKey);

          return {
            amountOut,
            sqrtPriceX96After,
            gasEstimate,
          };
        } catch (err) {
          lastError = err;
          const message = err instanceof Error ? err.message : String(err);
          if (!isRetryableQuoterError(message)) {
            break;
          }
          const nextAmount = attemptAmount / SCALE_FACTOR;
          if (nextAmount === attemptAmount || nextAmount === 0n) {
            if (attemptAmount > 1n) {
              attemptAmount = 1n;
              scaled = true;
              continue;
            }
            break;
          }
          attemptAmount = nextAmount;
          scaled = true;
          continue;
        }
      }
    }

    if (lastError) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      if (isPriceLimitHardFailure(message)) {
        const { failCount, until, backoffMs } = this.registerSaturationFailure(saturationKey);
        log.debug(
          {
            venue: venue.config.id,
            tokenIn,
            tokenOut,
            amountIn: amountIn.toString(),
            message,
            retryAtMs: until,
            backoffMs,
            failCount,
          },
          'fabric-quoter-spl-saturated',
        );
        return { amountOut: 0n, sqrtPriceX96After: 0n, gasEstimate: 0n };
      }
    }

    throw (lastError instanceof Error ? lastError : new Error(String(lastError ?? 'quote failed')));
  }

  private registerSaturationFailure(key: string): { failCount: number; until: number; backoffMs: number } {
    const now = Date.now();
    const previous = this.splSaturationBackoff.get(key);
    const failCount = (previous?.failCount ?? 0) + 1;
    const backoffMs = Math.min(
      QuoterMesh.SPL_SATURATION_BACKOFF_MS * Math.pow(2, failCount - 1),
      QuoterMesh.SPL_SATURATION_BACKOFF_MAX_MS,
    );
    const until = now + backoffMs;
    this.splSaturationBackoff.set(key, { until, failCount, lastLog: now });
    return { failCount, until, backoffMs };
  }

  private buildSaturationKey(venue: VenueRuntime, tokenIn: Address, tokenOut: Address): string {
    return `${venue.config.id}:${tokenIn.toLowerCase()}->${tokenOut.toLowerCase()}`;
  }

  private async buildSqrtPriceLimits(
    client: ReturnType<typeof getPublicClient>,
    venue: VenueRuntime,
    tokenIn: Address,
    tokenOut: Address,
  ): Promise<bigint[]> {
    const candidates: bigint[] = [];

    const configured = (venue.config as any).sqrtPriceLimitX96;
    if (configured !== undefined && configured !== null) {
      const parsed = typeof configured === 'string' || typeof configured === 'number' ? BigInt(configured) : configured;
      candidates.push(parsed);
    }

    candidates.push(0n);

    const tokenInLc = tokenIn.toLowerCase();
    const tokenOutLc = tokenOut.toLowerCase();
    const token0Lc = venue.token0.toLowerCase();
    const token1Lc = venue.token1.toLowerCase();
    const zeroForOne = tokenInLc === token0Lc && tokenOutLc === token1Lc;
    const oneForZero = tokenInLc === token1Lc && tokenOutLc === token0Lc;

    if (zeroForOne) {
      candidates.push(QuoterMesh.MIN_SQRT_RATIO + 1n);
    } else if (oneForZero) {
      candidates.push(QuoterMesh.MAX_SQRT_RATIO - 1n);
    }

    if (zeroForOne || oneForZero) {
      const cacheKey = venue.poolAddress.toLowerCase();
      const cached = this.poolSqrtCache.get(cacheKey);
      const now = Date.now();
      if (cached && now - cached.fetchedAt < QuoterMesh.CACHE_TTL_MS) {
        candidates.push(
          zeroForOne
            ? clamp(cached.value - 1n, QuoterMesh.MIN_SQRT_RATIO + 1n, QuoterMesh.MAX_SQRT_RATIO - 1n)
            : clamp(cached.value + 1n, QuoterMesh.MIN_SQRT_RATIO + 1n, QuoterMesh.MAX_SQRT_RATIO - 1n),
        );
      } else {
        try {
          const [sqrtPriceX96] = (await client.readContract({
            address: venue.poolAddress,
            abi: UNISWAP_V3_POOL_ABI,
            functionName: 'slot0',
          })) as unknown as [bigint];
          this.poolSqrtCache.set(cacheKey, { value: sqrtPriceX96, fetchedAt: now });
          candidates.push(
            zeroForOne
              ? clamp(sqrtPriceX96 - 1n, QuoterMesh.MIN_SQRT_RATIO + 1n, QuoterMesh.MAX_SQRT_RATIO - 1n)
              : clamp(sqrtPriceX96 + 1n, QuoterMesh.MIN_SQRT_RATIO + 1n, QuoterMesh.MAX_SQRT_RATIO - 1n),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.debug(
            {
              venue: venue.config.id,
              pool: venue.poolAddress,
              err: message,
            },
            'fabric-quoter-slot0-failed',
          );
        }
      }
    }

    const filtered = uniqueValues(
      candidates
        .map((value) => clamp(value, QuoterMesh.MIN_SQRT_RATIO + 1n, QuoterMesh.MAX_SQRT_RATIO - 1n))
        .filter((value) => value >= 0n),
    );

    return filtered.length > 0 ? filtered : [0n];
  }
}

function isRetryableQuoterError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('spl') ||
    lower.includes('unexpected error') ||
    lower.includes('insufficient liquidity') ||
    lower.includes('price limit')
  );
}

function isPriceLimitHardFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('spl') || lower.includes('price limit');
}
 
const UNISWAP_V3_POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const;

function clamp(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function uniqueValues(values: bigint[]): bigint[] {
  const seen = new Set<string>();
  const out: bigint[] = [];
  for (const value of values) {
    const key = value.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
