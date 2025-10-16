# Liquidator Operations Runbook

_Last updated: 2025-10-09_

## 1. Daily Health Checks

- [ ] **RPC posture**: Verify `npm run harness -- --input logs/latest_candidates.jsonl --summary` reports live flash plans for each enabled chain.
- [ ] **Prometheus scrape**: Confirm `pnl_per_gas`, `send_latency_seconds`, and `candidate_drop_reason_total` are updating. If idle > 10 minutes, check indexer logs for stall warnings.
- [ ] **Sequencer heartbeat**: Ensure `sequencer_status{stage="pre_sim"}` == 1 for all active chains. If 0 for >2 minutes, pause sends via kill switch.
- [ ] **Inventory buffers (funds mode)**: Inspect `inventory_balance` gauges. Trigger treasury top-up when balance < 1.5 × largest repay amount for the chain.
- [ ] **Alert queue**: Sweep PagerDuty / Slack alert channel for unresolved incidents.

## 2. Pre-Deployment Checklist

1. Run `npm run build && npm run test:unit`.
2. Execute `npm run harness -- --input fixtures/canary_sample.jsonl --mode both --summary` using the staging Anvil fork; confirm ≥1 flash plan and funds eligibility for each target chain.
3. Replay the latest 60 minutes of attempts: `npm run replay:attempts -- --minutes 60 --status sent` and confirm zero regressions.
4. Verify canary config flags (dry run, attempt caps, throttles) in `config.yaml` and `.env`.
5. Ensure Safe owners have acknowledged the planned rollout window.

## 3. Incident Procedures

### 3.1 Kill Switch Activation

1. Touch the kill switch file (`KILL_SWITCH_FILE`) or toggle the Safe guardrail transaction.
2. Confirm orchestrator logs show `kill-switch-engaged-stopping` within 30 seconds.
3. Record incident in PagerDuty, include root cause hypothesis and chain scope.
4. After remediation, clear kill switch and restart orchestrator, monitoring hit rate for 10 minutes before re-enabling funds mode.

### 3.2 Elevated Revert Rate (>2%)

1. Run `npm run replay:attempts -- --minutes 30 --status error` to identify regression patterns.
2. Inspect adaptive threshold logs for volatility spikes; consider tightening `MIN_NET_USD` or disabling affected markets.
3. If revert ratio remains >2% after 3 consecutive attempts, flip to dry-run mode (`RISK.dryRun = true`) and notify Quant + Ops channels.

### 3.3 RPC Outage

1. Engage fallback by updating `.env` `RPC_WS_FALLBACK_*` entries or swapping to backup URLs.
2. Restart orchestrator with `RPC_ONLY=true` to force HTTP clients while WS recovers.
3. Run `npm run harness -- --input fixtures/canary_sample.jsonl --mode flash --summary` to ensure flash planning works via fallback endpoints.
4. Keep incident open until websocket stability restored for ≥30 minutes.

## 4. Canary Rollout Playbook

1. **Scope**: Enable single chain (default Arbitrum) with flash mode only, profit floor ≥ $3, revert threshold ≤1%.
2. **Duration**: 2 hours of live sends with continuous monitoring.
3. **Acceptance Criteria**:
   - ≥90% of planned sends succeed.
   - `send_latency_seconds` p95 < 0.25s.
   - No kill-switch triggers.
4. **Rollback**: If any criterion fails, immediately re-enable dry-run mode, trigger kill switch, and replay attempts to pinpoint regression.
5. **Post-Canary**: Summarize metrics in #ops-liquidations, capture follow-ups in Jira, and schedule next chain ramp.

## 5. Communication Matrix

| Scenario | Primary | Secondary | Notes |
| --- | --- | --- | --- |
| Routine deploy | Ops On-call | Quant Lead | Share pre-deploy checklist results |
| Kill switch engaged | Ops On-call | Security | PagerDuty Sev1 |
| Revert >2% | Ops On-call | Quant Lead | Consider adaptive policy changes |
| RPC outage | Ops On-call | Infra SRE | Provide ETA + affected chains |

## 6. Reference Commands

