
Prime Directive

Our primary directive is to build the world's most profitable and efficient liquidation engine. Every change must make the system smarter, faster, or more reliable, while relentlessly simplifying our architecture. We prize elegant, robust solutions and reject complexity that doesn't yield a significant, measurable return. the goal is to maximize net USD/hour, capture ≥90% opportunities, revert <2%, inclusion p95 <100ms, compounding into $MM/day.

# Project Overviews


This repository contains two complementary automated trading systems: the L2 Liquidator and the Long-Tail Arbitrage Fabric (LAF).

*   **L2 Liquidator:** The goal is to profitably liquidate undercollateralized Aave v3 positions on L2 networks.
*   **Long-Tail Arbitrage Fabric (LAF):** The goal is to generate profit by exploiting persistent price mispricings across a wide variety of assets and DEXes on L2s.

These two systems share the same core infrastructure but operate on different opportunities. The Liquidator is highly specialized for Aave, while the LAF is a general-purpose arbitrage engine. They are designed to work together without conflict, maximizing overall profitability.

---

# Prime Directive

Our primary directive is to build the world's most profitable and efficient liquidation engine. Every change must make the system smarter, faster, or more reliable, while relentlessly simplifying our architecture. We prize elegant, robust solutions and reject complexity that doesn't yield a significant, measurable return.

## Roles

- **Founder** – Sets ruthless clarity of vision, prioritizes compounding value creation, enforces safety + profit guardrails.
- **Quant** – Designs liquidation math, sim accuracy, policy floors, gas/pnl economics. Push capture rate to theoretical max.
- **Engineer** – Builds ultra-low-latency pipelines (WS indexers, private lanes), ensures reliability, removes bottlenecks.
- **Infra SRE** – Maintains redundancy (multi-RPC, relays), monitors p95 latency SLOs, automates alerts + failovers.
- **Router Tuner** – Re-orders DEX/fee-tier routes per market regime, minimizes slippage, increases per-trade profitability.
- **Oracle Guard** – Validates Chainlink feeds, enforces staleness checks, swaps to TWAP fallback when stale, reverts safely.
- **Execution Agent** – Chooses inclusion strategy (conditional OP, priority bumps ARB), fans out txs with nonce discipline.
- **Researcher** – Surfaces new venues (Compound v3, Morpho, Radiant), drafts adapters, stages canary rollout plans.

## Shared Goal

Every agent: maximize net USD/hour, capture ≥90% opportunities, revert <2%, inclusion p95 <100ms, compounding into $MM/day.

# GitHub Copilot Instructions for L2 Micro-Liquidator

## Project Overview
This is an L2 Micro-Liquidator for Aave v3 and Morpho Blue across Arbitrum, Optimism, Base, and Polygon. The system identifies risky loans, executes flash loan liquidations (or pre-liquidations for Morpho), seizes collateral with protocol bonuses, swaps through DEX venues, repays flash loans, and keeps the spread as profit. Token metadata and policy guardrails are auto-synced via `npm run sync:aave` and `npm run sync:morpho`; avoid manual edits to `config.yaml` and rely on the generators.

## Architecture Components

### Smart Contracts (`contracts/`)
- **`Liquidator.sol`**: Main liquidation contract with flash loan capabilities
- **Interfaces**: Aave v3 Pool, ERC20, Flash Loan Receiver, Uniswap V3 Router
- Uses Solidity ^0.8.24 with Foundry framework
- Key features: flash loan receiver, on-chain profit guards, slippage protection

### Off-chain System (`offchain/`)
- **`orchestrator.ts`**: Main coordinator that ties all components together
- **`indexer/`**: Monitors Aave and Morpho Blue positions and price feeds
  - `aave_indexer.ts`: Streams Aave v3 liquidation candidates
  - `morphoblue_indexer.ts`: Streams Morpho Blue candidates with pre-liquidation enrichment
  - `price_watcher.ts`: Tracks oracle vs DEX price gaps
- **`protocols/`**: Protocol-specific adapters
  - `morphoblue.ts`: Morpho Blue adapter (unified standard + pre-liquidation)
- **`executor/`**: Handles transaction building and submission
  - `build_tx.ts`: Constructs liquidation transactions
  - `send_tx.ts`: Submits transactions with MEV protection
  - `mev_protect.ts`: Handles private mempools
- **`simulator/`**: Pre-execution validation
  - `simulate.ts`: Validates profitability before execution (includes pre-liq scoring)
  - `gas.ts`: Gas estimation and optimization
  - `router.ts`: Uniswap routing optimization
- **`infra/`**: Shared infrastructure
  - `config.ts`: Configuration management with Zod validation
  - `logger.ts`: Pino-based structured logging
  - `metrics.ts`: Prometheus metrics collection (includes pre-liq metrics)
  - `db.ts`: PostgreSQL integration
  - `redis.ts`: Redis for caching and coordination

## Technology Stack
- **Smart Contracts**: Solidity, Foundry
- **Backend**: TypeScript, Node.js
- **Blockchain**: Viem for Ethereum interactions
- **Databases**: PostgreSQL, Redis
- **Monitoring**: Prometheus, Pino logging
- **Package Management**: npm, forge

## Development Guidelines

### Code Style & Patterns
1. **TypeScript**: Use strict typing, prefer `type` over `interface`
2. **Error Handling**: Use Result patterns, structured error types
3. **Async/Await**: Prefer over Promises, handle all rejections
4. **Logging**: Use structured logging with appropriate levels
5. **Configuration**: Use environment variables with validation
6. **Constants**: Define at module level, use SCREAMING_SNAKE_CASE

