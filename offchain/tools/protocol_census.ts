import { format } from 'node:util';
import type { Candidate } from '../indexer/aave_indexer';
import { loadConfig, type AppConfig, type ChainCfg } from '../infra/config';
import { listProtocolAdapters } from '../protocols/registry';
import type { ProtocolAdapter } from '../protocols/types';

type CliOptions = {
  limit: number;
  protocol?: string;
  chain?: number;
};

type ProtocolSummary = {
  protocol: string;
  chainId: number;
  chainName: string;
  markets: number;
  candidates: number;
  minHealthFactor?: number;
  medianHealthFactor?: number;
  maxDebtUsd?: number;
  topBorrowers: Array<{ borrower: string; debtSymbol: string; debtAmount: number }>;
  notes?: string;
};

const DEFAULT_LIMIT = Number(process.env.CENSUS_LIMIT ?? 500);

function parseArgs(): CliOptions {
  const opts: CliOptions = { limit: DEFAULT_LIMIT };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--limit=')) {
      const value = Number(arg.split('=')[1]);
      if (Number.isFinite(value) && value > 0) opts.limit = value;
    } else if (arg.startsWith('--protocol=')) {
      opts.protocol = arg.split('=')[1].toLowerCase();
    } else if (arg.startsWith('--chain=')) {
      const value = Number(arg.split('=')[1]);
      if (Number.isFinite(value) && value > 0) opts.chain = value;
    }
  }
  return opts;
}

