#!/usr/bin/env ts-node
import '../infra/env';
import fs from 'fs';
import path from 'path';
import { loadConfig, chainById, type AppConfig, type ChainCfg } from '../infra/config';
import type { Candidate } from '../indexer/aave_indexer';
import { Scorer } from '../pipeline/scorer';
import type { CandidateSource, QueuedCandidate, ScoredPlan, ScoreRejection } from '../pipeline/types';
import { log } from '../infra/logger';
import { getPublicClient } from '../infra/rpc_clients';
import { lookupToken } from '../util/symbols';
import { liquidatorForChain } from '../infra/config';

const harnessLog = log.child({ module: 'tools.harness' });

type HarnessMode = 'flash' | 'funds' | 'both';

type CliOptions = {
  input: string;
  limit?: number;
  mode: HarnessMode;
  forkRpc?: string;
  chainId?: number;
  summaryOnly: boolean;
};

type InputRow = {
  chainId: number;
  candidate: Candidate;
  source?: string;
};

type Summary = {
  processed: number;
  scored: number;
  rejections: number;
  fundsEligible: number;
  flashPlans: number;
};

const CANDIDATE_SOURCES: readonly CandidateSource[] = ['watcher', 'poll', 'retry', 'harness'];

function normalizeSource(value?: string): CandidateSource {
  if (!value) return 'harness';
  return (CANDIDATE_SOURCES.includes(value as CandidateSource) ? value : 'harness') as CandidateSource;
}

function usage(): never {
  console.error(
    'Usage: ts-node offchain/tools/harness.ts --input candidates.jsonl [--mode flash|funds|both] [--limit 50] [--fork-rpc http://127.0.0.1:8545] [--chain 42161] [--summary]'
  );
  process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
  let input = '';
  let limit: number | undefined;
  let mode: HarnessMode = 'both';
  let forkRpc: string | undefined;
  let chainId: number | undefined;
  let summaryOnly = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];

    switch (key) {
      case 'input': {
        if (!next) usage();
        input = next;
        i += 1;
        break;
      }
      case 'limit': {
        if (next && !next.startsWith('--')) {
          const parsed = Number(next);
          if (Number.isFinite(parsed) && parsed > 0) {
            limit = Math.floor(parsed);
            i += 1;
          }
        }
        break;
      }
      case 'mode': {
        if (next && !next.startsWith('--')) {
          if (next === 'flash' || next === 'funds' || next === 'both') {
            mode = next;
            i += 1;
          } else {
            usage();
          }
        }
        break;
      }
      case 'fork-rpc': {
        if (!next) usage();
        forkRpc = next;
        i += 1;
        break;
      }
      case 'chain': {
        if (next && !next.startsWith('--')) {
          const parsed = Number(next);
          if (Number.isFinite(parsed) && parsed > 0) {
            chainId = parsed;
            i += 1;
          }
        }
        break;
      }
      case 'summary': {
        summaryOnly = true;
        break;
      }
      default:
        break;
    }
  }

  if (!input) usage();
  return { input, limit, mode, forkRpc, chainId, summaryOnly };
}

function readCandidates(file: string): InputRow[] {
  const rows: InputRow[] = [];
  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`input file not found: ${fullPath}`);
  }

  if (file.endsWith('.jsonl')) {
    const contents = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
    for (const line of contents) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as any;
        const row = extractCandidate(parsed);
        rows.push(row);
      } catch (err) {
        harnessLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'harness-parse-line-failed');
      }
    }
    return rows;
  }

  const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as any;
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      rows.push(extractCandidate(item));
    }
    return rows;
  }

  rows.push(extractCandidate(parsed));
  return rows;
}

function extractCandidate(value: any): InputRow {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid candidate input row');
  }
  const chainId = Number(value.chainId ?? value.chain_id ?? value.details?.chainId ?? value.details?.chain_id);
  if (!Number.isFinite(chainId)) {
    throw new Error('candidate missing chainId');
  }
  const candidate = (value.candidate ?? value.details?.candidate) as Candidate;
  if (!candidate) {
    throw new Error('candidate payload missing');
  }
  return { chainId, candidate, source: value.source ?? 'harness' };
}

function overrideChainRpc(chain: ChainCfg, forkRpc?: string): ChainCfg {
  if (!forkRpc) return chain;
  return {
    ...chain,
    rpc: forkRpc,
    wsRpc: undefined,
    wsRpcFallbacks: undefined,
  };
}

