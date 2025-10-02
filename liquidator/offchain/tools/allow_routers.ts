import '../infra/env';
import { loadConfig } from '../infra/config';
import { ensureRoutersAllowed } from '../executor/allow_router';
import { privateKeyForChain } from '../infra/accounts';
import { log } from '../infra/logger';

async function main() {
  const cfg = loadConfig();
  for (const chain of cfg.chains.filter((c) => c.enabled)) {
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
