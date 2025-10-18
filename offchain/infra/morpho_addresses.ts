/**
 * Morpho Blue & Bundler Contract Addresses
 * 
 * Sources:
 * - Morpho Blue: https://github.com/morpho-org/morpho-blue-deployment
 * - Bundlers: https://github.com/morpho-org/morpho-blue-bundlers
 */

export const MORPHO_BLUE_ADDRESSES = {
  // Morpho Blue Main Contract
  morpho: {
    ethereum: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const,
    base: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const,
    arbitrum: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const,
    optimism: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const,
    polygon: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const,
  },
  
  // Bundler3 (ChainAgnosticBundlerV2)
  bundler3: {
    ethereum: '0x4095F064B8d3c3548A3bebfd0Bbfd04750E30077' as const,
    base: '0x23055618898e202386e6c13955a58D3C68200BFB' as const,
    arbitrum: '0x23055618898e202386e6c13955a58D3C68200BFB' as const,
    optimism: '0x23055618898e202386e6c13955a58D3C68200BFB' as const,
    polygon: '0x23055618898e202386e6c13955a58D3C68200BFB' as const,
  },
  
  // Note: PreLiquidation contracts don't exist yet - this is new infrastructure
  // These are placeholder addresses that need to be deployed
  preLiqFactory: {
    base: '0x0000000000000000000000000000000000000000' as const, // TODO: Deploy PreLiquidationFactory
    arbitrum: '0x0000000000000000000000000000000000000000' as const,
    optimism: '0x0000000000000000000000000000000000000000' as const,
  },
} as const;

// Odos Router V2 addresses
export const ODOS_ROUTER_V2 = {
  ethereum: '0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559' as const,
  base: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1' as const,
  arbitrum: '0xa669e7A0d4b3e4Fa48af2dE86BD4CD7126Be4e13' as const,
  optimism: '0xCa423977156BB05b13A2BA3b76Bc5419E2fE9680' as const,
  polygon: '0x4E3288c9ca110bCC82bf38F09A7b425c095d92Bf' as const,
} as const;

// 1inch V5 Router addresses
export const ONEINCH_V5_ROUTER = {
  ethereum: '0x1111111254EEB25477B68fb85Ed929f73A960582' as const,
  base: '0x1111111254EEB25477B68fb85Ed929f73A960582' as const,
  arbitrum: '0x1111111254EEB25477B68fb85Ed929f73A960582' as const,
  optimism: '0x1111111254EEB25477B68fb85Ed929f73A960582' as const,
  polygon: '0x1111111254EEB25477B68fb85Ed929f73A960582' as const,
} as const;

// Public Allocator API endpoints (for liquidity intelligence)
export const PUBLIC_ALLOCATOR_API = {
  ethereum: 'https://api.morpho.org/public-allocator/ethereum' as const,
  base: 'https://api.morpho.org/public-allocator/base' as const,
  arbitrum: 'https://api.morpho.org/public-allocator/arbitrum' as const,
  optimism: 'https://api.morpho.org/public-allocator/optimism' as const,
} as const;
