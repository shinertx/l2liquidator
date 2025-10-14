import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import { loadConfig } from '../infra/config';
import { deepMerge } from '../util/deepMerge';
import { log } from '../infra/logger';

const DEFAULT_STAGE_FILE = process.env.AGENT_STAGE_FILE ?? 'config.staged.yaml';
const DEFAULT_PROPOSAL_DIR = process.env.AGENT_PROPOSAL_DIR ?? path.resolve(process.cwd(), 'agent', 'proposals');

export type ProposalInput = {
  patch: string;
  hypothesis?: string;
  successMetric?: string;
  killSwitch?: string;
  author?: string;
  source?: string;
};

export type ProposalMetadata = ProposalInput & {
  id: string;
  createdAt: string;
  patchFile: string;
  stagedConfig: string;
};

async function ensureProposalDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parsePatch(yamlText: string): Record<string, unknown> {
  const parsed = YAML.parse(yamlText);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Patch must be a YAML mapping object');
  }
  return parsed as Record<string, unknown>;
}

export async function stageProposal(input: ProposalInput, opts?: { baseConfigPath?: string; proposalDir?: string; stageFile?: string }) {
  const proposalDir = opts?.proposalDir ?? DEFAULT_PROPOSAL_DIR;
  const stageFile = opts?.stageFile ?? DEFAULT_STAGE_FILE;
  await ensureProposalDir(proposalDir);

  const patchObject = parsePatch(input.patch);
  const baseConfigPath = opts?.baseConfigPath ?? 'config.yaml';
  const baseConfig = loadConfig(baseConfigPath);
  const stagedConfig = deepMerge(baseConfig as any, patchObject);

  const stagedYaml = YAML.stringify(stagedConfig);
  await fs.writeFile(stageFile, stagedYaml, 'utf8');

  const id = timestampId();
  const patchFilename = path.join(proposalDir, `${id}.patch.yaml`);
  const metadataFilename = path.join(proposalDir, `${id}.json`);

  await fs.writeFile(patchFilename, input.patch.trim() + '\n', 'utf8');

  const metadata: ProposalMetadata = {
    id,
    createdAt: new Date().toISOString(),
    patchFile: patchFilename,
    stagedConfig: path.resolve(stageFile),
    ...input,
  };

  await fs.writeFile(metadataFilename, JSON.stringify(metadata, null, 2), 'utf8');
  log.info({ id, stageFile }, 'proposal-staged');
  return metadata;
}

export async function readLatestMetadata(proposalDir = DEFAULT_PROPOSAL_DIR): Promise<ProposalMetadata | null> {
  try {
    const entries = await fs.readdir(proposalDir);
    const jsonFiles = entries.filter((name) => name.endsWith('.json')).sort();
    if (!jsonFiles.length) return null;
    const latest = jsonFiles[jsonFiles.length - 1];
    const raw = await fs.readFile(path.join(proposalDir, latest), 'utf8');
    return JSON.parse(raw) as ProposalMetadata;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadStagedConfig(stageFile = DEFAULT_STAGE_FILE) {
  try {
    const raw = await fs.readFile(stageFile, 'utf8');
    return YAML.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Staged config not found at ${stageFile}. Stage a proposal first.`);
    }
    throw err;
  }
}

export function resolveStagePath(stageFile = DEFAULT_STAGE_FILE): string {
  return path.resolve(stageFile);
}

export function resolveProposalDir(dir = DEFAULT_PROPOSAL_DIR): string {
  return path.resolve(dir);
}
