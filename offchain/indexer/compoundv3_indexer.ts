// Compound V3 (Comet) indexer for liquidation candidates
import { log } from '../infra/logger';
import { AppConfig, ChainCfg } from '../infra/config';
import type { Candidate } from './aave_indexer';

// Compound V3 Comet subgraph query
const QUERY_COMPOUND_V3_ACCOUNTS = `
  query GetLiquidatableAccounts($first: Int!) {
    accounts(
      first: $first,
      orderBy: totalBorrowValue,
      orderDirection: desc,
      where: {
        totalBorrowValue_gt: "0"
      }
    ) {
      id
      address
      totalBorrowValue
      totalCollateralValue
      health
      collateral {
        id
        balance
        asset {
          symbol
          address
        }
      }
      tokens {
        balance
        asset {
          symbol
          address
        }
      }
    }
  }
`;

const SUBGRAPH_URLS: Record<number, string> = {
  42161: 'https://api.thegraph.com/subgraphs/name/compound-finance/compound-v3-arbitrum',
  8453: 'https://api.thegraph.com/subgraphs/name/compound-finance/compound-v3-base',
};

type CompoundAccount = {
  id: string;
  address: string;
  totalBorrowValue: string;
  totalCollateralValue: string;
  health: string;
  collateral: Array<{
    balance: string;
    asset: {
      symbol: string;
      address: string;
    };
  }>;
  tokens: Array<{
    balance: string;
    asset: {
      symbol: string;
      address: string;
    };
  }>;
};

async function fetchCompoundV3Accounts(
  chainId: number,
  subgraphUrl: string,
  maxAccounts: number
): Promise<CompoundAccount[]> {
  try {
    const response = await fetch(subgraphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: QUERY_COMPOUND_V3_ACCOUNTS,
        variables: { first: maxAccounts },
      }),
    });

    if (!response.ok) {
      throw new Error(`Subgraph request failed: ${response.status}`);
    }

    const data = await response.json();
    return data?.data?.accounts || [];
  } catch (error) {
    log.error({ chainId, error: (error as Error).message }, 'compound-v3-subgraph-fetch-failed');
    return [];
  }
}

function convertToCandidate(
  account: CompoundAccount,
  chainId: number,
  comet: string
): Candidate | null {
  try {
    // Parse health factor (Compound uses health where <1 = liquidatable)
    const health = parseFloat(account.health);
    if (isNaN(health) || health >= 1.0) {
      return null; // Not liquidatable
    }

    // Find largest collateral position
    const collaterals = account.collateral.filter(c => parseFloat(c.balance) > 0);
    if (collaterals.length === 0) return null;

    // Sort by balance and take largest
    const largestCollateral = collaterals.sort((a, b) => 
      parseFloat(b.balance) - parseFloat(a.balance)
    )[0];

    // Find debt position (base asset borrowed)
    const debts = account.tokens.filter(t => parseFloat(t.balance) < 0);
    if (debts.length === 0) return null;

    const debtPosition = debts[0]; // Usually only one debt asset in Compound V3
    const debtAmount = BigInt(Math.abs(parseFloat(debtPosition.balance)));

    const collateralAmount = BigInt(parseFloat(largestCollateral.balance));

    // TODO: Look up decimals from token info
    const candidate: Candidate = {
      borrower: account.address as `0x${string}`,
      chainId,
      protocol: 'compoundv3',
      debt: {
        symbol: debtPosition.asset.symbol,
        address: debtPosition.asset.address as `0x${string}`,
        decimals: 18, // TODO: fetch actual decimals
        amount: debtAmount,
      },
      collateral: {
        symbol: largestCollateral.asset.symbol,
        address: largestCollateral.asset.address as `0x${string}`,
        decimals: 18, // TODO: fetch actual decimals
        amount: collateralAmount,
      },
      healthFactor: health,
    };

    return candidate;
  } catch (error) {
    log.error({ error: (error as Error).message, account: account.id }, 'compound-v3-candidate-conversion-failed');
    return null;
  }
}

export async function* streamCompoundV3Candidates(
  cfg: AppConfig
): AsyncGenerator<Candidate> {
  const pollMs = 30_000; // Poll every 30 seconds
  const dedupe = new Map<string, number>();
  const dedupeMs = 120_000; // Dedupe for 2 minutes

  while (true) {
    for (const chain of cfg.chains.filter(c => c.enabled)) {
      const subgraphUrl = SUBGRAPH_URLS[chain.id];
      if (!subgraphUrl) continue;

      const comets = chain.compoundComets;
      if (!comets) continue;

      try {
        const accounts = await fetchCompoundV3Accounts(chain.id, subgraphUrl, 100);
        
        for (const account of accounts) {
          // For each comet market, convert account to candidate
          for (const [cometName, cometAddress] of Object.entries(comets)) {
            const candidate = convertToCandidate(account, chain.id, cometAddress);
            if (!candidate) continue;

            // Dedupe
            const dedupeKey = `${candidate.borrower}:${candidate.debt.address}:${candidate.collateral.address}`;
            const lastSeen = dedupe.get(dedupeKey);
            const now = Date.now();
            if (lastSeen && now - lastSeen < dedupeMs) {
              continue;
            }
            dedupe.set(dedupeKey, now);

            log.debug({
              borrower: candidate.borrower,
              chainId: chain.id,
              comet: cometName,
              health: candidate.healthFactor,
            }, 'compound-v3-candidate');

            yield candidate;
          }
        }
      } catch (error) {
        log.error({ 
          chainId: chain.id, 
          error: (error as Error).message 
        }, 'compound-v3-stream-error');
      }
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

export async function pollCompoundV3CandidatesOnce(
  cfg: AppConfig,
  chain: ChainCfg,
  first = 100
): Promise<Candidate[]> {
  const subgraphUrl = SUBGRAPH_URLS[chain.id];
  if (!subgraphUrl || !chain.compoundComets) return [];

  const accounts = await fetchCompoundV3Accounts(chain.id, subgraphUrl, first);
  const candidates: Candidate[] = [];

  for (const account of accounts) {
    for (const [_, cometAddress] of Object.entries(chain.compoundComets)) {
      const candidate = convertToCandidate(account, chain.id, cometAddress);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}
