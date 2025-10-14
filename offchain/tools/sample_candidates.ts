import '../infra/env';
import { loadConfig } from '../infra/config';
import { streamCandidates } from '../indexer/aave_indexer';

const chainArg = process.argv[2];
const limitArg = process.argv[3];
const chainId = chainArg ? Number(chainArg) : Number(process.env.CHAIN_ID ?? NaN);
const limit = limitArg ? Number(limitArg) : Number(process.env.CANDIDATE_LIMIT ?? 200);

if (Number.isNaN(limit) || limit <= 0) {
  throw new Error('candidate limit must be a positive number');
}

async function main() {
  const cfg = loadConfig();

  if (!Number.isNaN(chainId) && chainId > 0) {
    for (const chain of cfg.chains) {
      chain.enabled = chain.id === chainId;
    }
    for (const market of cfg.markets ?? []) {
      market.enabled = market.chainId === chainId;
    }
  }

  const counts = new Map<string, number>();
  const combos = new Map<string, number>();
  const borrowers = new Set<string>();
  let total = 0;

  for await (const candidate of streamCandidates(cfg)) {
    if (!Number.isNaN(chainId) && chainId > 0 && candidate.chainId !== chainId) continue;

    total += 1;
    borrowers.add(candidate.borrower);

    const debtKey = `${candidate.chainId}:${candidate.debt.symbol}`;
    counts.set(debtKey, (counts.get(debtKey) ?? 0) + 1);

    const comboKey = `${candidate.chainId}:${candidate.debt.symbol}->${candidate.collateral.symbol}`;
    combos.set(comboKey, (combos.get(comboKey) ?? 0) + 1);

    if (total >= limit) break;
  }

  console.log('total candidates sampled:', total);
  console.log('unique borrowers:', borrowers.size);
  console.log('debt counts:', Array.from(counts.entries()).sort((a, b) => b[1] - a[1]));
  console.log('top combos:', Array.from(combos.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
