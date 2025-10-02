import '../infra/env';
import { loadConfig } from '../infra/config';
import { log } from '../infra/logger';

const ENV_KEYS: Record<number, string> = {
  42161: 'AAVE_V3_SUBGRAPH_ARB',
  10: 'AAVE_V3_SUBGRAPH_OP',
  8453: 'AAVE_V3_SUBGRAPH_BASE',
  137: 'AAVE_V3_SUBGRAPH_POLYGON',
};

const FALLBACKS: Record<number, string> = {
  42161: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
  10: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-optimism',
  8453: '',
  137: '',
};

const PING_QUERY = `
  query SubgraphMeta {
    _meta {
      block {
        number
        timestamp
      }
      deployment
    }
  }
`;

type MetaResponse = {
  _meta?: {
    block?: { number?: number; timestamp?: number };
    deployment?: string;
  };
};

function endpointFor(chainId: number): string {
  const key = ENV_KEYS[chainId];
  if (!key) return '';
  const envValue = process.env[key];
  if (envValue && !envValue.includes('<') && !envValue.includes('MISSING')) {
    return envValue;
  }
  return FALLBACKS[chainId] ?? '';
}

async function pingSubgraph(chainId: number, url: string) {
  if (!url) {
    log.warn({ chainId }, 'subgraph-missing-url');
    return;
  }

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: PING_QUERY }),
    });

    const elapsed = Date.now() - started;
    if (!res.ok) {
      const text = await res.text();
      log.error({ chainId, url, status: res.status, body: text, elapsed }, 'subgraph-http-error');
      return;
    }

    const json = (await res.json()) as { data?: MetaResponse; errors?: unknown };
    if (json.errors) {
      log.error({ chainId, url, errors: json.errors, elapsed }, 'subgraph-graphql-error');
      return;
    }

    const meta = json.data?._meta ?? {};
    log.info(
      {
        chainId,
        url,
        block: meta.block?.number,
        timestamp: meta.block?.timestamp,
        deployment: meta.deployment,
        elapsed,
      },
      'subgraph-ok'
    );
  } catch (err) {
    log.error({ chainId, url, err: (err as Error).message }, 'subgraph-request-failed');
  }
}

async function main() {
  const cfg = loadConfig();
  const seen = new Set<number>();

  for (const market of cfg.markets.filter((m) => m.enabled)) {
    seen.add(market.chainId);
  }

  if (seen.size === 0) {
    log.warn({}, 'no-enabled-markets');
    return;
  }

  await Promise.all(Array.from(seen).map((chainId) => pingSubgraph(chainId, endpointFor(chainId))));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});