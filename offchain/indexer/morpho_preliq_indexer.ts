import type { AppConfig, ChainCfg } from '../infra/config';
import type { Candidate } from './aave_indexer';
import { createPublicClient, http, parseAbiItem, type Address, type Log, type Hash, encodeAbiParameters, keccak256, getCreate2Address } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';

// Morpho Blue main contract (same address across all chains)
const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;

// PreLiquidation Factory addresses - TODO: Deploy these contracts
const PRELIQ_FACTORY = {
  [base.id]: '0x0000000000000000000000000000000000000000' as Address,
  [arbitrum.id]: '0x0000000000000000000000000000000000000000' as Address,
  [optimism.id]: '0x0000000000000000000000000000000000000000' as Address,
} as const;

const POLL_INTERVAL_MS = Number(process.env.MORPHO_PRELIQ_POLL_MS ?? 10_000);
const BLOCK_LOOKBACK = Number(process.env.MORPHO_PRELIQ_LOOKBACK_BLOCKS ?? 1000);
const MAX_HEALTH_FACTOR = 1.05;

type PreLiqOffer = {
  offerAddress: Address;
  borrower: Address;
  chainId: number;
  marketId: Hash;
  preLLTV: bigint;
  preLCF1: bigint;
  preLCF2: bigint;
  preLIF1: bigint;
  preLIF2: bigint;
  oracleAddress: Address;
  expiry: bigint;
  createdAt: bigint;
  authorized: boolean;
};

type PreLiqCandidate = Candidate & {
  preliq: {
    offerAddress: Address;
    effectiveCloseFactor: number;
    effectiveLiquidationIncentive: number;
    oracleAddress: Address;
    expiry: bigint;
  };
};

const PRELIQ_CREATED_EVENT = parseAbiItem(
  'event PreLiquidationCreated(address indexed borrower, bytes32 indexed marketId, address offer)'
);

function getFactoryAddress(chainId: number): Address {
  return PRELIQ_FACTORY[chainId as keyof typeof PRELIQ_FACTORY] || ('0x0000000000000000000000000000000000000000' as Address);
}

function getViemChain(chainId: number) {
  if (chainId === base.id) return base;
  if (chainId === arbitrum.id) return arbitrum;
  if (chainId === optimism.id) return optimism;
  throw new Error(`Unsupported chain: ${chainId}`);
}

/**
 * Compute pre-liquidation offer address via CREATE2
 */
function computeOfferAddress(borrower: Address, marketId: Hash, chainId: number): Address {
  const factory = getFactoryAddress(chainId);
  
  if (factory === '0x0000000000000000000000000000000000000000') {
    // Factory not deployed yet - return zero address
    return '0x0000000000000000000000000000000000000000' as Address;
  }
  
  // Salt = keccak256(abi.encode(borrower, marketId))
  const salt = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32' }],
      [borrower, marketId]
    )
  );
  
  // TODO: Replace with actual initCodeHash from deployed PreLiquidation contract
  // Get via: keccak256(abi.encodePacked(type(PreLiquidation).creationCode, abi.encode(constructorArgs)))
  // For now using placeholder - MUST UPDATE after contract deployment
  const initCodeHash = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hash;
  
  if (initCodeHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    // InitCodeHash not set - return zero address
    return '0x0000000000000000000000000000000000000000' as Address;
  }
  
  return getCreate2Address({
    from: factory,
    salt,
    bytecodeHash: initCodeHash,
  });
}

/**
 * Fetch offer parameters from on-chain contract
 */