```bash
# Dry-run planning on forked chain
npm run harness -- --input fixtures/canary_sample.jsonl --mode flash --fork-rpc http://127.0.0.1:8545

# Replay last 45 minutes from file snapshot
npm run replay:attempts -- --file snapshots/liquidation_attempts.jsonl --limit 200
```

## 7. Escalation Ladder

1. Ops On-call (primary)
2. Infra SRE (secondary)
3. Quant Lead
4. Founder / Product (if financial loss expected)

Document open questions, improvements, and post-incident reports in `docs/runbooks/CHANGELOG.md` (to be added).

## 8. Morpho Blue (Base) Dry-Run Playbook

1. **Environment prep**
   - Confirm a funded Base RPC endpoint (`RPC_BASE`) and private key (`WALLET_PK_BASE`) are present in `.env`. Optional: set `PRIVTX_BASE` if a private mempool relay will be exercised.
   - Ensure the Base liquidator address is recorded under `contracts.liquidator["8453"]` (already committed for production).
2. **Config gating**
   - In `config.yaml` set `risk.dryRun: true` (global) or add `chains[].risk.dryRun: true` for Base specifically.
   - Toggle other chains to `enabled: false` during the drill to keep logs focused on Base. Keep the Base Morpho market entry (`protocol: morphoblue`, `debtAsset: wBTC`, `collateralAsset: cbBTC`) `enabled: true`.
3. **Safety caps**
   - Leave `maxLiveExecutions`, `maxSessionNotionalUsd`, and `maxAttemptsPerBorrowerHour` unchanged; in dry-run mode they gate planning only but help mirror live behaviour.
4. **Launch**
   - Start the orchestrator in dry-run mode: `npm run dryrun` (writes rotating logs to `logs/dryrun_*.log`).
   - Verify boot logs show `chain="base" protocol="morphoblue" status="dry_run"` events with `DRY-RUN` markers in the structured log stream.
5. **Validation**
   - Check Prometheus `plans_dry_run_total{protocol="morphoblue"}` increments and confirm no `plan-null` drop reasons besides expected policy filters.
   - Review the latest dry-run log file for at least one candidate where `estNetBps` > policy floor and ensure `inventory_mode` warnings are absent.
6. **Shutdown & reset**
   - Stop the orchestrator with `Ctrl+C` once satisfied.
   - Revert any temporary `enabled: false` edits (e.g., `git checkout -- config.yaml`) if they were only for the drill.

## 9. Morpho Blue (Base) Live Ramp

1. **Pre-flight checklist**
   - Pass `npm run build`, `npm run test:unit`, and one fresh dry-run session (see Section 8) within the last 24 hours.
   - Confirm the Base wallet holds sufficient native ETH for gas and a buffer of the repay asset (`wBTC`) if inventory mode is active. Treasury should stage top-ups before go-time.
   - Validate Morpho RPC connectivity by running `npm run harness -- --input fixtures/morpho_canary.jsonl --mode flash --summary` (fixture lives under `offchain/tests/fixtures`).
2. **Config toggles**
   - Set `risk.dryRun: false` (global) or remove the Base override.
   - Maintain conservative caps: `maxLiveExecutions <= 5`, `maxSessionNotionalUsd <= 5000`, `maxAttemptsPerBorrowerHour <= 2` for the first live window. Increase gradually only after proving stability.
   - Leave non-Base chains disabled until the Base-only canary window succeeds.
3. **Launch command**
   - Start the orchestrator with `npm run dev`. Keep the session in a dedicated tmux pane; redirect stdout to `logs/live_base_morpho_<timestamp>.log` if long-lived.
   - Verify boot metrics (`plans_ready_total`, `send_latency_seconds`) populate for `protocol="morphoblue"` within five minutes. First `plan-sent` events should carry `source=subgraph` and a `planId`.
4. **Live monitoring**
   - Tail logs for `plan-sent` and `send-success` entries. Expected send latency p95 < 150ms and revert rate < 2%.
   - Watch Prometheus `pnl_multiple` and `pnl_per_gas` gauges for positive drift; alert if `candidate_drop_reason_total{reason="inventory_empty"}` increments.
   - Track the Base wallet balance every 15 minutes; top up if balance < 1.2 × largest repay amount.
