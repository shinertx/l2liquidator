# L2 Micro-Liquidator (Arbitrum · Optimism · Base · Polygon)

**Purpose**: Liquidate the long-tail of risky loans on Aave v3 using Aave flash liquidity, seize collateral with the protocol bonus, swap, repay flash + premium, keep spread. Designed for cheap L2 gas.

### Prerequisites
- **Node & pnpm/npm** for the off-chain services (`npm i`, `ts-node`).
- **Foundry** for contract compilation (`forge`).
- **Docker Compose** if you want the optional monitoring stack (Prometheus/Loki/Grafana) or the bundled Postgres/Redis helpers.
- **Redis** (default `redis://localhost:6380`) for throttles/edge bookkeeping. `docker compose up -d redis` will launch the dev instance shipped with this repo.
- **Postgres** (optional but recommended) for attempt logging (`DATABASE_URL`). `docker compose up -d postgres postgres-exporter` brings up the local database the orchestrator expects in dev.

> **Two execution paths**  
> | Surface | Mandatory? | Entry point | Metrics port | Purpose |  
> | --- | --- | --- | --- | --- |  
> | Micro-Liquidator | Yes | `npm run dev` / `./scripts/dev_env.sh` | 9464 (`PROM_PORT`) | Aave v3 liquidations |  
> | LAF (Arb Fabric) | Optional | `npm run fabric` | `FABRIC_PROM_PORT` (default 9470) | DEX arbitrage |

- **Operations focus**  
  - Run `npm run feed:check -- --write` after syncing new assets (USR, USD0, Pendle PTs, etc.) so `config.yaml` stays aligned before re-enabling Base in `MORPHO_BLUE_CHAIN_IDS`.  
  - Tune pre-liquidation repay sizing (target $300–$3k clips) and raise BTC repay caps in the risk config.  
  - Morpho/Base throttles ship relaxed by default (`MORPHO_BLUE_CHAIN_IDS=1,8453`, `MORPHO_BLUE_FIRST=1200`, poll windows 10–120s); tighten if you need a slower canary.
- **Morpho/Base rollout plan**  
  - Turn on Morpho/Base monitoring for BTC/cbBTC collateral + USDC once policies/feeds are populated.  
  - Enable the pre-liquidation adapter for small ($300–$3k) clips with guards (`net ≥ $2`, `pnl_per_gas ≥ 4×`).  
  - Run a 24 h census on Morpho/Base to capture HF<1 and pre-liq trigger stats before sending gas.  
  - Raise max repay to $10–30k on BTC books once you have RFQ/intent coverage; until then cap at conservative levels and prefer AMM-friendly clips.  
  - Add alerts/autodiscovery for new Coinbase-listed vaults/pairs.

### Quickstart (dev)
1) **Install**
```bash
cd liquidator
npm i
forge install
```
2) **Configure**
- Copy `.env.sample` → `.env` and fill the RPC + WS endpoints, private keys, and Safe owner addresses for Arbitrum, Optimism, Base, and Polygon (we spin up all four agents once their contracts are deployed).
- Add your The Graph Gateway key (`GRAPH_API_KEY`) and set any `AAVE_V3_SUBGRAPH_*` overrides in `.env` if you use hosted subgraphs.
- Copy `config.example.yaml` → `config.yaml`, record your liquidator contract address for **every** chain under `contracts.liquidator[chainId]`, and review the markets before enabling them.

3) **Compile & test**
```bash
npm run build
npm run test:unit
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

6) **Boot adaptive risk engine & analytics loop (recommended)**
   - Set `RISK_ENGINE_URL` in `.env` (defaults to `http://localhost:4010`) so both the orchestrator and analytics loop can reach the service.
```bash
npm run risk-engine
```
   - In another terminal, start the analytics feedback loop so it can stream attempt data back to the risk engine:
```bash
npm run analytics:perf
```

7) **Run orchestrator (shadow mode)**
```bash
npm run dev
```

	Or (ensures `${VAR}` interpolation via dotenv-expand without manually sourcing):
```bash
./scripts/dev_env.sh
```

8) **Go live (canary)**: enable 1–2 markets in `config.yaml` with high `minProfit`, tight `slippageBps`, `gapCapBps`.

**Not legal/financial advice. Use at your own risk.**

### Production start (manual run)

Once you have completed the go-live checklist and funded the strategy, you can bring the stack up manually without systemd:

1. **Compile once** (after any config changes):
   ```bash
   npm run build
   forge build
   ```
2. **Launch shared services**:
   - Redis/Postgres (local docker compose or your managed endpoints).
   - Risk engine: `npm run risk-engine`.
   - Analytics feedback loop (optional but recommended): `npm run analytics:perf`.
3. **Start the micro-liquidator** with production env vars loaded:
   ```bash
   ./scripts/dev_env.sh npm run dev
   ```
   The helper wraps `dotenv-expand` so secrets from `.env` are applied before `npm run dev`.
4. **Monitor**:
   - Metrics on `http://localhost:9464/metrics`.
   - Logs in `logs/live.log`.
   - Kill switch via the `KILL_SWITCH_FILE` path if you need to pause execution.

For unattended operation, use the systemd units shipped under `ops/systemd/`, but the steps above are the quickest way to reproduce a production run in a shell.

### Autonomous operations (systemd + health checks)

