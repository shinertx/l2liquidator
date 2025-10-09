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
    const sqrtPriceLimit =
      typeof (venue.config as any).sqrtPriceLimitX96 === 'string' ||
      typeof (venue.config as any).sqrtPriceLimitX96 === 'number'
        ? BigInt((venue.config as any).sqrtPriceLimitX96)
        : (venue.config as any).sqrtPriceLimitX96 ?? 0n;

    const [amountOut, sqrtPriceX96After, , gasEstimate] = (await client.readContract({
      address: venue.quoter,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          amountIn,
          fee: (venue.config.kind === 'uniswap_v3' ? venue.config.feeBps : 0) as number,
          sqrtPriceLimitX96: sqrtPriceLimit,
        },
      ],
    })) as readonly [bigint, bigint, number, bigint];

    return {
      amountOut,
      sqrtPriceX96After,
      gasEstimate,
    };
  }
}