function computeMedian(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function summarizeCandidates(
  candidates: Candidate[],
): {
  minHealthFactor?: number;
  medianHealthFactor?: number;
  topBorrowers: Array<{ borrower: string; debtSymbol: string; debtAmount: number }>;
} {
  if (candidates.length === 0) {
    return { topBorrowers: [] };
  }
  const hfs = candidates
    .map((c) => Number.isFinite(c.healthFactor) ? c.healthFactor : undefined)
    .filter((hf): hf is number => hf !== undefined);
  const minHealthFactor = hfs.length > 0 ? Math.min(...hfs) : undefined;
  const medianHealthFactor = computeMedian(hfs);

  const topBorrowers = [...candidates]
    .map((candidate) => {
      const amount = Number(candidate.debt.amount) / 10 ** candidate.debt.decimals;
      return {
        borrower: candidate.borrower,
        debtSymbol: candidate.debt.symbol,
        debtAmount: amount,
      };
    })
    .sort((a, b) => b.debtAmount - a.debtAmount)
    .slice(0, 5);

  return { minHealthFactor, medianHealthFactor, topBorrowers };
}

function describeTopBorrowers(topBorrowers: Array<{ borrower: string; debtSymbol: string; debtAmount: number }>): string {
  if (topBorrowers.length === 0) return '–';
  return topBorrowers
    .map((entry) => {
      const amount = entry.debtAmount >= 1
        ? `${entry.debtAmount.toFixed(2)}`
        : entry.debtAmount.toExponential(2);
      return `${entry.borrower.slice(0, 8)}… (${amount} ${entry.debtSymbol})`;
    })
    .join(', ');
}

type CensusResult = {
  candidates: Candidate[];
  notes?: string;
};

const MORPHO_DEFAULT_GRAPH = process.env.MORPHO_BLUE_GRAPHQL_ENDPOINT?.trim()
  || 'https://blue-api.morpho.org/graphql';

const MORPHO_MAX_COMPLEXITY = Number(process.env.MORPHO_CENSUS_MAX_COMPLEXITY ?? 900);
const MORPHO_HEALTH_FACTOR = Number(process.env.MORPHO_CENSUS_HF ?? 1.1);

async function collectMorphoBlue(cfg: AppConfig, chain: ChainCfg, limit: number): Promise<CensusResult> {
  if (!MORPHO_DEFAULT_GRAPH) {
    return { candidates: [], notes: 'morpho-graphql-endpoint-missing' };
  }
  try {
    const body = {
      query: `query MarketPositionCensus($first:Int!, $chainIds:[Int!], $hf:Float!){
        marketPositions(first:$first, where:{chainId_in:$chainIds, healthFactor_lte:$hf}){
          items {
            id
            healthFactor
            user { address }
            market {
              uniqueKey
              loanAsset { symbol decimals address }
              collateralAsset { symbol decimals address }
            }
            state {
              borrowAssets
              collateral
            }
          }
        }
      }`,
      variables: {
        first: Math.max(1, Math.min(limit, 100)),
        chainIds: [chain.id],
        hf: MORPHO_HEALTH_FACTOR,
      },
    };

    const response = await fetch(MORPHO_DEFAULT_GRAPH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-apollo-operation-name': 'MarketPositionCensus',
      },
      body: JSON.stringify(body),
    });

    const json = await response.json() as any;
    if (json.errors?.length) {
      const message = json.errors.map((e: any) => e.message).join('; ');
      if (json.extensions?.complexity && json.extensions?.complexity > MORPHO_MAX_COMPLEXITY) {
        return { candidates: [], notes: `morpho-query-too-complex (${json.extensions?.complexity})` };
      }
      return { candidates: [], notes: `morpho-query-error: ${message}` };
    }

    const items = json.data?.marketPositions?.items ?? [];
    const candidates: Candidate[] = items.map((item: any) => {
      const debtDecimals = Number(item.market?.loanAsset?.decimals ?? 18);
      const collateralDecimals = Number(item.market?.collateralAsset?.decimals ?? 18);
      const borrowRaw = BigInt(item.state?.borrowAssets ?? '0');
      const collateralRaw = BigInt(item.state?.collateral ?? '0');
      return {
        borrower: (item.user?.address ?? '0x').toLowerCase() as `0x${string}`,
        chainId: chain.id,
        healthFactor: Number(item.healthFactor ?? 0),
        debt: {
          symbol: item.market?.loanAsset?.symbol ?? 'UNKNOWN',
          address: (item.market?.loanAsset?.address ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
          decimals: debtDecimals,
          amount: borrowRaw,
        },
        collateral: {
          symbol: item.market?.collateralAsset?.symbol ?? 'UNKNOWN',
          address: (item.market?.collateralAsset?.address ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
          decimals: collateralDecimals,
          amount: collateralRaw,
        },
        protocol: 'morphoblue',
      } satisfies Candidate;
    });

    return { candidates };
  } catch (err) {
    return { candidates: [], notes: `morpho-fetch-error: ${(err as Error).message}` };
  }
}

const protocolCollectors: Record<string, (cfg: AppConfig, chain: ChainCfg, limit: number) => Promise<CensusResult>> = {
  morphoblue: collectMorphoBlue,
  compoundv3: async () => ({ candidates: [], notes: 'compoundv3-census-todo' }),
  silo: async () => ({ candidates: [], notes: 'silo-census-todo' }),
  ionic: async () => ({ candidates: [], notes: 'ionic-census-todo' }),
};

async function run(): Promise<void> {
  const opts = parseArgs();
  const cfg = loadConfig();
  const adapters = listProtocolAdapters();
  const adapterMap = new Map<ProtocolAdapter['key'], ProtocolAdapter>();
  adapters.forEach((adapter) => adapterMap.set(adapter.key, adapter));

  const summaries: ProtocolSummary[] = [];

  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    if (opts.chain && chain.id !== opts.chain) continue;

    const protocolKeys = new Set(
      cfg.markets
        .filter((m) => m.enabled && m.chainId === chain.id)
        .map((m) => m.protocol),
    );

    for (const protocol of protocolKeys) {
      if (opts.protocol && protocol !== opts.protocol) continue;
      const collector = protocolCollectors[protocol];
      if (collector) {
        const result = await collector(cfg, chain, opts.limit);
        const { minHealthFactor, medianHealthFactor, topBorrowers } = summarizeCandidates(result.candidates);
        summaries.push({
          protocol,
          chainId: chain.id,
          chainName: chain.name,
          markets: cfg.markets.filter((m) => m.enabled && m.chainId === chain.id && m.protocol === protocol).length,
          candidates: result.candidates.length,
          minHealthFactor,
          medianHealthFactor,
          topBorrowers,
          notes: result.notes,
        });
        continue;
      }

      const adapter = adapterMap.get(protocol);
      if (!adapter) {
        summaries.push({
          protocol,
          chainId: chain.id,
          chainName: chain.name,
          markets: cfg.markets.filter((m) => m.enabled && m.chainId === chain.id && m.protocol === protocol).length,
          candidates: 0,
          topBorrowers: [],
          notes: 'adapter-missing',
        });
        continue;
      }

      try {
        const candidates = await adapter.pollCandidatesOnce(cfg, chain, opts.limit);
        const { minHealthFactor, medianHealthFactor, topBorrowers } = summarizeCandidates(candidates);
        summaries.push({
          protocol,
          chainId: chain.id,
          chainName: chain.name,
          markets: cfg.markets.filter((m) => m.enabled && m.chainId === chain.id && m.protocol === protocol).length,
          candidates: candidates.length,
          minHealthFactor,
          medianHealthFactor,
          topBorrowers,
        });
      } catch (err) {
        summaries.push({
          protocol,
          chainId: chain.id,
          chainName: chain.name,
          markets: cfg.markets.filter((m) => m.enabled && m.chainId === chain.id && m.protocol === protocol).length,
          candidates: 0,
          topBorrowers: [],
          notes: `error: ${(err as Error).message}`,
        });
      }
    }
  }

  summaries.sort((a, b) => a.protocol.localeCompare(b.protocol) || a.chainId - b.chainId);

  console.log('Protocol Census Summary');
  console.log('='.repeat(80));
  console.log(
    format(
      '%-12s %-10s %-8s %-10s %-10s %-10s %s',
      'Protocol',
      'Chain',
      'Markets',
      'Candidates',
      'Min HF',
      'Median HF',
      'Top Borrowers',
    ),
  );
  console.log('-'.repeat(120));

  for (const summary of summaries) {
    const minHf = summary.minHealthFactor !== undefined ? summary.minHealthFactor.toFixed(4) : '–';
    const medianHf = summary.medianHealthFactor !== undefined ? summary.medianHealthFactor.toFixed(4) : '–';
    const borrowerDesc = summary.topBorrowers?.length
      ? describeTopBorrowers(summary.topBorrowers)
      : summary.notes ?? '–';

    console.log(
      format(
        '%-12s %-10s %-8d %-10d %-10s %-10s %s',
        summary.protocol,
        `${summary.chainName}(${summary.chainId})`,
        summary.markets,
        summary.candidates,
        minHf,
        medianHf,
        borrowerDesc,
      ),
    );
  }

  console.log('-'.repeat(120));
  console.log(
    format(
      'Scanned %d chain(s), %d protocol(s). Use --limit=###, --protocol=name, --chain=id to refine.',
      new Set(summaries.map((s) => s.chainId)).size,
      new Set(summaries.map((s) => s.protocol)).size,
    ),
  );
}

run().catch((err) => {
  console.error('protocol-census-failed', err);
  process.exit(1);
});
