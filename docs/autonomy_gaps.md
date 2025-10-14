# Automation & Autonomy Assessment

_Date: 2025-10-13_

This note captures the current level of automation in the L2 Liquidator stack and highlights the remaining blockers to reach an "always-on" autonomous posture from the CLI.

## Components & Current State

| Component | Runtime | Autonomy Level | Notes |
|-----------|---------|----------------|-------|
| Aave L2 Liquidator orchestrator (`npm run dev`) | foreground shell / nohup | **Manual** | Requires explicit CLI invocation; PID tracking done via `logs/orchestrator.pid`. No auto-restart on crash or reboot. |
| Long-Tail Arbitrage Fabric (`npm run fabric`) | foreground shell / nohup | **Manual** | Same limitations as orchestrator; binds to Prometheus port 9470; no watchdog or restart policy. |
| Risk Engine (`docker compose`) | Docker container w/ `restart: unless-stopped` | **Semi-auto** | Auto-respawns but not managed by systemd; depends on docker daemon and manual `docker compose up`. |
| Worker container (`docker compose`) | Docker container w/ `restart: unless-stopped` | **Semi-auto** | Handles metrics and background tasks; reliant on docker compose lifecycle. |
| PostgreSQL (`docker compose`) | Docker container | **Semi-auto** | Restart policy covers crashes but not docker daemon restarts.
| Redis (`docker compose`) | Docker container | **Semi-auto** | Same as above. |
| Monitoring scripts (`scripts/monitor_liquidator.sh`) | Ad-hoc cron/manual | **Manual** | Script exists but not wired into cron/systemd timers; only covers orchestrator. |
| Alerting | _None_ | **Missing** | No automated notification on failure. |

## Identified Gaps

1. **Process supervision** for orchestrator & fabric is missing. Need systemd units with `Restart=always`, dependency ordering, and log routing.
2. **Lifecycle bootstrapping** is manual. System should self-start on host reboot (systemd service + docker compose).
3. **Health checks** limited to ad-hoc scripts. Need consolidated health probe + optional remediation hooks.
4. **Alerting pipeline** absent. Failure detection should trigger webhook/email/Slack notification with context.
5. **Configuration hygiene**. Critical env vars (`RPC_*`, `DATABASE_URL`, `ALERT_WEBHOOK_URL`) should be validated before services boot.
6. **Observability gaps**. Prometheus metrics exist but no automated scrape validation or Grafana alert rules.

## Proposed Remediation

1. **Systemd units** for orchestrator & fabric invoking dedicated launcher scripts inside `/home/benjaminjones/l2liquidator`.
2. **Systemd unit** for docker compose stack or convert to `docker compose up` service to ensure database/redis/worker come up automatically.
3. **Health watchdog** script (TypeScript/Node or Bash) executed via systemd timer/cron to verify:
   - PIDs alive
   - Prometheus endpoints responding (orchestrator, fabric, worker)
   - DB/Redis connectivity
   - Queue backlog / attempt error rate
4. **Alert notifier** script using `ALERT_WEBHOOK_URL` (Slack/Discord) + optional email fallback.
5. **Env validation CLI** executed prior to service start (reuse `scripts/check_env.ts`).
6. **Documentation upgrades** in `README.md` describing how to enable/disable autonomy features, required env, and recovery procedures.

## Next Steps

1. Implement systemd service + timer assets under `ops/systemd/`.
2. Add `scripts/start_orchestrator.sh`, `scripts/start_fabric.sh`, `scripts/healthcheck.ts`, and `scripts/alert.sh`.
3. Wire systemd timer for health checks & alert script.
4. Update README+docs reflecting new automation.
5. Conduct end-to-end test with simulated failure to validate restart + alert flow.
