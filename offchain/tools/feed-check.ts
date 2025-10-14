import '../infra/env';
import { createPublicClient, http } from 'viem';
import { loadConfig, ChainCfg } from '../infra/config';
import { log } from '../infra/logger';
import { oraclePriceDetails } from '../indexer/price_watcher';

async function checkChainFeeds(chain: ChainCfg) {
  const client = createPublicClient({ transport: http(chain.rpc) });
  for (const [sym, token] of Object.entries(chain.tokens)) {
    if (!token.chainlinkFeed) {
      log.warn({ chain: chain.id, sym }, 'no-feed');
      continue;
    }
    try {
      const detail = await oraclePriceDetails(client, token);
      if (!detail.priceUsd || detail.priceUsd <= 0) {
        log.warn({ chain: chain.id, sym, feed: token.chainlinkFeed, error: detail.error }, 'feed-missing-price');
        continue;
      }
      const payload: Record<string, unknown> = {
        chain: chain.id,
        sym,
        feed: token.chainlinkFeed,
        price: detail.priceUsd,
        decimals: detail.decimals,
        updatedAt: detail.updatedAt,
        stale: detail.stale,
      };
      if (detail.error) payload.error = detail.error;
      log.info(payload, 'feed');
    } catch (err) {
      log.error({ chain: chain.id, sym, feed: token.chainlinkFeed, err: (err as Error).message }, 'feed-error');
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