5. **Incident & rollback**
   - If revert ratio exceeds 2% or PnL multiple turns negative, immediately toggle `risk.dryRun: true`, restart the orchestrator, and open an Ops incident.
   - Engage the kill switch if any flash loan repayment fails or sequencer outage persists >2 minutes. Document root cause before resuming live mode.
6. **Post-canary wrap-up**
   - Summarize metrics (plans, sends, net USD) in `#ops-liquidations` and capture follow-ups in the incident tracker.
   - Re-enable other chains only after two consecutive healthy Base live windows.

---

# Long-Tail Arbitrage Fabric (LAF) Runbook

_Supplemental to the liquidator runbook. Only relevant if `npm run fabric` is in use._

## A. Daily Health Checks

- [ ] **Census/Active mode**: Confirm `global.mode` in `fabric.config.yaml` matches the intended run state for each environment.
- [ ] **Prometheus**: Verify `laf_edge_net_usd`, `laf_edge_pnl_multiple`, and `laf_exec_success_total` are incrementing. No movement for >10 minutes means solver coverage is stalled—inspect `laf-edge-census` logs.
- [ ] **Bridge intents**: Tail `logs/fabric_bridge_intents.jsonl` (or the `FABRIC_BRIDGE_WEBHOOK` destination) for outstanding “high” priority intents; ensure treasury automation has cleared them.
- [ ] **Inventory**: Review `fabric_bridge_request` warnings and compare against configured floats in `fabric.config.yaml`.
- [ ] **Redis / Throttles**: Check the `laf-throttle` keys in Redis; unusually high counts indicate repeated skips and should trigger solver tuning.

## B. Pre-Deployment Checklist

1. Update `fabric.config.yaml` with the pairs/venues to canary.
2. Run **census mode** for ≥60 minutes: `npm run fabric` with `global.mode=census`.
3. Replay the census log to quantify net: `npm run laf:replay -- --file logs/laf.jsonl --min-net 1.0`.
4. Confirm `laf_attempts` Postgres table is reachable (`\d laf_attempts`).
5. Verify bridge automation reacts to synthetic intents (simulate by calling `BridgeBroker.publish` via a small script).
6. Ensure per-chain floats are funded and Safe signers are ready.

## C. Incident Procedures

### C.1 Solver Stalled

1. Inspect runner logs for `fabric-solver-failed` or RPC errors.
2. Check Redis for throttled keys; increase `FABRIC_THROTTLE_LIMIT` temporarily if legitimate flow is being dropped.
3. Re-run census mode to refresh full coverage before re-entering active mode.

### C.2 Elevated Failure / Revert Rate

1. `SELECT * FROM laf_attempts WHERE status='error' ORDER BY created_at DESC LIMIT 50;`
2. If reverts stem from insufficient depth, shrink `tradeSize.baseAmount` or raise `slippageBps`.
3. More than three consecutive execution failures on a pair auto-triggers risk back-off; leave in census mode until the back-off clears.

### C.3 Bridge Intent Flood

1. Triage `logs/fabric_bridge_intents.jsonl`; ensure automation acknowledged each intent.
2. If automation lags, manually rebalance floats or temporarily set `global.mode=census`.
3. Confirm treasury sweep jobs complete before re-enabling `active`.

## D. Reference Commands

```bash
# Start census mode
npm run fabric

# Active mode (after toggling fabric.config.yaml)
npm run fabric

# Replay census log
npm run laf:replay -- --file logs/laf.jsonl --min-net 1.0

# Inspect per-pair throttles (Redis CLI)
redis-cli -p 6380 --raw keys 'laf:*'
```

## E. Escalation Ladder

1. LAF Operator (primary)
2. Infra SRE
3. Treasury Operations (for bridge issues)
4. Founder / Product if repeated losses occur

---

Outstanding roadmap items: non-Aave adapters (Silo/Ionic) remain stubbed by design, and the RFQ/intent codec is still pending upstream contract support—keep large BTC/cbBTC clips capped until that lands. Fabric enhancements (additional venues, cross-chain execution) live under `offchain/arb_fabric` and are tracked in the main backlog.
