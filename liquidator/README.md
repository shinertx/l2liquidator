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
