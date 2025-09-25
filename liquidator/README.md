# L2 Micro-Liquidator (Arbitrum & Optimism) — MVP Scaffold

**Purpose**: Liquidate the long-tail of risky loans on Aave v3 using Aave flash liquidity, seize collateral with the protocol bonus, swap, repay flash + premium, keep spread. Designed for cheap L2 gas.

### Quickstart (dev)
1) **Install**
```bash
cd liquidator
npm i
forge install
```
2) **Configure**
- Copy `.env.sample` → `.env` and fill RPCs + private keys.
- Copy `config.example.yaml` → `config.yaml` and review markets.

3) **Compile & test**
```bash
forge build
forge test -vv
```

4) **Deploy Liquidator** (example: Arbitrum)
```bash
forge create --rpc-url $RPC_ARB --private-key $WALLET_PK_ARB contracts/Liquidator.sol:Liquidator \
 --constructor-args $AAVE_POOL_ARB $UNI_V3_ROUTER_ARB $BENEFICIARY
```

5) **Run orchestrator (shadow mode)**
```bash
npm run dev
```

	Or (ensures `${VAR}` interpolation via dotenv-expand without manually sourcing):
```bash
./scripts/dev_env.sh
```

6) **Go live (canary)**: enable 1–2 markets in `config.yaml` with high `minProfit`, tight `slippageBps`, `gapCapBps`.

**Not legal/financial advice. Use at your own risk.**

### Live ops checklist
- **Config**: set `beneficiary` to your Safe, populate `contracts.liquidator[chainId]` after deployment, and verify token/pool/router addresses against Aave & Uniswap docs.
- **Safety**: keep `risk.dryRun: true` for 12–24h canary to observe `would-fire` logs and price gaps before flipping to live.
- **Keys & funding**: export low-balance EOAs via `.env`, fund gas (ARB/OP) just-in-time, sweep proceeds to the Safe frequently.
- **Deployment**: `forge create` with the chain-specific pool/router above and your beneficiary, then record the address back into `config.yaml`.
- **Monitoring**: watch Prometheus gauges (`pnl_per_gas`, `hit_rate`), log-level `debug` for gap skips, and track failed tx hashes for revert reasons.
- **Shadow QA**: use `npm run dev` in dry-run plus `npx ts-node offchain/tools/replay-candidates.ts samples.json --limit 50` to replay captured candidates against live RPCs before flipping `dryRun` off.

### LLM policy agent (auto-tune but never auto-commit)

1. **Expose telemetry**
   ```bash
   npm run agent:serve    # serves /health, /metrics, /attempts, /quotes, /oracles, /propose on $AGENT_API_PORT (default 8787)
   ```
   Example queries:
   ```bash
   curl localhost:8787/metrics?seconds=3600 | jq
   curl localhost:8787/attempts?limit=50 | jq '.["rows"][].status' | sort | uniq -c
   curl "localhost:8787/quotes?chain=42161&pair=USDC-WETH&amount=10" | jq
   ```

2. **Let the LLM draft** (requires `OPENAI_API_KEY` + optionally `OPENAI_MODEL`):
   ```bash
   npm run agent:run
   ```
   The runner pulls the latest attempt telemetry, asks OpenAI for a YAML patch (routing / assets / risk only), and drops it into `config.staged.yaml` + `agent/proposals/<timestamp>.patch.yaml`. Analysis + hypothesis land in the paired JSON file.

3. **Validate / backtest**
   ```bash
   npm run agent:apply            # runs backtest gates, writes agent/latest-report.json
   npm run agent:apply -- --limit 400 --canary   # optional extra sample + write config.canary.yaml
   npm run agent:apply -- --apply  # promote staged config to config.yaml (after gates pass)
   ```
   Backtest uses the recorded candidate + plan snapshots stored in Postgres (`liquidation_attempts.details`). Gates fail if the new plan count drops more than 20% or avg net BPS falls >5% vs baseline.

4. **Canary then promote**
   - `config.canary.yaml` can be fed to a shadow orchestrator for 30–60 min (`AGENT_CANARY_FILE`).
   - When satisfied, `--apply` copies the staged config to `config.yaml` and backs up the previous version to `config.prev.yaml`.

5. **Manual proposals**
   ```bash
   curl -X POST localhost:8787/propose \
     -H 'content-type: application/json' \
     -d '{"patch": "assets:\n  USDC:\n    floorBps: 70", "hypothesis": "raise floor bps on USDC to cut near-miss reverts", "successMetric": "netUsd/hr +5%", "killSwitch": "revert if capture dips 10%"}'
   npm run agent:apply
   ```

**Important guardrails**
- The agent never touches keys or bypasses `minProfitUsd` / `pnlPerGasMin` / staleness checks.
- Every backtest/canary report is written to `agent/latest-report.json` (and the proposal folder).
- Rollback at any time with `cp config.prev.yaml config.yaml`.
- If Postgres is offline the agent API returns `503` and proposals are rejected.
