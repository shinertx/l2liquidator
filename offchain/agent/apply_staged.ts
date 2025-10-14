import '../infra/env';
import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import { log } from '../infra/logger';
import { runBacktest } from './backtest';
import { loadStagedConfig, readLatestMetadata, resolveStagePath } from './proposals';
import type { AppConfig } from '../infra/config';

const BASE_CONFIG_PATH = 'config.yaml';
const PREV_CONFIG_PATH = process.env.AGENT_PREV_FILE ?? 'config.prev.yaml';
const CANARY_CONFIG_PATH = process.env.AGENT_CANARY_FILE ?? 'config.canary.yaml';
const REPORT_PATH = process.env.AGENT_REPORT_FILE ?? path.resolve('agent', 'latest-report.json');

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      values[key] = next;
      i += 1;
    } else {
      flags.add(key);
    }
  }
  return { flags, values };
}

function gateResult(result: Awaited<ReturnType<typeof runBacktest>>) {
  const { baselinePlans, newPlans, baselineAvgNetBps, newAvgNetBps } = result;
  if (baselinePlans === 0) {
    return { pass: true, reason: 'baseline has no plan data (skipping gate)' };
  }
  if (newPlans < baselinePlans * 0.8) {
    return { pass: false, reason: `new plan count ${newPlans} < 80% of baseline ${baselinePlans}` };
  }
  if (baselineAvgNetBps > 0 && newAvgNetBps < baselineAvgNetBps * 0.95) {
    return {
      pass: false,
      reason: `avg net bps ${newAvgNetBps.toFixed(2)} below 95% of baseline ${baselineAvgNetBps.toFixed(2)}`,
    };
  }
  return { pass: true, reason: 'gates passed' };
}

async function writeReport(report: unknown) {
  const json = JSON.stringify(report, null, 2);
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, json, 'utf8');
}

async function main() {
  const { flags, values } = parseArgs();
  const limit = values.limit ? Number(values.limit) : undefined;
  const seconds = values.seconds ? Number(values.seconds) : undefined;
  const apply = flags.has('apply');
  const canary = flags.has('canary');

  const stagePath = resolveStagePath();
  const stagedConfig = (await loadStagedConfig()) as AppConfig;

  const result = await runBacktest({ config: stagedConfig, limit, seconds });
  const gate = gateResult(result);
  const metadata = await readLatestMetadata();

  const report = {
    gate,
    result,
    stagePath,
    metadata,
  };

  await writeReport(report);

  log.info(report, 'agent-backtest-report');

  if (!gate.pass) {
    log.error({ reason: gate.reason }, 'proposal-gate-failed');
    process.exitCode = 1;
    return;
  }

  if (canary) {
    await fs.writeFile(CANARY_CONFIG_PATH, YAML.stringify(stagedConfig), 'utf8');
    log.info({ config: CANARY_CONFIG_PATH }, 'canary-config-written');
  }

  if (!apply) {
    log.info('use --apply to promote staged config to production');
    return;
  }

  await fs.copyFile(BASE_CONFIG_PATH, PREV_CONFIG_PATH).catch(() => {});
  await fs.copyFile(stagePath, BASE_CONFIG_PATH);
  log.info({ promoted: BASE_CONFIG_PATH, backup: PREV_CONFIG_PATH }, 'config-promoted');
}

main().catch((err) => {
  console.error('agent apply failed:', err);
  process.exit(1);
});
