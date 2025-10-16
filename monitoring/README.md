# Founder Ops Monitoring Runbook

Welcome to the zero-to-ops bundle for the L2 Micro-Liquidator. This guide covers how to launch the stack, interpret the “Founder Ops” Grafana board, and respond to alerts.

## 1. Quickstart

```bash
# from repo root
make verify-monitoring        # static lint for Prometheus + Alertmanager configs
docker compose up -d db redis # ensure backing services are available
docker compose up -d worker   # optional: run orchestrator inside compose
# bring the observability stack online
docker compose up -d prometheus alertmanager loki promtail postgres-exporter grafana
```

Access Grafana at <http://localhost:3000> — credentials: `admin` / `uBBybxx3s@Bn7M`. The default landing page is the “Founder Ops” dashboard.

To stop the stack safely:

```bash
docker compose down grafana prometheus alertmanager loki promtail postgres-exporter
```

## 2. Dashboard Tour

- **Hero Stat Grid (top row)**
  - *Net Profit (USD)* – Sum of `profit_estimated_total_usd` for the selected chains/mode/time window.
  - *Capture Rate* – `plans_sent_total / plans_ready_total`; green ≥90%, orange 70–90%, red <70%.
  - *Plans Sent* – Raw count of broadcasts.
  - *Fail Rate* – Errors vs (sent + errors); keep under 2%.
  - *Avg PnL per Gas* – Average `pnl_per_gas` gauge across the window.
- **Trendlines**
  - *Profit Rate (USD/h)* – 1‑hour rate of change per chain.
  - *Plan Funnel* – Ready vs Sent vs Error deltas; helps spot policy choke points.
  - *Sequencer Health* – Increments of `candidates_sequencer_skip_total`.
  - *RPC Error Rate* – `rpc_errors_total` per provider (public vs private).
- **Coverage**
  - *Protocol Markets Enabled* – Live count of `protocol_markets_enabled` per chain/protocol. Sudden drops usually mean config drift or a disabled market.
  - *Fabric Venue Coverage* – Ready vs configured pairs plus missing count; use it to confirm two viable pools per Fabric pair before going live.
- **Skips & Taxonomy**
  - Gap skip bar chart (top 25 reason strings, truncated).
  - Table of gap/policy skips by asset & reason via Postgres.
- **Drill-down Tables**
  - Latest 50 attempts (borrower, status, reason, tx hash link).
  - Top borrowers in the last 6h.
  - Mode breakdown (dry-run vs live) for the last 24h.
- **Logs**
  - Loki-backed stream filtered to `level` ≥ warn for quick triage.

Dashboard variables:

- `Chain` (multi-select, default All)
- `Mode` (live vs dry-run)
- `Window` (1h/6h/24h/72h/168h)

Auto-refresh is set to 30s. The entire dashboard uses the dark theme and is meant to be phone-friendly for founders on the go.

## 3. Prometheus & Alerting

- Prometheus scrapes:
  - `worker:9464` (compose orchestrator)
  - `host.docker.internal:9464` (host-mode orchestrator)
  - `postgres-exporter:9187`
  - `loki:3100`, `promtail:9080`, `alertmanager:9093`, and Prometheus self
- Rules live in `monitoring/prometheus_rules.yml` and are checked by `make verify-monitoring`.
- Alert summaries:
  - **HighFailRate** – fail ratio > 20% for 5m
  - **CaptureDrop** – >10 ready but zero sent in 5m
  - **SequencerDegraded** – sequencer skip increments for 2m
  - **RpcRateLimit429** – 429 error bucket >0 in 15m window
  - **ProtocolMarketsDisabled** – `protocol_markets_enabled` hits zero for Aave or Morpho on any chain for 10m
  - **FabricVenueRegression** – configured Fabric pairs exceed ready pairs for 15m
  - **MonitoringTargetDown** – any scrape target down for 1m
- Alertmanager ships notifications to `http://localhost:18000/webhook`. Replace this endpoint in `monitoring/alertmanager.yml` with your Slack/PagerDuty webhook and restart `docker compose up -d alertmanager prometheus`.

## 4. Postgres Exporter

`postgres-exporter` runs with custom queries defined in `monitoring/postgres_exporter_queries.yml` to expose:

- Attempt counts by status (24h)
- Gap skip reasons (24h, top 25)
- Error buckets (15m; includes 429 detection)
- Insert rate (5m)

These metrics drive the skip taxonomy panel and alerting on RPC 429s.

