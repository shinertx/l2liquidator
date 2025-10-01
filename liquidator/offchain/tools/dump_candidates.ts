import '../infra/env';
import { loadConfig } from '../infra/config';
import { streamCandidates } from '../indexer/aave_indexer';

async function main() {
  const cfg = loadConfig();
  const counts = new Map<string, number>();
  const byChain = new Map<number, number>();
  const sample: Record<string, Set<string>> = {};

  let total = 0;
  for await (const candidate of streamCandidates(cfg)) {
    total += 1;
    const key = `${candidate.chainId}:${candidate.debt.symbol}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    byChain.set(candidate.chainId, (byChain.get(candidate.chainId) ?? 0) + 1);
    const chainKey = `${candidate.chainId}`;
    if (!sample[chainKey]) sample[chainKey] = new Set();
    if (sample[chainKey].size < 10) {
      sample[chainKey].add(`${candidate.debt.symbol}->${candidate.collateral.symbol}`);
    }
    if (total >= 500) break;
  }

  console.log('total candidates sampled:', total);
  console.log('by chain:', Array.from(byChain.entries()));
  console.log('top debt symbols:');
  for (const [key, count] of Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${key}: ${count}`);
  }
  console.log('sample combos per chain:');
  for (const [chain, combos] of Object.entries(sample)) {
    console.log(`  chain ${chain}: ${Array.from(combos).join(', ')}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});