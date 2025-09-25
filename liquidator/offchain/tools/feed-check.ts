import '../infra/env';
import { createPublicClient, http } from 'viem';
import { loadConfig, chainById, ChainCfg } from '../infra/config';
import { log } from '../infra/logger';

// Minimal Chainlink aggregator ABI
const AGGREGATOR_ABI = [
  { inputs: [], name: 'latestRoundData', outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
];

async function checkChainFeeds(chain: ChainCfg) {
  const client = createPublicClient({ transport: http(chain.rpc) });
  for (const [sym, t] of Object.entries(chain.tokens)) {
    if (!t.chainlinkFeed) {
      log.warn({ chain: chain.id, sym }, 'no-feed');
      continue;
    }
    try {
      const [dec, round] = await Promise.all([
        client.readContract({ address: t.chainlinkFeed, abi: AGGREGATOR_ABI as any, functionName: 'decimals', args: [] }),
        client.readContract({ address: t.chainlinkFeed, abi: AGGREGATOR_ABI as any, functionName: 'latestRoundData', args: [] }),
      ]);
      const decimals = Number(dec);
      const answer = BigInt((round as any).answer ?? (round as any)[1]);
      const updatedAt = BigInt((round as any).updatedAt ?? (round as any)[3]);
      log.info({ chain: chain.id, sym, feed: t.chainlinkFeed, price: answer.toString(), decimals, updatedAt: updatedAt.toString() }, 'feed');
    } catch (err) {
      log.error({ chain: chain.id, sym, feed: t.chainlinkFeed, err: (err as Error).message }, 'feed-error');
    }
  }
}

async function main() {
  const cfg = loadConfig();
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    await checkChainFeeds(chain);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
