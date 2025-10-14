import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { IMorphoAbi } from "../abis/IMorphoAbi";
import { MorphoMarket, MorphoPosition } from "./morpho_types";

const MORPHO_BLUE_ADDRESS = "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb";

export class MorphoLiquidator {
  private readonly client;

  constructor(rpcUrl: string) {
    this.client = createPublicClient({
      chain: mainnet,
      transport: http(rpcUrl),
    });
  }

  public async getLiquidablePositions(
    markets: MorphoMarket[]
  ): Promise<MorphoPosition[]> {
    // This is a placeholder. In a real implementation, you would need to
    // query the Morpho Blue contract to get all positions for the given
    // markets and then filter for positions with a health factor below 1.
    console.log("Fetching liquidable positions for markets:", markets);
    return [];
  }

  public async liquidate(position: MorphoPosition, seizedAssets: bigint) {
    // This is a placeholder. In a real implementation, you would build and
    // send a transaction to the MorphoBlueLiquidator contract.
    console.log(
      `Liquidating position for user ${position.user} in market ${position.market.loanToken}/${position.market.collateralToken} seizing ${seizedAssets} assets.`
    );
  }
}