### Smart Contract Guidelines
1. **Gas Optimization**: This runs on L2s, but still optimize for gas
2. **Safety**: Use checks-effects-interactions pattern
3. **Immutables**: Use immutable for addresses set in constructor
4. **Events**: Emit events for all state changes
5. **Access Control**: Use simple owner-based controls
6. **Flash Loans**: Always validate flash loan callbacks properly

### Key Concepts to Understand

#### Liquidation Flow (Standard)
1. Monitor Aave/Morpho positions for health factor < 1
2. Check oracle vs DEX price gaps for profitable opportunities  
3. Simulate liquidation to ensure profitability
4. Execute flash loan liquidation
5. Swap collateral to debt asset via Uniswap V3
6. Repay flash loan + premium
7. Keep remaining profit

#### Pre-Liquidation Flow (Morpho Blue)
1. **Discovery**: Morpho indexer discovers positions with 1.0 < HF ≤ 1.05
2. **Enrichment**: For each candidate in pre-liq range:
   - Compute offer address via CREATE2
   - Check authorization (Morpho.isAuthorized)
   - Fetch offer parameters (preLCF1/2, preLIF1/2, expiry, oracle)
   - Linear interpolation for effective CF/LIF based on HF
3. **Scoring**: Validate offer (expiry, incentive ≥1.5%, CF valid)
4. **Execution**: If valid → use Bundler3 path, else → standard flash loan
5. **Fallback**: Seamlessly falls back to standard liquidation if no offer

**Status**: ✅ Integrated & Running (PRELIQ_ENABLED=1)
- Indexer enrichment: ✅ Complete
- Scorer validation: ✅ Complete  
- Metrics tracking: ✅ Complete
- Bundler3 execution: ⏳ Pending contract deployment

#### Risk Management
- **Dry Run Mode**: Test mode that logs without executing
- **Gas Caps**: Maximum gas spend per transaction
- **Slippage Protection**: Maximum acceptable slippage on swaps
- **Rate Limiting**: Maximum attempts per borrower per hour
- **Profit Thresholds**: Minimum profit requirements

#### Configuration Structure
- **Chains**: Arbitrum (42161), Optimism (10)
- **Assets**: Token addresses, decimals, Chainlink feeds
- **Markets**: Debt/collateral asset pairs with risk parameters
- **Contracts**: Deployed liquidator contract addresses

### Configuration Automation
- Always sync chain tokens, asset policies, and market enablement via scripts rather than hand-editing `config.yaml`.
- **Aave v3**: `npm run sync:aave` regenerates chain token maps, markets, and asset policies from on-chain + address-book data.
- **Morpho Blue**: `npm run sync:morpho` refreshes token metadata; `npm run sync:morpho:markets` updates market entries; `npm run sync:morpho:quick` does a fast tokens refresh during active ops.
- Add new protocols by extending the relevant `offchain/tools/sync_*.ts` generator—never sprinkle manual edits that the next sync will overwrite.
- After any sync, inspect the git diff, regenerate bundles (`npm run build`), and rerun preflight or targeted dry runs before deploying.

### Common Tasks & Patterns

#### Adding a New Chain
1. Add chain config in `config.yaml`
2. Update `privateKeyForChain()` in orchestrator
3. Add RPC URL environment variable
4. Deploy liquidator contract
5. Update contract addresses in config

#### Adding a New Asset Pair
1. Add token info to chain config
2. Create market entry with risk parameters
3. Test with dry run mode first
4. Monitor price feeds and liquidity

#### Debugging Guidelines
1. **Logs**: Check structured logs for detailed execution traces
2. **Metrics**: Monitor Prometheus gauges for system health
3. **Simulation**: Use dry run mode to test without real execution
4. **Gas Estimation**: Check gas estimates before execution
5. **Price Feeds**: Verify oracle vs DEX price consistency
6. **Attempt Aggregation**: `npm run analyze:attempts -- --minutes 30 --limit 20` to spot systemic skips quickly.

### File Naming Conventions
- **Smart Contracts**: PascalCase.sol
- **TypeScript**: snake_case.ts
- **Configuration**: kebab-case.yaml
- **Tests**: match source file with .test.ts or .t.sol suffix

### Environment Variables
- `RPC_ARB`, `RPC_OP`: RPC endpoints for each chain
- `WALLET_PK_ARB`, `WALLET_PK_OP`: Private keys for each chain
- `PRIVTX_ARB`, `PRIVTX_OP`: Private mempool endpoints (optional)
- Database and Redis connection strings

### Testing Guidelines
1. **Unit Tests**: Test individual components in isolation
2. **Integration Tests**: Test full liquidation flow
3. **Fork Tests**: Use Foundry fork testing for contract testing
4. **Dry Run**: Always test with dry run mode first

### Deployment Guidelines
1. **Local Development**: Use `npm run dev` for orchestrator
2. **Contract Deployment**: Use `forge create` with proper constructor args
3. **Configuration**: Always validate config before deployment
4. **Monitoring**: Set up metrics and logging before going live
5. **Safety**: Start with high profit thresholds and tight slippage

### Performance Considerations
- **Indexing**: Efficient querying of Aave positions
- **Caching**: Use Redis for frequently accessed data
- **Parallel Processing**: Handle multiple chains concurrently
- **Gas Optimization**: Batch operations where possible
- **Connection Pooling**: Reuse HTTP/WebSocket connections

## Security Considerations
- **Private Keys**: Store securely, use separate keys per chain
- **Flash Loan Validation**: Always validate flash loan callbacks
- **Slippage Protection**: Set appropriate slippage limits
- **Access Control**: Restrict contract functions to owner
- **Profit Extraction**: Forward profits to secure beneficiary address
- **Rate Limiting**: Prevent spam and excessive attempts

When working on this codebase, prioritize safety, gas efficiency, and maintainability. Always test changes thoroughly in dry run mode before deploying to production.
