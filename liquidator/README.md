# L2 Micro-Liquidator (Arbitrum · Optimism · Base · Polygon)

**Purpose**: Liquidate the long-tail of risky loans on Aave v3 using Aave flash liquidity, seize collateral with the protocol bonus, swap, repay flash + premium, keep spread. Designed for cheap L2 gas.

### Quickstart (dev)
1) **Install**
```bash
cd liquidator
npm i
forge install
```
2) **Configure**
- Copy `.env.sample` → `.env` and fill the RPC + WS endpoints and private keys for Arbitrum, Optimism, Base, and Polygon (we spin up all four agents once their contracts are deployed).
- Add your The Graph Gateway key (`GRAPH_API_KEY`) and set any `AAVE_V3_SUBGRAPH_*` overrides in `.env` if you use hosted subgraphs.
- Copy `config.example.yaml` → `config.yaml`, record your liquidator contract address for **every** chain under `contracts.liquidator[chainId]`, and review the markets before enabling them.

3) **Compile & test**
```bash
npm run build
forge build
forge test -vv
```

4) **Sync token metadata & policies**
```bash
npm run sync:aave
```

5) **Deploy Liquidator** (example: Arbitrum)
```bash
forge create --rpc-url $RPC_ARB --private-key $WALLET_PK_ARB contracts/Liquidator.sol:Liquidator \
 --constructor-args $AAVE_POOL_ARB $UNI_V3_ROUTER_ARB $BENEFICIARY
```

6) **Run orchestrator (shadow mode)**
```bash
npm run dev
```

	Or (ensures `${VAR}` interpolation via dotenv-expand without manually sourcing):
```bash
./scripts/dev_env.sh
```

7) **Go live (canary)**: enable 1–2 markets in `config.yaml` with high `minProfit`, tight `slippageBps`, `gapCapBps`.

**Not legal/financial advice. Use at your own risk.**

### Monitoring & dashboards

- **Prometheus & Grafana**: `docker-compose up grafana prometheus loki promtail` spins up a pre-wired stack. Visit `http://localhost:3000` (default `admin`/`admin`) to view the “Founder Ops” dashboard. The board runs fine in the Grafana mobile app for quick checks.
- **Metrics**: key Prometheus series include `profit_estimated_total_usd`, `plans_failure_rate`, `inventory_balance`, `simulate_duration_seconds`, and `plans_sent_total` (all tagged by chain/mode).
- **Logs**: promtail tails orchestrator logs into Loki (`http://localhost:3100`). Use the dashboard’s “Recent Activity” panel or Grafana Explore to query `mode`, `precommit`, `chain`, and failure reasons on demand.
- **Kill switch**: create the file specified by `KILL_SWITCH_FILE` to halt all agents instantly. Preflight now warns if the file exists.

### Persistent observability
- **File logs**: Runtime logs now mirror to `logs/live.log`. Override with `LOG_DIR`, `LOG_FILE_NAME`, or disable stdout mirroring with `LOG_DISABLE_STDOUT=1`. Rotate/ship this file with your preferred tooling.
- **Attempt store (optional)**: Set `DATABASE_URL` to a Postgres connection string before starting the orchestrator to persist policy skips, dry-runs, and failures. The table is auto-provisioned via `ensureAttemptTable()` on boot.

### Live ops checklist
- **Config**: set `beneficiary` to your Safe, populate `contracts.liquidator[chainId]` (Arbitrum/Optimism/Base/Polygon) after deployment, and verify token/pool/router addresses against Aave & Uniswap docs.
- **Safety**: keep `risk.dryRun: true` for 12–24h canary to observe `would-fire` logs and price gaps before flipping to live.
- **Micro-live guardrails**: before disabling dry-run, set conservative `risk.maxRepayUsd` (per liquidation), `risk.maxSessionNotionalUsd` (rolling session spend), and `risk.maxLiveExecutions` (per process) to cap exposure during canary runs; the orchestrator will exit once any cap is hit.
- **Keys & funding**: export low-balance EOAs via `.env`, fund gas (ARB/OP/ETH-on-Base/MATIC) just-in-time, sweep proceeds to the Safe frequently.
- **Deployment**: `forge create` with the chain-specific pool/router above and your beneficiary, then record the address back into `config.yaml`.
- **Monitoring**: watch Prometheus gauges (`pnl_per_gas`, `hit_rate`), log-level `debug` for gap skips, and track failed tx hashes for revert reasons.
- **Shadow QA**: use `npm run dev` in dry-run plus `npx ts-node offchain/tools/replay-candidates.ts samples.json --limit 50` to replay captured candidates against live RPCs before flipping `dryRun` off.
