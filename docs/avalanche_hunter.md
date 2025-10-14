# Avalanche Hunter — Long-Tail Liquidation Roadmap

The “Avalanche Hunter” track extends the existing L2 micro-liquidator to under-botted isolated markets (Silo, Ionic, Exactly, Radiant, etc.). The adapter registry is already wired; this document tracks the remaining work needed to ship each venue.

## Core Components to Implement

| Area | Aave Status (baseline) | Avalanche Hunter TODO |
| --- | --- | --- |
| Protocol adapters (TS) | `offchain/protocols/aavev3.ts` | Implement `silo.ts`, `ionic.ts`, `exactly.ts` with real simulator logic (HF, bonus, close factor); return `Plan` objects |
| Protocol adapters (Solidity) | `contracts/Liquidator.sol` handles Aave | Add adapter contracts or inline venue calls if liquidation interfaces differ; update Liquidator routing |
| Indexers | `offchain/indexer/aave_indexer.ts` + realtime watchers | Stubs live at `offchain/indexer/{silo,ionic,exactly}_indexer.ts`; replace placeholders with real WS/HTTP logic |
| Config | `config.yaml` markets only list `protocol: aavev3` | Populate markets per venue (address, bonus, closeFactor, enabled flag); extend `dexRouters` with venue-preferred DEXes |
| Simulator | `offchain/simulator/simulate.ts` handles Aave | Create venue-specific simulate functions (may wrap shared router logic) |
| Execution | `offchain/executor/send_tx.ts` | Dispatch based on `plan.protocol`; ensure flash/inventory modes align with venue requirements |
| Testing & Ops | Existing dry-run, analytics, kill switch | Fork tests per venue, revert telemetry, per-protocol kill toggle, router approvals, private keys for new markets |

## Venue Checklist

For each target venue (duplicate as needed):

### Silo (Arbitrum)

- [ ] Collect liquidation parameters (close factor, bonus, debt/collateral addresses)
- [ ] Implement `offchain/protocols/silo.ts` simulate logic (stub exists)
- [ ] Flesh out `offchain/indexer/silo_indexer.ts` with WS/HTTP feed (stub exists)
- [ ] Wire `plan.protocol === 'silo'` execution in `send_tx.ts` / Liquidator adapter (orchestrator dispatch is ready)
- [ ] Add markets + routing entries in `config.yaml`
- [ ] Dry-run on fork, validate revert reasons, measure profit/gas
- [ ] Flip `enabled: true` only after successful dry run

### Ionic (Base)

- [ ] Gather liquidation interface (flash availability, bonus, assets)
- [ ] Implement protocol adapter + simulator (stub exists)
- [ ] Build indexer / candidate stream (stub exists)
- [ ] Update config routing (likely UniV2/Solidly pools)
- [ ] Execute dry runs, add monitoring & kill switch entries

### Exactly / Granary / Radiant (Optimism, Polygon, etc.)

- [ ] Repeat the adapter/indexer/config steps above (stubs exist for adapter/indexer)
- [ ] Validate per-venue quirks (e.g., interest accrual, repay incentives)

## Operational Considerations

- **Flash loan vs inventory**: Many smaller venues lack flash hooks. Maintain per-chain floats or identify compatible flash providers.
- **Router approvals**: Run `npm run routers:allow` for new DEX routers per chain.
- **Risk tuning**: Per-venue `minProfitUsd`, `pnlPerGasMin`, and `gasCapUsd` need tuning based on observed volatility.
- **Monitoring**: Extend Prometheus/Grafana dashboards to tag metrics by `protocol`. Track success rate, avg profit, conflict rate, revert codes.
- **Kill-switch**: Ensure `kill_switch` supports per-protocol disables so experimental venues can be halted without affecting Aave.

## References

- `offchain/protocols/registry.ts` – register new adapters here.
- `ARCHITECTURE.md` – high-level system flow plus Avalanche Hunter overview.
- `docs/longtail_liquidations.md` – initial scaffold notes.

Update this document as venues go live; mark checklist items complete with dates and PR references.

## Avalanche Hunter v2 Build Plan

To deliver the sealed runner, tackle the upgrades in the following order:

1. **Core Architecture Prep**
	- Finalize `ARCHITECTURE.md` v2 blueprint (✅).
	- Add `.env` knobs (`PNL_MULT_MIN`, `PRIVATE_RELAYS`, etc.) and default values in `ops/env.sample`.
	- Extend config schema if new risk knobs are required.

2. **Adapter & Watcher Expansion**
	- Promote Morpho/Silo adapters from stubs; implement discovery + candidate streaming.
	- Wire watcher services to publish into Redis/Kafka (or the in-memory queue fallback).
	- Unit-test candidate normalization across protocols.

3. **Scorer Enhancements**
	- Introduce gas curve + revert-rate aware scoring (min net USD, pnl/gas multiple, volatility mode).
	- Add dual-price / depeg toggles and ensure property tests enforce `net > 0`.

4. **Executor + Exit Router**
	- Implement bundled execution with optional flash borrow per protocol.
	- Build RFQ + intent integrations alongside existing AMM routing.
	- Enforce per-market semaphores and private relay-only submission.

5. **Treasury Automation**
	- Create USDC bucket tracker and scheduled sweep scripts.
	- Implement auto gas top-ups and per-chain spend caps.

6. **SLO Gates & Failure Remediation**
	- Add metrics for inclusion p95, revert %, pnl/gas, net USD/hour.
	- Build auto-pause + concurrency scaling logic tied to SLO thresholds.
	- Encode failure responses (tip bumps, relay rotation, size clamps).

7. **Hardening & Supply Chain**
	- Produce reproducible Docker image, sign with `cosign`, verify signature at boot.
	- Integrate HSM/remote signer support and config hash checks.
	- Disable public mempool submission at process level.

8. **Testing & Rollout**
	- Fork replay (30–90d) with randomized gas/oracle lag.
	- Canary Silo Arbitrum (dry-run → live) followed by Morpho; enable RFQ/Intent after stable AMM fills.
	- Document nightly sweeps, gas budgets, and daily performance reporting.

Track progress by ticking off items above and linking to PRs or ops notes. Once phases 1–8 are complete, Avalanche Hunter v2 qualifies as the sealed black-box runner.
