import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const gauge = {
  pnlPerGas: new client.Gauge({
    name: 'pnl_per_gas',
    help: 'PnL per gas unit',
    labelNames: ['chain'],
  }),
  hitRate: new client.Gauge({ name: 'hit_rate', help: 'simulated to sent ratio' }),
  failureRate: new client.Gauge({ name: 'plans_failure_rate', help: 'Rolling failure rate for liquidation attempts', labelNames: ['chain'] }),
  inventoryBalance: new client.Gauge({ name: 'inventory_balance', help: 'Inventory debt token balance', labelNames: ['chain', 'token'] }),
  adaptiveHealthFactor: new client.Gauge({
    name: 'adaptive_health_factor_max',
    help: 'Adaptive health factor thresholds',
    labelNames: ['chain', 'pair'],
  }),
  adaptiveGapCap: new client.Gauge({
    name: 'adaptive_gap_cap_bps',
    help: 'Adaptive gap cap thresholds (bps)',
    labelNames: ['chain', 'pair'],
  }),
  adaptiveVolatility: new client.Gauge({
    name: 'adaptive_gap_volatility',
    help: 'Observed gap volatility (EMA, bps)',
    labelNames: ['chain', 'pair'],
  }),
  sequencerStatus: new client.Gauge({
    name: 'sequencer_status',
    help: 'Latest sequencer health check outcome (1=ok)',
    labelNames: ['chain', 'stage'],
  }),
  routeOptions: new client.Gauge({
    name: 'route_option_count',
    help: 'Number of swap route options evaluated per market',
    labelNames: ['chain', 'pair'],
  }),
  analyticsHitRate: new client.Gauge({
    name: 'analytics_hit_rate',
    help: 'Hit rate computed by analytics loop',
    labelNames: ['chain', 'pair'],
  }),
  analyticsOpportunityCost: new client.Gauge({
    name: 'analytics_opportunity_cost_usd',
    help: 'Estimated opportunity cost per market',
    labelNames: ['chain', 'pair'],
  }),
  analyticsModelDrift: new client.Gauge({
    name: 'analytics_model_drift',
    help: 'Average health factor drift relative to threshold',
    labelNames: ['chain', 'pair'],
  }),
};
registry.registerMetric(gauge.pnlPerGas);
registry.registerMetric(gauge.hitRate);
registry.registerMetric(gauge.failureRate);
registry.registerMetric(gauge.inventoryBalance);
registry.registerMetric(gauge.adaptiveHealthFactor);
registry.registerMetric(gauge.adaptiveGapCap);
registry.registerMetric(gauge.adaptiveVolatility);
registry.registerMetric(gauge.sequencerStatus);
registry.registerMetric(gauge.routeOptions);
registry.registerMetric(gauge.analyticsHitRate);
registry.registerMetric(gauge.analyticsOpportunityCost);
registry.registerMetric(gauge.analyticsModelDrift);

export const histogram = {
  dbQueryDuration: new client.Histogram({
    name: 'db_query_duration_seconds',
    help: 'Duration of database queries in seconds',
    labelNames: ['operation', 'status', 'target'],
  }),
  rpcCallDuration: new client.Histogram({
    name: 'rpc_call_duration_seconds',
    help: 'Duration of RPC calls in seconds',
    labelNames: ['operation', 'status', 'target'],
  }),
  simulateDuration: new client.Histogram({
    name: 'simulate_duration_seconds',
    help: 'Time spent building liquidation plan',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  }),
  sendLatency: new client.Histogram({
    name: 'send_latency_seconds',
    help: 'Latency between plan acceptance and transaction broadcast',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5, 10],
  }),
  candidateHealthFactor: new client.Histogram({
    name: 'candidate_health_factor',
    help: 'Distribution of candidate health factors at different pipeline stages',
    labelNames: ['chain', 'stage'],
    buckets: [0.5, 0.7, 0.8, 0.9, 0.95, 1.0, 1.02, 1.05, 1.08, 1.12, 1.2, 1.35, 1.5, 2, 3],
  }),
  adaptiveRemoteLatency: new client.Histogram({
    name: 'adaptive_remote_latency_seconds',
    help: 'Latency of remote adaptive-threshold fetches',
    labelNames: ['chain', 'pair'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
  }),
  lafNetUsd: new client.Histogram({
    name: 'laf_edge_net_usd',
    help: 'Distribution of modeled net USD per LAF edge',
    labelNames: ['source'],
    buckets: [0.25, 0.5, 1, 2, 3, 5, 7.5, 10],
  }),
  lafPnlMultiple: new client.Histogram({
    name: 'laf_edge_pnl_multiple',
    help: 'PNL multiples for LAF edges',
    labelNames: ['source'],
    buckets: [1, 2, 3, 4, 5, 7, 10],
  }),
};
registry.registerMetric(histogram.dbQueryDuration);
registry.registerMetric(histogram.rpcCallDuration);
registry.registerMetric(histogram.simulateDuration);
registry.registerMetric(histogram.sendLatency);
registry.registerMetric(histogram.candidateHealthFactor);
registry.registerMetric(histogram.adaptiveRemoteLatency);
registry.registerMetric(histogram.lafNetUsd);
registry.registerMetric(histogram.lafPnlMultiple);