async function evaluateFundsEligibility(
  cfg: AppConfig,
  chain: ChainCfg,
  candidate: Candidate,
  plan: ScoredPlan['plan'],
): Promise<'eligible' | 'insufficient' | 'unknown'> {
  const contract = liquidatorForChain(cfg, chain.id);
  if (!contract) return 'unknown';

  const debtEntry = lookupToken(chain.tokens, candidate.debt.symbol, candidate.debt.address);
  if (!debtEntry) return 'unknown';

  try {
    const client = getPublicClient(chain);
    const balance = (await client.readContract({
      address: debtEntry.value.address,
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          stateMutability: 'view',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: 'amount', type: 'uint256' }],
        },
      ] as const,
      functionName: 'balanceOf',
      args: [contract],
    })) as bigint;

    return balance >= plan.repayAmount ? 'eligible' : 'insufficient';
  } catch (err) {
    harnessLog.warn(
      { err: err instanceof Error ? err.message : String(err), chain: chain.name },
      'harness-funds-balance-check-failed',
    );
    return 'unknown';
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  cfg.risk.dryRun = true;

  const rows = readCandidates(opts.input);
  if (rows.length === 0) {
    console.error('no candidates loaded');
    process.exit(1);
  }

  const scorer = new Scorer(cfg);
  const summary: Summary = {
    processed: 0,
    scored: 0,
    rejections: 0,
    fundsEligible: 0,
    flashPlans: 0,
  };

  for (const row of rows) {
    if (opts.limit && summary.processed >= opts.limit) break;
    summary.processed += 1;

    if (opts.chainId && row.chainId !== opts.chainId) {
      continue;
    }

    let chain = chainById(cfg, row.chainId);
    if (!chain) {
      harnessLog.warn({ chainId: row.chainId }, 'harness-missing-chain');
      continue;
    }
    chain = overrideChainRpc(chain, opts.forkRpc);

    const item: QueuedCandidate = {
      chain,
      candidate: row.candidate,
      source: normalizeSource(row.source),
    };

    let outcome: ScoredPlan | ScoreRejection;
    try {
      outcome = await scorer.score(item);
    } catch (err) {
      harnessLog.error({ err: err instanceof Error ? err.message : String(err) }, 'harness-score-error');
      continue;
    }

    if ('plan' in outcome) {
      summary.scored += 1;
      const { plan } = outcome;
      const modes: HarnessMode[] = opts.mode === 'both' ? ['flash', 'funds'] : [opts.mode];

      for (const mode of modes) {
        if (mode === 'flash') {
          summary.flashPlans += 1;
          if (!opts.summaryOnly) {
            console.log('\nFLASH PLAN', {
              chain: chain.name,
              borrower: outcome.candidate.borrower,
              netUsd: plan.netUsd,
              estNetBps: plan.estNetBps,
              repayAmount: plan.repayAmount.toString(),
              router: plan.router,
              dexId: plan.dexId,
            });
          }
        } else {
          const eligibility = await evaluateFundsEligibility(cfg, chain, outcome.candidate, plan);
          if (eligibility === 'eligible') {
            summary.fundsEligible += 1;
          }
          if (!opts.summaryOnly) {
            console.log('\nFUNDS PLAN', {
              chain: chain.name,
              borrower: outcome.candidate.borrower,
              netUsd: plan.netUsd,
              estNetBps: plan.estNetBps,
              repayAmount: plan.repayAmount.toString(),
              router: plan.router,
              dexId: plan.dexId,
              fundsEligibility: eligibility,
            });
          }
        }
      }
    } else {
      summary.rejections += 1;
      if (!opts.summaryOnly) {
        console.log('\nREJECTED', {
          chain: chain.name,
          borrower: outcome.candidate.borrower,
          reason: outcome.reason,
          detail: outcome.detail,
        });
      }
    }
  }

  console.log('\nHarness summary');
  console.table([
    {
      processed: summary.processed,
      scored: summary.scored,
      rejections: summary.rejections,
      flashPlans: summary.flashPlans,
      fundsEligible: summary.fundsEligible,
    },
  ]);
}

main().catch((err) => {
  console.error('harness failed', err instanceof Error ? err.message : err);
  process.exit(1);
});