## 5. Dry-run vs Live Ops

- `scripts/dry_run_12h.sh` now refuses to launch if `risk.dryRun=false` (prevents port contention).
- To switch to dry-run safely:
  1. Set `risk.dryRun: true` in `config.yaml`.
  2. Run `./scripts/dry_run_12h.sh` (creates new log bundle + PID).
  3. Revert `risk.dryRun: false` after the canary period; rerun the script to confirm it refuses.
- Live mode expects either the host orchestrator (`npm run dev`) or the compose `worker` service. Only run one at a time.

## 6. Troubleshooting Checklist

| Symptom | Checks | Fix |
| --- | --- | --- |
| Grafana blank panels | `docker compose ps` (targets running?) | `docker compose up -d …` to restart services |
| Prometheus target down | `curl http://localhost:9090/api/v1/targets` | Restart the failing service; check logs via `docker compose logs <svc>` |
| Grafana password reset | Update `GF_SECURITY_ADMIN_PASSWORD` in `docker-compose.yml`, `docker compose up -d grafana` |
| Postgres exporter no data | Confirm `db` is running and reachable (`docker compose logs postgres-exporter`) |
| Alert flood | Silence in Alertmanager UI (`http://localhost:9093`), investigate root cause, adjust rule thresholds if needed |

## 7. Pre-built Prometheus Links

- Capture rate: <http://localhost:9090/graph?g0.expr=sum(increase(plans_sent_total%5B5m%5D))%20%2F%20clamp_min(sum(increase(plans_ready_total%5B5m%5D)),1)&g0.tab=0>
- Profit rate (USD/h): <http://localhost:9090/graph?g0.expr=sum(rate(profit_estimated_total_usd%5B5m%5D)*3600)&g0.tab=0>
- Sequencer skips: <http://localhost:9090/graph?g0.expr=increase(candidates_sequencer_skip_total%5B5m%5D)&g0.tab=0>

## 8. Alert Simulation

- **HighFailRate**: force three consecutive revert errors (e.g., run replay tool with intentionally bad tx). Monitor `plans_error_total` rising; alert should fire in <5 minutes.
- **CaptureDrop**: Temporarily set `risk.maxLiveExecutions=0`, feed >10 candidates (replay). Ready counter increases, sent stays zero → alert.
- **RPC 429**: Point RPC to a throttled endpoint; the Postgres exporter bucket `429_rate_limit` should increment and trigger `RpcRateLimit429`.

## 9. Resetting the Stack

```bash
docker compose down -v grafana prometheus alertmanager loki promtail postgres-exporter
rm -rf grafana-data loki-data
```

Re-run the quickstart section afterwards.

## 10. Post-Change Verification Checklist

After deploying routing or guardrail updates, run this 15-minute checklist before leaving the founder desk:

1. **Restart orchestration** – bounce the worker (`docker compose restart worker`) or relaunch the host orchestrator so the new codepaths load. Confirm the boot log includes the `route-coverage` summary for every chain.
2. **Prometheus scrape** – hit `curl -s http://localhost:9464/metrics | grep -E 'candidate_health_factor|route_option_count'` and verify per-chain samples update every few minutes. The health-factor histogram should show activity even when candidates are skipped.
3. **Grafana panels** – add two panels (if not already present):
  - *HF Histogram* using `histogram_quantile(0.5, sum(rate(candidate_health_factor_bucket[5m])) by (le, chain))` to watch median drift.
  - *Route Depth* plotting `route_option_count` per pair to spot sudden drops in liquidity coverage.
4. **WebSocket failover drill** – temporarily set `RPC_WS_FALLBACK_<CHAIN>` to a second endpoint and tail the logs. Unplug Alchemy or revoke its key for a minute; ensure the `rpc-ws-fallback-used` log appears and realtime watchers continue streaming.
5. **Dry-run spot check** – execute `./scripts/dry_run_12h.sh` for 5 minutes (Ctrl+C afterwards) to ensure dry-run mode still honors the new metrics and fails fast if guardrails misbehave.
6. **DB audit** – run `docker compose exec db psql -U liquidator -c "select chain_id, status, count(*) from liquidation_attempts where created_at > now() - interval '10 minutes' group by 1,2 order by 1,2;"` and verify the ratio of `policy_skip` with reason `hf` tightens after adaptive tweaks.

Document completion of each deployment in your ops journal (Notion → Liquidator Ops → Post-Change Logs) with Prometheus snapshots and log excerpts attached.