The repo ships first-class automation so the stack can survive host reboots, transient RPC failures, and container crashes without manual babysitting.

1. **Install units** (once):
   ```bash
   sudo cp ops/systemd/l2liquidator-{stack,orchestrator,fabric,health}.service /etc/systemd/system/
   sudo chmod +x ops/systemd/start_{orchestrator,fabric}.sh ops/health_monitor.sh
   sudo systemctl daemon-reload
   ```
2. **Configure secrets**: ensure `.env` (or `/etc/l2liquidator.env`) contains RPC keys, private keys, and optionally `ALERT_WEBHOOK_URL` for Slack/Discord alerts. The health monitor will warn if any remain unexpanded (look for `[env] WARN`).
3. **Enable auto-start on boot**:
   ```bash
   sudo systemctl enable --now l2liquidator-stack.service
   sudo systemctl enable --now l2liquidator-orchestrator.service
   sudo systemctl enable --now l2liquidator-fabric.service
   sudo systemctl enable --now l2liquidator-health.service
   ```
4. **Verify status**:
   ```bash
   sudo systemctl status l2liquidator-{stack,orchestrator,fabric,health}
   tail -f logs/{docker-stack,orchestrator,fabric,health-monitor}.log
   ```

The health monitor loops every 60 s (configurable via `HEALTH_CHECK_INTERVAL`) and will:

- Restart services via systemd if a PID disappears or a container goes unhealthy.
- Hit `http://localhost:{9664,9470,9464}/metrics` and mark degradations.
- Alert through `ALERT_WEBHOOK_URL` (Slack/Discord/Teams) when automated remediation kicks in.

Use `scripts/alerts/send_webhook.ts "message"` for manual paging, or integrate it in cron/schedulers.

### Long-Tail Arbitrage Fabric (LAF)
The repo now ships an optional arbitrage module that reuses the micro-liquidator infrastructure.

1. **Configure** `fabric.config.yaml` (top-level). Start with census mode (`global.mode=census`), a single chain, and a handful of pairs. Toggle `enableSingleHop`, `enableTriangular`, `enableCrossChain` as you expand coverage.
   - Prefer generating fresh configs with `offchain/tools/generate_fabric_census.ts`. It now accepts CLI overrides such as `--output=fabric.config.census-full.yaml`, `--min-net=0.6`, `--pnl-multiple=1.2`, `--chains=arb,op,base`, `--no-triangular`, or `--no-cross-chain`. Example:
       ```bash
       npx ts-node offchain/tools/generate_fabric_census.ts --output=fabric.config.census-wide.yaml --chains=arb,op,base,polygon --min-net=0.75 --pnl-multiple=1.5
       ```
       The script auto-pulls token metadata from `config.yaml`, so refresh that file via `npm run sync:aave` before generating new variants.
      Single-hop pairs now only need one venue; if you include a second pool the solver will evaluate both automatically.
2. **Environment**: ensure `.env` contains
   - `FABRIC_CONFIG` (path to the config; defaults to the repo root copy),
   - `FABRIC_PROM_PORT` (default `9470`) so Prometheus can scrape the fabric metrics separately,
   - Optional `FABRIC_BRIDGE_WEBHOOK` if you want bridge intents pushed to Slack/PagerDuty/automation,
   - Redis/Postgres credentials (shared with the micro-liquidator).
3. **Census run** (log-only, no capital):
   ```bash
   npm run fabric
   ```
   Monitor `laf_edges_total`, `laf_edge_net_usd`, and the `laf_attempts` table to validate coverage before enabling execution.
4. **Active mode**: once the census shows healthy net opportunities, flip `global.mode` to `active`, fund the per-chain floats listed in `fabric.config.yaml`, and restart `npm run fabric`. Successful bundles increment `laf_exec_success_total`; bridge intents are written to `logs/fabric_bridge_intents.jsonl` (and to the webhook if configured).
5. **Replay** historical edges for analysis with:
   ```bash
   npm run laf:replay -- --file logs/laf.jsonl --min-net 1.0
   ```

### Monitoring & dashboards

- **Lint first**: `make verify-monitoring` runs `promtool`/`amtool` checks on the Prometheus and Alertmanager configs before you redeploy.
- **Bring the stack up**: `docker compose up -d postgres-exporter prometheus alertmanager loki promtail grafana` (start `worker` too if you want the in-compose orchestrator). Grafana lives at `http://localhost:3000` with `admin / uBBybxx3s@Bn7M`; the “Founder Ops” dashboard loads automatically.
- **Metrics**: Prometheus now scrapes both the compose worker (`worker:9464`) and a locally running orchestrator via `host.docker.internal:9464`, so dry-run canaries and live runs share the same charts. LAF exposes its own metrics on `worker:9470` and the series are tagged with `project=laf`. Keep an eye on `profit_estimated_total_usd`, `plans_failure_rate`, `candidates_gap_skip_total`, `simulate_duration_seconds`, `send_latency_seconds`, `rpc_errors_total{target=…}`, and for LAF specifically `laf_edge_net_usd`, `laf_edge_pnl_multiple`, and `laf_exec_success_total`.
- **Logs**: promtail ships container logs plus the repo `logs/` directory (dry-run bundles and `live.log`) into Loki (`http://localhost:3100`). Use the dashboard’s WARN+/ERROR panel or Grafana Explore for deeper queries.
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