async function fetchOfferParams(offerAddress: Address, chainId: number): Promise<Partial<PreLiqOffer> | null> {
  if (offerAddress === '0x0000000000000000000000000000000000000000') return null;
  
  const chain = getViemChain(chainId);
  const rpcUrl = process.env[`RPC_${chain.name.toUpperCase()}`] || chain.rpcUrls.default.http[0];
  
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  
  try {
    // Read all offer parameters in parallel
    const [preLLTV, preLCF1, preLCF2, preLIF1, preLIF2, oracle, expiry] = await Promise.all([
      client.readContract({
        address: offerAddress,
        abi: [parseAbiItem('function preLLTV() view returns (uint256)')],
        functionName: 'preLLTV',
      }),
      client.readContract({
        address: offerAddress,
        abi: [parseAbiItem('function preLCF1() view returns (uint256)')],
        functionName: 'preLCF1',
      }),
      client.readContract({
        address: offerAddress,
        abi: [parseAbiItem('function preLCF2() view returns (uint256)')],
        functionName: 'preLCF2',
      }),
      client.readContract({
        address: offerAddress,
        abi: [parseAbiItem('function preLIF1() view returns (uint256)')],
        functionName: 'preLIF1',
      }),
      client.readContract({
        address: offerAddress,
        abi: [parseAbiItem('function preLIF2() view returns (uint256)')],
        functionName: 'preLIF2',
      }),
      client.readContract({
        address: offerAddress,
        abi: [parseAbiItem('function oracle() view returns (address)')],
        functionName: 'oracle',
      }),
      client.readContract({
        address: offerAddress,
        abi: [parseAbiItem('function expiry() view returns (uint256)')],
        functionName: 'expiry',
      }),
    ]);
    
    return {
      preLLTV: preLLTV as bigint,
      preLCF1: preLCF1 as bigint,
      preLCF2: preLCF2 as bigint,
      preLIF1: preLIF1 as bigint,
      preLIF2: preLIF2 as bigint,
      oracleAddress: oracle as Address,
      expiry: expiry as bigint,
    };
  } catch (error) {
    console.error(`Failed to fetch offer params for ${offerAddress}: ${error}`);
    return null;
  }
}

/**
 * Check if borrower has authorized this offer on Morpho
 */
async function checkAuthorization(borrower: Address, offerAddress: Address, chainId: number): Promise<boolean> {
  if (offerAddress === '0x0000000000000000000000000000000000000000') return false;
  
  const chain = getViemChain(chainId);
  const rpcUrl = process.env[`RPC_${chain.name.toUpperCase()}`] || chain.rpcUrls.default.http[0];
  
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  
  try {
    // Call Morpho.isAuthorized(borrower, offerAddress)
    const authorized = await client.readContract({
      address: MORPHO_BLUE,
      abi: parseAbiItem('function isAuthorized(address, address) view returns (bool)') as any,
      functionName: 'isAuthorized',
      args: [borrower, offerAddress],
    });
    return authorized as boolean;
  } catch (error) {
    console.error(`Failed to check authorization: ${error}`);
    return false;
  }
}

/**
 * Calculate effective close factor and incentive based on current health factor
 * Linear ramp: HF 1.0 → use CF1/IF1, HF 1.05 → use CF2/IF2
 */
function calculateEffectiveParams(
  healthFactor: number,
  preLCF1: bigint,
  preLCF2: bigint,
  preLIF1: bigint,
  preLIF2: bigint
): { effectiveCF: number; effectiveIF: number } {
  const minHF = 1.0;
  const maxHF = MAX_HEALTH_FACTOR;
  
  // Clamp health factor
  const hf = Math.max(minHF, Math.min(maxHF, healthFactor));
  
  // Linear interpolation: t = (hf - 1.0) / (1.05 - 1.0) = (hf - 1.0) / 0.05
  const t = (hf - minHF) / (maxHF - minHF);
  
  // Interpolate close factor (in WAD, 1e18 = 100%)
  const cf1 = Number(preLCF1) / 1e18;
  const cf2 = Number(preLCF2) / 1e18;
  const effectiveCF = cf1 + t * (cf2 - cf1);
  
  // Interpolate incentive factor
  const if1 = Number(preLIF1) / 1e18;
  const if2 = Number(preLIF2) / 1e18;
  const effectiveIF = if1 + t * (if2 - if1);
  
  return { effectiveCF, effectiveIF };
}

/**
 * Discover pre-liquidation offers from factory events
 */
