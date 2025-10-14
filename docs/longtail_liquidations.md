# Long-Tail Protocol Scaffold

This repo now includes the minimum wiring needed to add non-Aave liquidation venues
without disturbing the existing production loop.

## Structure

- `offchain/protocols/types.ts` – shared protocol adapter interfaces.
- `offchain/protocols/aavev3.ts` – wraps the current Aave v3 pipeline in an adapter.
- `offchain/protocols/registry.ts` – central lookup. `aavev3` runs today and placeholder adapters for `silo`, `ionic`, and `exactly` are registered so code paths stay stable while their real implementations are built.

The orchestrator resolves the default adapter from the registry, so adding an additional
protocol does not change the behavior of the current Aave bot.

## Adding a new protocol

1. Create `offchain/protocols/<protocol>.ts` that implements `ProtocolAdapter`.
2. Register it in `registry.ts`.
3. Supply protocol-specific indexers/simulators that emit the shared `Candidate` shape.
4. Update `config.yaml` with `markets` entries that point at the new `protocol`.

Enable the protocol only after dry-run validation; nothing is active until a market
with the new `protocol` is marked `enabled: true`.
