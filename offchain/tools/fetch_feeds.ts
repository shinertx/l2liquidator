import '../infra/env';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { createPublicClient, http, getAddress } from 'viem';
import type { Chain } from 'viem';
import { mainnet, arbitrum, optimism, base, polygon } from 'viem/chains';
import { normalize } from 'viem/ens';
import { loadConfig } from '../infra/config';

const CHAINS: Partial<Record<number, Chain>> = {
  [mainnet.id]: mainnet,
  [optimism.id]: optimism,
  [arbitrum.id]: arbitrum,
  [base.id]: base,
  [polygon.id]: polygon,
};

const SEQUENCER_UPTIME_FEEDS: Record<number, string> = {
  42161: '0x4C4814aa04433e0FB31310379a4D6946D5e1D353',
};

type CliOptions = {
  write: boolean;
  configPath: string;
};

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  let write = false;
  let configPath = process.env.CONFIG_PATH ?? 'config.yaml';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--write') {
      write = true;
    } else if (arg === '--config') {
      const next = args[i + 1];
      if (!next) {
        throw new Error('--config flag requires a path argument');
      }
      configPath = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run feed:check [-- --write] [--config <path>]');
      console.log('  --write         Persist new Chainlink feeds back into config.yaml');
      console.log('  --config <path> Override config path (default: config.yaml)');
      process.exit(0);
    }
  }

  return { write, configPath: path.resolve(configPath) };
}

async function discoverFeeds(configPath: string, shouldWrite: boolean) {
  const cfg = loadConfig(configPath);
  const doc = shouldWrite ? YAML.parseDocument(fs.readFileSync(configPath, 'utf8')) : null;
  const chainIndexById = new Map<number, number>();

  if (doc) {
    const chainsNode = doc.get('chains');
    if (Array.isArray(chainsNode)) {
      chainsNode.forEach((chain: any, index: number) => {
        if (chain && typeof chain === 'object' && 'id' in chain) {
          chainIndexById.set(Number(chain.id), index);
        }
      });
    } else if (chainsNode && typeof (chainsNode as any).items === 'object') {
      (chainsNode as any).items.forEach((chainNode: any, index: number) => {
        if (chainNode && typeof chainNode.get === 'function') {
          const id = chainNode.get('id');
          if (typeof id === 'number') {
            chainIndexById.set(id, index);
          }
        }
      });
    }
  }

  const updates: Array<{ chainId: number; chainName: string; symbol: string; feed: string }> = [];

  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    const viemChain = CHAINS[chain.id];
    if (!viemChain) {
      console.log(`\nChain ${chain.id} (${chain.name}): skip – unsupported chain`);
      continue;
    }

    const client = createPublicClient({
      chain: viemChain,
      transport: http(),
    });

    console.log(`\nChain ${chain.id} (${chain.name})`);

    const sequencerUptimeFeed = SEQUENCER_UPTIME_FEEDS[chain.id];
    if (sequencerUptimeFeed) {
      try {
        const code = await client.getBytecode({ address: getAddress(sequencerUptimeFeed) });
        if (code) {
          console.log(`Sequencer uptime feed found at ${sequencerUptimeFeed}`);
        } else {
          console.warn(`Sequencer uptime feed not found at ${sequencerUptimeFeed}`);
        }
      } catch (err) {
        console.warn(`Failed to check for sequencer uptime feed at ${sequencerUptimeFeed} (${(err as Error).message})`);
      }
    }

    for (const [symbol, token] of Object.entries(chain.tokens)) {
      const existingFeed = token.chainlinkFeed;
      if (existingFeed && !existingFeed.includes('MISSING:')) {
        console.log(`${symbol}: already set -> ${existingFeed}`);
        continue;
      }

      const ensName = `${symbol.toLowerCase()}-usd.data.eth`;
      try {
        const feedAddress = await client.getEnsAddress({
          name: normalize(ensName),
        });

        if (feedAddress) {
          console.log(`${symbol}: discovered ${feedAddress}`);
          updates.push({ chainId: chain.id, chainName: chain.name, symbol, feed: feedAddress });
        } else {
          console.log(`${symbol}: no USD feed registered for ${ensName}`);
        }
      } catch (err) {
        console.log(`${symbol}: feed lookup failed for ${ensName} (${(err as Error).message})`);
      }
    }
  }

  if (!shouldWrite) {
    if (updates.length === 0) {
      console.log('\nNo new feeds discovered.');
    } else {
      console.log(`\nDiscovered ${updates.length} new feed(s). Re-run with --write to persist them.`);
    }
    return;
  }

  if (!doc) {
    throw new Error('YAML document not loaded; cannot write updates.');
  }

  if (updates.length === 0) {
    console.log('\nNo changes to write.');
    return;
  }

  for (const update of updates) {
    const chainIndex = chainIndexById.get(update.chainId);
    if (chainIndex == null) {
      console.warn(
        `Skipping write for ${update.symbol} on chain ${update.chainId} – chain not found in config document`,
      );
      continue;
    }
    doc.setIn(['chains', chainIndex, 'tokens', update.symbol, 'chainlinkFeed'], update.feed);
  }

  fs.writeFileSync(configPath, doc.toString(), 'utf8');
  console.log(`\nPersisted ${updates.length} feed(s) to ${configPath}`);
}

async function main() {
  const { write, configPath } = parseArgs();
  await discoverFeeds(configPath, write);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
