import '../infra/env';
import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';
import { OpenAI } from 'openai';

import { loadConfig } from '../infra/config';
import { log } from '../infra/logger';
import { db } from '../infra/db';
import { stageProposal } from './proposals';

const hasDb = Boolean(process.env.DATABASE_URL);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY must be set to run the agent');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchRecentAttempts(limit = 200, seconds = 3600) {
  if (!hasDb) {
    throw new Error('DATABASE_URL not configured; cannot inspect attempts');
  }
  const sql = `
    SELECT chain_id, borrower, status, reason, details, created_at
    FROM liquidation_attempts
    WHERE created_at >= NOW() - ($2 || ' seconds')::interval
    ORDER BY created_at DESC
    LIMIT $1
  `;
  const res = await db.query(sql, [limit, seconds]);
  return res.rows;
}

function aggregateAttempts(rows: any[]) {
  const byStatus: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const perChain: Record<number, { total: number; netBps: number; count: number }> = {};
  const misses: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.reason) {
      byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
    }
    const chainSummary = (perChain[row.chain_id] = perChain[row.chain_id] || { total: 0, netBps: 0, count: 0 });
    chainSummary.total += 1;
    const est = row.details?.plan?.estNetBps;
    if (typeof est === 'number') {
      chainSummary.netBps += est;
      chainSummary.count += 1;
    }
    if (row.status !== 'sent' && row.details?.candidate) {
      misses.push({
        chainId: row.chain_id,
        borrower: row.borrower,
        status: row.status,
        reason: row.reason,
        candidate: row.details.candidate,
      });
    }
  }

  const chains = Object.entries(perChain).map(([chainId, stats]) => ({
    chainId: Number(chainId),
    samples: stats.total,
    avgNetBps: stats.count ? stats.netBps / stats.count : 0,
  }));

  return {
    total: rows.length,
    byStatus,
    byReason,
    chains,
    misses: misses.slice(0, 20),
  };
}

function trimConfig(config: ReturnType<typeof loadConfig>) {
  return {
    assets: config.assets,
    routing: config.routing,
    risk: config.risk,
  };
}

function buildPrompt(config: ReturnType<typeof loadConfig>, summary: ReturnType<typeof aggregateAttempts>) {
  const configSnippet = YAML.stringify(trimConfig(config));
  const summarySnippet = JSON.stringify(summary, null, 2);
  return `You are an L2 liquidation strategist. Review the recent results and propose at most one YAML patch that improves profits without increasing risk. Respond strictly in JSON with shape {"analysis": string, "patch": string, "hypothesis": string, "successMetric": string, "killSwitch": string}. The patch must be a YAML mapping touching only routing, assets, or risk fields.

Current config (excerpt):
${configSnippet}

Recent metrics:
${summarySnippet}`;
}

async function run() {
  const config = loadConfig();
  const attempts = await fetchRecentAttempts();
  const summary = aggregateAttempts(attempts);
  const prompt = buildPrompt(config, summary);

  const completion = await openai.responses.create({
    model: OPENAI_MODEL,
    reasoning: { effort: 'medium' },
    input: [
      {
        role: 'system',
        content:
          'You are an expert quant/DevOps assistant for an L2 liquidation bot. Always emit valid JSON with the fields analysis, patch, hypothesis, successMetric, killSwitch. The patch must be YAML and syntactically correct. Avoid changing safety guards like minProfit or pnlPerGasMin.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const outputText = completion.output_text;
  if (!outputText) {
    throw new Error('LLM response missing output_text');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(outputText.trim());
  } catch (err) {
    throw new Error(`Failed to parse LLM JSON: ${(err as Error).message}`);
  }

  if (!parsed.patch || typeof parsed.patch !== 'string' || !parsed.patch.trim()) {
    throw new Error('LLM did not provide a patch field');
  }

  const metadata = await stageProposal({
    patch: parsed.patch,
    hypothesis: parsed.hypothesis,
    successMetric: parsed.successMetric,
    killSwitch: parsed.killSwitch,
    source: 'llm-agent',
  });

  const reportDir = path.dirname(metadata.patchFile);
  await fs.writeFile(
    path.join(reportDir, `${metadata.id}.analysis.json`),
    JSON.stringify({ summary, analysis: parsed.analysis }, null, 2),
    'utf8'
  );

  log.info({ metadata, analysis: parsed.analysis }, 'agent-proposal-staged');
  console.log('Proposal staged at', metadata.stagedConfig);
  console.log('Analysis:', parsed.analysis);
}

run().catch((err) => {
  console.error('agent runner failed:', err);
  process.exit(1);
});
