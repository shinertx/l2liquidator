# LAF Production Runbook

## Mission
Drive the Long-Tail Arbitrage Fabric to the top alpha engine on every supported L2 while keeping reverts < 1.5% and net USD/hour maximized. All actions optimize **smarter coverage, smarter sizing, smarter risk**.

---

## 1. Pre-flight Checklist

1. **Environment**
   - `FABRIC_CONFIG` points to the desired deployment YAML (e.g. `fabric.config.census-full.yaml`).
   - RPC env vars per chain set (`RPC_ARB`, `RPC_OP`, `RPC_BASE`, `RPC_POLY`).
   - Private relay targets configured (`PRIVTX_ARB`, etc.).
2. **Secrets**
   - Chain wallets funded with target float (`PER_CHAIN_FLOAT_USD`).
   - Bridge webhook (`FABRIC_BRIDGE_WEBHOOK`) reachable if intents should alert ops.
3. **Config Sanity**
   - Run `npm run preflight` – validates config + RPC reachability.
   - `npm run fabric -- --dry-run` (census mode) to ensure pair registry loads.
4. **Metrics Stack**
   - Prometheus up (`curl -sf localhost:9470/metrics`).
   - Grafana board `LAF Overview` shows data for last 15 minutes.

---

## 2. Starting the Fabric

```bash
cd liquidator
LOG_LEVEL=info FABRIC_CONFIG=$(pwd)/fabric.config.census-full.yaml npm run fabric
```

- Monitor `logs/fabric.log` and Grafana for the first 10 minutes.
- Confirm `laf_edges_total` rising and `laf_graph_skip_total` tracking gating decisions.

---

## 3. Real-time Monitoring

| Signal | Target | Action if Breached |
| ------ | ------ | ------------------ |
| `laf_edge_net_usd` p50 | ≥ $1.00 | Raise `MIN_NET_USD`, inspect venue health. |
| `laf_edge_pnl_multiple` p50 | ≥ 4× | Tighten venue list, verify gas modeling. |
| `laf_graph_skip_total` rate | Stable | Spike → price graph stale, check RPC latency. |
| Revert rate (Grafana panel) | < 1.5% | Auto-throttle triggers; review logs + venue rejects. |
| Inventory utilization | 50–80% | If <50%, lower floats; if >80%, enqueue bridge intents. |
| Bridge queue length | <5 | If ≥5 for >10m, escalate to ops for manual bridge. |

### Log Keywords
- `fabric-quoter-suppressed` – venue temporarily gated due to failures.
- `fabric-venue-pool-missing` – pool disappeared; regenerate config.
- `fabric-bridge-request` – inventory deficit; review `logs/fabric_bridge_intents.jsonl`.
- `fabric-risk-skip` reason `backoff` – revert streaks; inspect venue health.

---

## 4. Tuning Levers

1. **Dynamic Thresholds**
   - Increase `MIN_NET_USD` or `PNL_MULT_MIN` to reduce noise when gas spikes.
   - Lower thresholds cautiously (<20% per adjustment) and monitor revert rate.
2. **Venue Management**
   - Add to denylist via config hot reload for rug/malfunctioning pools.
   - Use PriceGraph freshness metrics to spot stale venues.
3. **Sizing**
   - `tradeSize` in config per pair; adjust to maintain <10% pool impact.
   - PriceGraph depth tiers (coming) will guide auto-sizing.
4. **Inventory**
   - Update chain float limits in config; bridge intents triggered automatically for deficits.
   - Nightly sweep script consolidates profits back to treasury.
5. **Cross-chain Modes**
   - Toggle `enableCrossChain` once per-chain float stable; monitor inclusion latency vs. profit.

---

## 5. Incident Response

1. **High Revert Spike (>3%)**
   - Check `fabric-quoter-failure-backoff` logs – adjust backoff if necessary.
   - Increase `MIN_NET_USD` by 0.25 and re-run. Verify venue health.
2. **RPC Degradation**
   - Switch to backup RPC via env var override.
   - Restart fabric once new RPC validated.
3. **Bridge Queue Overflow**
   - Execute manual bridge or trigger RFQ-based replenishment.
   - Confirm webhook delivered.
4. **Execution Failures**
   - Inspect `laf_exec_failed_total` tags to pinpoint source.
   - Replay attempt via `npm run fabric -- --replay <edgeId>` (future tool) or analyze logs.

---

## 6. Post-Run Review (Daily)

- Export Prometheus metrics snapshot for daily P&L reconciliation.
- Review `laf_graph_skip_total` vs. executed edges to ensure gating tuned.
- Check `logs/laf-census-*.jsonl` for novel venues lacking coverage.
- Update denylist/allowlist based on anomalies.
- Feed Alpha miner heuristics into config generator for next day.

---

## 7. Automation Hooks

- **Cron:** nightly `npm run harness -- --summary-only` against last N edges for regression.
- **Alertmanager:** page on revert rate, bridge backlog, or RPC outage.
- **CI:** run `npm run build` + targeted tests on every change touching `offchain/arb_fabric`.

---

## 8. Escalation Matrix

| Severity | Symptoms | Owner | SLA |
| -------- | -------- | ----- | --- |
| Sev-1 | Execution halted, revert >10% | Infra SRE | 15 min |
| Sev-2 | Profitability < break-even 2h | Quant + Engineer | 60 min |
| Sev-3 | Inventory imbalance > $25k | Treasury Ops | 4 h |
| Sev-4 | Metric gaps, stale dashboards | Analytics | Next business day |

---

Keep iterating – every dial is expected to push us toward smarter selection and compounding alpha. Document deviations, retain logs, and continuously feed learnings into the PriceGraph and solver heuristics.
