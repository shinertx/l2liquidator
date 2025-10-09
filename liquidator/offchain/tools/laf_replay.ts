/* eslint-disable no-console */
import fs from 'fs';
import readline from 'readline';

type ReplayOptions = {
  file: string;
  minNet?: number;
};

type EdgeRecord = {
  source?: string;
  estNetUsd?: number;
  estGasUsd?: number;
  risk?: { pnlMultiple?: number };
  metadata?: Record<string, unknown>;
  createdAtMs?: number;
};

function parseArgs(): ReplayOptions {
  const args = process.argv.slice(2);
  let file = '';
  let minNet = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === '-f' || arg === '--file') && args[i + 1]) {
      file = args[i + 1];
      i += 1;
    } else if ((arg === '-n' || arg === '--min-net') && args[i + 1]) {
      minNet = Number(args[i + 1]);
      i += 1;
    }
  }
  if (!file) {
    throw new Error('usage: ts-node --transpile-only offchain/tools/laf_replay.ts --file path/to/log.jsonl');
  }
  return { file, minNet };
}

type Summary = {
  count: number;
  totalNet: number;
  medianNet: number;
  totalGas: number;
  countPnl4x: number;
  maxNet: number;
  minNet: number;
  perPair: Map<string, number>;
};

async function replay(opts: ReplayOptions): Promise<void> {
  const rl = readline.createInterface({
    input: fs.createReadStream(opts.file, 'utf8'),
    crlfDelay: Infinity,
  });

  const perSource = new Map<string, Summary>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    let parsed: EdgeRecord | undefined;
    try {
      parsed = JSON.parse(line) as EdgeRecord;
    } catch (err) {
      continue;
    }
    if (!parsed || parsed.estNetUsd === undefined) continue;
    if (parsed.estNetUsd < opts.minNet) continue;
    const source = parsed.source ?? 'unknown';
    const summary = ensureSummary(perSource, source);
    summary.count += 1;
    summary.totalNet += parsed.estNetUsd ?? 0;
    summary.totalGas += parsed.estGasUsd ?? 0;
    const pnl = parsed.risk?.pnlMultiple ?? 0;
    if (pnl >= 4) summary.countPnl4x += 1;
    summary.maxNet = Math.max(summary.maxNet, parsed.estNetUsd ?? 0);
    summary.minNet = Math.min(summary.minNet, parsed.estNetUsd ?? summary.minNet);
    summary.perPair.set(
      String(parsed.metadata?.pairId ?? parsed.metadata?.primaryPairId ?? 'unknown'),
      (summary.perPair.get(String(parsed.metadata?.pairId ?? parsed.metadata?.primaryPairId ?? 'unknown')) ?? 0) + 1,
    );
  }

  for (const [source, summary] of perSource) {
    const avgNet = summary.totalNet / Math.max(1, summary.count);
    const avgGas = summary.totalGas / Math.max(1, summary.count);
    console.log(`Source=${source}`);
    console.log(`  count=${summary.count}`);
    console.log(`  totalNet=${summary.totalNet.toFixed(2)} avgNet=${avgNet.toFixed(2)}`);
    console.log(`  totalGas=${summary.totalGas.toFixed(2)} avgGas=${avgGas.toFixed(2)}`);
    console.log(`  maxNet=${summary.maxNet.toFixed(2)} minNet=${summary.minNet.toFixed(2)}`);
    console.log(`  >=4x=${summary.countPnl4x}`);
    console.log('  Top pairs:');
    const topPairs = [...summary.perPair.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [pairId, count] of topPairs) {
      console.log(`    ${pairId}: ${count}`);
    }
  }
}

function ensureSummary(map: Map<string, Summary>, key: string): Summary {
  const existing = map.get(key);
  if (existing) return existing;
  const created: Summary = {
    count: 0,
    totalNet: 0,
    medianNet: 0,
    totalGas: 0,
    countPnl4x: 0,
    maxNet: Number.NEGATIVE_INFINITY,
    minNet: Number.POSITIVE_INFINITY,
    perPair: new Map(),
  };
  map.set(key, created);
  return created;
}

replay(parseArgs()).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