async function discoverPreLiqOffers(chainId: number, fromBlock: bigint, toBlock: bigint): Promise<PreLiqOffer[]> {
  const factory = getFactoryAddress(chainId);
  if (factory === '0x0000000000000000000000000000000000000000') {
    // Factory not deployed - skip for now
    return [];
  }
  
  const chain = getViemChain(chainId);
  const rpcUrl = process.env[`RPC_${chain.name.toUpperCase()}`] || chain.rpcUrls.default.http[0];
  
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  
  try {
    const logs = await client.getLogs({
      address: factory,
      event: PRELIQ_CREATED_EVENT,
      fromBlock,
      toBlock,
    });
    
    const offers: PreLiqOffer[] = [];
    
    for (const log of logs) {
      const { borrower, marketId, offer } = log.args as { borrower: Address; marketId: Hash; offer: Address };
      
      // Fetch offer parameters
      const params = await fetchOfferParams(offer, chainId);
      if (!params) continue;
      
      // Check authorization
      const authorized = await checkAuthorization(borrower, offer, chainId);
      
      offers.push({
        offerAddress: offer,
        borrower,
        chainId,
        marketId,
        preLLTV: params.preLLTV!,
        preLCF1: params.preLCF1!,
        preLCF2: params.preLCF2!,
        preLIF1: params.preLIF1!,
        preLIF2: params.preLIF2!,
        oracleAddress: params.oracleAddress!,
        expiry: params.expiry!,
        createdAt: log.blockNumber || 0n,
        authorized,
      });
    }
    
    return offers;
  } catch (error) {
    console.error(`Failed to discover pre-liq offers on chain ${chainId}: ${error}`);
    return [];
  }
}

/**
 * Convert PreLiqOffer + position data into scorable PreLiqCandidate
 */
function createPreLiqCandidate(
  offer: PreLiqOffer,
  position: any, // TODO: Get position data from Morpho
  healthFactor: number
): PreLiqCandidate {
  const { effectiveCF, effectiveIF } = calculateEffectiveParams(
    healthFactor,
    offer.preLCF1,
    offer.preLCF2,
    offer.preLIF1,
    offer.preLIF2
  );
  
  // TODO: Construct full candidate object with position data
  return {
    ...position,
    preliq: {
      offerAddress: offer.offerAddress,
      effectiveCloseFactor: effectiveCF,
      effectiveLiquidationIncentive: effectiveIF,
      oracleAddress: offer.oracleAddress,
      expiry: offer.expiry,
    },
  } as PreLiqCandidate;
}

/**
 * Main polling loop for pre-liquidation offer discovery
 */
export async function pollPreLiqOffers(cfg: AppConfig, onCandidate: (c: PreLiqCandidate) => void) {
  const blockTracking: Record<number, bigint> = {};
  
  for (const chainCfg of Object.values(cfg.chains)) {
    blockTracking[chainCfg.id] = 0n;
  }
  
  console.log('[PreLiq] Starting pre-liquidation offer discovery...');
  console.log('[PreLiq] WARNING: Factory contracts not deployed yet - discovery disabled');
  console.log('[PreLiq] To enable: Deploy PreLiquidationFactory contracts and update PRELIQ_FACTORY addresses');
  
  while (true) {
    try {
      for (const chainCfg of Object.values(cfg.chains)) {
        const factory = getFactoryAddress(chainCfg.id);
        if (factory === '0x0000000000000000000000000000000000000000') {
          // Skip chains without deployed factory
          continue;
        }
        
        const chain = getViemChain(chainCfg.id);
        const rpcUrl = process.env[`RPC_${chain.name.toUpperCase()}`] || chain.rpcUrls.default.http[0];
        
        const client = createPublicClient({
          chain,
          transport: http(rpcUrl),
        });
        
        const latestBlock = await client.getBlockNumber();
        const lastChecked = blockTracking[chainCfg.id] || latestBlock - BigInt(BLOCK_LOOKBACK);
        
        if (latestBlock > lastChecked) {
          const offers = await discoverPreLiqOffers(chainCfg.id, lastChecked + 1n, latestBlock);
          
          console.log(`[PreLiq] Chain ${chainCfg.id}: Found ${offers.length} new offers (blocks ${lastChecked}-${latestBlock})`);
          
          for (const offer of offers) {
            // TODO: Fetch position data and health factor
            // For now, skip candidate creation until we have full integration
            console.log(`[PreLiq] Offer created: ${offer.offerAddress} for borrower ${offer.borrower}`);
          }
          
          blockTracking[chainCfg.id] = latestBlock;
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch (error) {
      console.error(`[PreLiq] Polling error: ${error}`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}
