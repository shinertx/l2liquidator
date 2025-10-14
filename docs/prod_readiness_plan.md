# Production Readiness Plan

_Last updated: 2025-10-09_

## Pending Inputs from Stakeholders

| Owner | Item | Notes |
| --- | --- | --- |
| User / Infra | Provide RPC & WebSocket endpoints for all target chains | Needed for fork tests, shadow runs, and monitoring validation |
| User / Wallet Ops | Supply staging/private keys and Safe details via secure channel | Required for dry-run mode, Safe automation rehearsals |
| User / Data | Authorize snapshot of recent `liquidation_attempts` / `laf_attempts` rows and related logs | Fuels regression replay and analytics validation |
| Quant Lead | Review adaptive threshold defaults, LAF solver thresholds, fail-rate/kill-switch policy | Must sign off before canary |
| Ops / On-call | Pair on runbooks and alert routing plan (liquidator + LAF) | Ensures 24/7 coverage |
| Security | Evaluate Safe automation, bridge webhook handling, RPC fallback secret management | Gate before production rollout |

## Engineering Workstreams

### 1. Functional Validation
- ✅ Build fork/dry-run harness covering flash & funds modes (`npm run harness`)
- ✅ Add LAF census + replay tooling (`npm run laf:replay`)
- Replay recent liquidation opportunities and LAF census edges across chains
- Run 48h shadow deployment capturing hit/fail rates, sequencer status, inventory balances, `laf_edge_*` metrics
- Stress test pipeline under load to verify throttles, kill switch behavior, and LAF back-off logic

### 2. QA & Automation
- Add unit tests for adaptive thresholds, RPC failover, analytics calculations, and LAF risk manager
- Add integration smoke tests for pipeline runner with mocked executor/attempts DB and LAF solver yields
- ✅ Create regression suite replaying historical attempts to validate metrics/exporters (`npm run replay:attempts -- --file ...`)
- ✅ Hook LAF census replay script into local QA (`npm run laf:replay`)
- Wire the new suites into CI/CD

### 3. Operational Readiness
- ✅ Document runbooks, alert responses, Safe tooling, and analytics workflows (`docs/runbooks/liquidator_runbook.md`)
- ✅ Add LAF runbook supplement (`docs/runbooks/liquidator_runbook.md`)
- Lock down unfinished protocol adapters behind flags until implemented
- Harden secrets management, validate Safe transaction paths, and ensure bridge webhook secrets stored securely
- Finalize Prometheus alert routing & escalation (liquidator + LAF); test the new rules end-to-end

### 4. Rollout & Risk Controls
- Define canary scope (chain, caps, duration) and acceptance criteria for both liquidator and LAF
- Prepare rollback playbook (kill switch, orchestrator rollback, adaptive fallback, LAF mode toggle)
- Rehearse Safe automation, bridge intent handling, and kill-switch triggers
- Expand rollout chain-by-chain once canary metrics clear thresholds

## Execution Checklist

- [ ] Collect pending inputs listed above
- [ ] Implement remaining QA items (unit + integration coverage) and wire into CI
- [ ] Validate bridge automation end-to-end with synthetic intents
- [ ] Execute canary (liquidator + LAF) with rollback rehearsal
- [ ] Obtain final stakeholder sign-offs
