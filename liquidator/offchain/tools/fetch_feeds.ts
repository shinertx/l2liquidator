import '../infra/env';
import { createPublicClient, getAddress, http } from 'viem';
import { loadConfig } from '../infra/config';

const FEED_REGISTRY = '0x47Fb2585D2C56Fe188D0E6ec628a38B74fCeeeDf';
const USD_ADDRESS = '0x0000000000000000000000000000000000000348';

const FEED_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getFeed',
    stateMutability: 'view',
    inputs: [
      { name: 'base', type: 'address' },
      { name: 'quote', type: 'address' },
    ],
    outputs: [{ name: 'aggregator', type: 'address' }],
  },
] as const;

async function main() {
  const cfg = loadConfig();
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
    if (chain.id !== 1) {
      console.log(`\nChain ${chain.id} (${chain.name}): skip – feed registry is L1-only`);
      continue;
    }
    const client = createPublicClient({ transport: http(chain.rpc) });
    console.log(`\nChain ${chain.id} (${chain.name})`);
    for (const [symbol, token] of Object.entries(chain.tokens)) {
      if (token.chainlinkFeed) {
        console.log(`${symbol}: already set -> ${token.chainlinkFeed}`);
        continue;
      }
      try {
        const aggregator = await client.readContract({
          address: getAddress(FEED_REGISTRY),
          abi: FEED_REGISTRY_ABI,
          functionName: 'getFeed',
          args: [getAddress(token.address), getAddress(USD_ADDRESS)],
        });
        // TODO: write discovered feeds back into config.yaml once validated against production routes.
        console.log(`${symbol}: ${aggregator}`);
      } catch (err) {
        console.log(`${symbol}: feed lookup failed (${(err as Error).message})`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
