import { getAddress } from "viem";
import { z } from "zod";
import { EvmAddressSchema } from "../infra/address";

// Define the schema for a Morpho Blue market
export const MorphoMarketSchema = z.object({
  loanToken: EvmAddressSchema,
  collateralToken: EvmAddressSchema,
  oracle: EvmAddressSchema,
  irm: EvmAddressSchema,
  lltv: z.bigint(),
});

export type MorphoMarket = z.infer<typeof MorphoMarketSchema>;

// Define the schema for a Morpho position
export const MorphoPositionSchema = z.object({
  market: MorphoMarketSchema,
  user: EvmAddressSchema,
  healthFactor: z.number(),
  collateral: z.bigint(),
  debt: z.bigint(),
});

export type MorphoPosition = z.infer<typeof MorphoPositionSchema>;

export const getMarketId = (market: MorphoMarket): string => {
  return `${getAddress(market.loanToken)}-${getAddress(
    market.collateralToken
  )}-${getAddress(market.oracle)}-${getAddress(market.irm)}-${market.lltv}`;
};
