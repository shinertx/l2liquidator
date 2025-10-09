# Production Readiness Plan

_Last updated: 2025-10-09_

## Pending Inputs from Stakeholders

| Owner | Item | Notes |
| --- | --- | --- |
| User / Infra | Provide RPC & WebSocket endpoints for all target chains | Needed for fork tests, shadow runs, and monitoring validation |
| User / Wallet Ops | Supply staging/private keys and Safe details via secure channel | Required for dry-run mode, Safe automation rehearsals |
| User / Data | Authorize snapshot of recent `liquidation_attempts` rows and related logs | Fuels regression replay and analytics validation |
| Quant Lead | Review adaptive threshold defaults & fail-rate/kill-switch policy | Must sign off before canary |
| Ops / On-call | Pair on runbooks and alert routing plan | Ensures 24/7 coverage |
| Security | Evaluate Safe automation & RPC fallback secret handling | Gate before production rollout |

## Engineering Workstreams

### 1. Functional Validation
- Build fork/dry-run harness covering flash & funds modes
- Replay recent liquidation opportunities across chains
- Run 48h shadow deployment capturing hit/fail rates, sequencer status, inventory balances
- Stress test pipeline under load to verify throttles and kill switch behavior

### 2. QA & Automation
- Add unit tests for adaptive thresholds, RPC failover, and analytics calculations
- Add integration smoke tests for pipeline runner with mocked executor/attempts DB
- Create regression suite replaying historical attempts to validate metrics/exporters
- Wire the new suites into CI/CD

### 3. Operational Readiness
- Document runbooks, alert responses, Safe tooling, and analytics workflows
- Lock down unfinished protocol adapters behind flags until implemented
- Harden secrets management and validate Safe transaction paths
- Finalize Prometheus alert routing & escalation; test the new rules end-to-end

### 4. Rollout & Risk Controls
- Define canary scope (chain, caps, duration) and acceptance criteria
- Prepare rollback playbook (kill switch, orchestrator rollback, adaptive fallback)
- Rehearse Safe automation and kill-switch triggers
- Expand rollout chain-by-chain once canary metrics clear thresholds

## Execution Checklist

- [ ] Collect pending inputs listed above
- [ ] Implement fork/dry-run harness and regression suite
- [ ] Author runbooks and alert documentation
- [ ] Add automated tests & integrate with CI
- [ ] Execute canary with rollback rehearsal
- [ ] Obtain final stakeholder sign-offs
