import '../infra/env';
import { loadConfig, type ChainCfg } from '../infra/config';
import { ensureRoutersAllowed } from '../executor/allow_router';
import { privateKeyForChain } from '../infra/accounts';
import { log } from '../infra/logger';

type CliArgs = {
  chainIds?: Set<number>;
  chainNames?: Set<string>;
  includeDisabled: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const chainIds = new Set<number>();
  const chainNames = new Set<string>();
  let includeDisabled = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'chain' || key === 'chain-id') {
      const value = argv[i + 1];
      if (!value) continue;
      i += 1;
      if (key === 'chain-id') {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) chainIds.add(parsed);
        continue;
      }
      // Match by chain name after normalising to lower case without whitespace/underscores
      const normalized = value.replace(/[^0-9a-z]/gi, '').toLowerCase();
      if (!normalized) continue;
      chainNames.add(normalized);
      continue;
    }
    if (key === 'include-disabled') {
      includeDisabled = true;
    }
  }

  return {
    chainIds: chainIds.size > 0 ? chainIds : undefined,
    chainNames: chainNames.size > 0 ? chainNames : undefined,
    includeDisabled,
  };
}

function matchChain(chain: ChainCfg, ids?: Set<number>, names?: Set<string>): boolean {
  const byId = ids?.size ? ids.has(chain.id) : false;
  const normalizedName = chain.name.replace(/[^0-9a-z]/gi, '').toLowerCase();
  const byName = names?.size ? names.has(normalizedName) : false;
  if (!ids?.size && !names?.size) return true;
  if (byId || byName) return true;
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const selectedChains = cfg.chains.filter((chain) => {
    if (!args.includeDisabled && !chain.enabled) return false;
    return matchChain(chain, args.chainIds, args.chainNames);
  });

  if (selectedChains.length === 0) {
    log.warn({}, 'allow-routers-no-chains-selected');
    return;
  }

  for (const chain of selectedChains) {
    const contract = cfg.contracts?.liquidator?.[chain.id];
    const pk = privateKeyForChain(chain);
    if (!contract || !pk) {
      log.warn({ chainId: chain.id }, 'skip-allow-routers-missing-contract-or-pk');
      continue;
    }
    await ensureRoutersAllowed({ cfg, chain, contract, pk });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
