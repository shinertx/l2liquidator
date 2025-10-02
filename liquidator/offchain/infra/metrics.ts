import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const gauge = {
  pnlPerGas: new client.Gauge({ name: 'pnl_per_gas', help: 'PnL per gas unit' }),
  hitRate: new client.Gauge({ name: 'hit_rate', help: 'simulated to sent ratio' }),
  failureRate: new client.Gauge({ name: 'plans_failure_rate', help: 'Rolling failure rate for liquidation attempts', labelNames: ['chain'] }),
  inventoryBalance: new client.Gauge({ name: 'inventory_balance', help: 'Inventory debt token balance', labelNames: ['chain', 'token'] }),
};
registry.registerMetric(gauge.pnlPerGas);
registry.registerMetric(gauge.hitRate);
registry.registerMetric(gauge.failureRate);
registry.registerMetric(gauge.inventoryBalance);

export const histogram = {
  dbQueryDuration: new client.Histogram({
    name: 'db_query_duration_seconds',
    help: 'Duration of database queries in seconds',
    labelNames: ['operation', 'status'],
  }),
  rpcCallDuration: new client.Histogram({
    name: 'rpc_call_duration_seconds',
    help: 'Duration of RPC calls in seconds',
    labelNames: ['operation', 'status'],
  }),
  simulateDuration: new client.Histogram({
    name: 'simulate_duration_seconds',
    help: 'Time spent building liquidation plan',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  }),
};
registry.registerMetric(histogram.dbQueryDuration);
registry.registerMetric(histogram.rpcCallDuration);
registry.registerMetric(histogram.simulateDuration);

export const counter = {
  candidates: new client.Counter({ name: 'candidates_total', help: 'Total liquidation candidates processed', labelNames: ['chain'] }),
  throttled: new client.Counter({ name: 'candidates_throttled_total', help: 'Candidates skipped due to throttle window', labelNames: ['chain'] }),
  gapSkip: new client.Counter({ name: 'candidates_gap_skip_total', help: 'Candidates skipped due to oracle-DEX gap', labelNames: ['chain'] }),
  sequencerSkip: new client.Counter({ name: 'candidates_sequencer_skip_total', help: 'Candidates skipped due to sequencer downtime or stale feed', labelNames: ['chain'] }),
  denylistSkip: new client.Counter({ name: 'candidates_denylist_skip_total', help: 'Candidates skipped due to asset denylist', labelNames: ['chain'] }),
  plansReady: new client.Counter({ name: 'plans_ready_total', help: 'Plans produced by simulator', labelNames: ['chain'] }),
  plansDryRun: new client.Counter({ name: 'plans_dry_run_total', help: 'Plans recorded in dry-run mode', labelNames: ['chain'] }),
  plansSent: new client.Counter({ name: 'plans_sent_total', help: 'Transactions submitted on-chain', labelNames: ['chain'] }),
  plansError: new client.Counter({ name: 'plans_error_total', help: 'Errors while processing candidate', labelNames: ['chain'] }),
  dbErrors: new client.Counter({ name: 'db_errors_total', help: 'Total database errors' }),
  rpcErrors: new client.Counter({ name: 'rpc_errors_total', help: 'Total RPC errors' }),
  profitEstimated: new client.Counter({ name: 'profit_estimated_total_usd', help: 'Estimated liquidation profit in USD', labelNames: ['chain', 'mode'] }),
  precommitAttempts: new client.Counter({ name: 'precommit_attempt_total', help: 'Pre-commit plans considered', labelNames: ['chain'] }),
  precommitSuccess: new client.Counter({ name: 'precommit_success_total', help: 'Pre-commit plans executed', labelNames: ['chain'] }),
  inventoryExecutions: new client.Counter({ name: 'inventory_mode_total', help: 'Liquidations executed with inventory funds', labelNames: ['chain'] }),
};
Object.values(counter).forEach((metric) => registry.registerMetric(metric));