export const counter = {
  candidates: new client.Counter({ name: 'candidates_total', help: 'Total liquidation candidates processed', labelNames: ['chain'] }),
  throttled: new client.Counter({ name: 'candidates_throttled_total', help: 'Candidates skipped due to throttle window', labelNames: ['chain'] }),
  gapSkip: new client.Counter({ name: 'candidates_gap_skip_total', help: 'Candidates skipped due to oracle-DEX gap', labelNames: ['chain'] }),
  sequencerSkip: new client.Counter({
    name: 'candidates_sequencer_skip_total',
    help: 'Candidates skipped due to sequencer downtime or stale feed',
    labelNames: ['chain', 'reason'],
  }),
  denylistSkip: new client.Counter({
    name: 'candidates_denylist_skip_total',
    help: 'Candidates skipped due to asset denylist',
    labelNames: ['chain', 'debt', 'collateral'],
  }),
  predictiveQueued: new client.Counter({
    name: 'candidates_predictive_total',
    help: 'Candidates flagged by predictive scanner',
    labelNames: ['chain'],
  }),
  candidateDrops: new client.Counter({
    name: 'candidate_drop_reason_total',
    help: 'Total liquidation candidates dropped before execution by reason',
    labelNames: ['chain', 'reason'],
  }),
  plansReady: new client.Counter({ name: 'plans_ready_total', help: 'Plans produced by simulator', labelNames: ['chain'] }),
  plansDryRun: new client.Counter({ name: 'plans_dry_run_total', help: 'Plans recorded in dry-run mode', labelNames: ['chain'] }),
  plansSent: new client.Counter({ name: 'plans_sent_total', help: 'Transactions submitted on-chain', labelNames: ['chain'] }),
  plansError: new client.Counter({ name: 'plans_error_total', help: 'Errors while processing candidate', labelNames: ['chain'] }),
  plansRejected: new client.Counter({
    name: 'plans_rejected_total',
    help: 'Plans rejected prior to transmission',
    labelNames: ['chain', 'reason'],
  }),
  dbErrors: new client.Counter({
    name: 'db_errors_total',
    help: 'Total database errors',
    labelNames: ['operation', 'target'],
  }),
  rpcErrors: new client.Counter({
    name: 'rpc_errors_total',
    help: 'Total RPC errors',
    labelNames: ['operation', 'target'],
  }),
  profitEstimated: new client.Counter({ name: 'profit_estimated_total_usd', help: 'Estimated liquidation profit in USD', labelNames: ['chain', 'mode'] }),
  precommitAttempts: new client.Counter({ name: 'precommit_attempt_total', help: 'Pre-commit plans considered', labelNames: ['chain'] }),
  precommitSuccess: new client.Counter({ name: 'precommit_success_total', help: 'Pre-commit plans executed', labelNames: ['chain'] }),
  inventoryExecutions: new client.Counter({ name: 'inventory_mode_total', help: 'Liquidations executed with inventory funds', labelNames: ['chain'] }),
  adaptiveRemoteRequests: new client.Counter({
    name: 'adaptive_remote_requests_total',
    help: 'Remote adaptive-threshold fetch attempts',
    labelNames: ['chain', 'pair'],
  }),
  adaptiveRemoteErrors: new client.Counter({
    name: 'adaptive_remote_errors_total',
    help: 'Remote adaptive-threshold fetch errors',
    labelNames: ['chain', 'pair'],
  }),
  subgraphPriceZero: new client.Counter({
    name: 'subgraph_price_zero_total',
    help: 'Subgraph reserves that reported a zero price',
    labelNames: ['chain', 'token', 'role'],
  }),
  lafEdges: new client.Counter({
    name: 'laf_edges_total',
    help: 'Edges generated by Long-Tail Arbitrage Fabric',
    labelNames: ['source'],
  }),
  lafExecSuccess: new client.Counter({
    name: 'laf_exec_success_total',
    help: 'Successful LAF executions',
    labelNames: ['source'],
  }),
  lafExecFailed: new client.Counter({
    name: 'laf_exec_failed_total',
    help: 'Failed LAF executions',
    labelNames: ['source'],
  }),
  lafGraphSkip: new client.Counter({
    name: 'laf_graph_skip_total',
    help: 'Edges skipped by price-graph gating before full quoting',
    labelNames: ['chain', 'pair', 'reason'],
  }),
};
for (const metric of Object.values(counter) as client.Metric[]) {
  registry.registerMetric(metric);
}
