import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const gauge = {
  pnlPerGas: new client.Gauge({ name: 'pnl_per_gas', help: 'PnL per gas unit' }),
  hitRate: new client.Gauge({ name: 'hit_rate', help: 'simulated to sent ratio' }),
};
registry.registerMetric(gauge.pnlPerGas);
registry.registerMetric(gauge.hitRate);

export const counter = {
  candidates: new client.Counter({ name: 'candidates_total', help: 'Total liquidation candidates processed' }),
  throttled: new client.Counter({ name: 'candidates_throttled_total', help: 'Candidates skipped due to throttle window' }),
  gapSkip: new client.Counter({ name: 'candidates_gap_skip_total', help: 'Candidates skipped due to oracle-DEX gap' }),
  plansReady: new client.Counter({ name: 'plans_ready_total', help: 'Plans produced by simulator' }),
  plansDryRun: new client.Counter({ name: 'plans_dry_run_total', help: 'Plans recorded in dry-run mode' }),
  plansSent: new client.Counter({ name: 'plans_sent_total', help: 'Transactions submitted on-chain' }),
  plansError: new client.Counter({ name: 'plans_error_total', help: 'Errors while processing candidate' }),
};
Object.values(counter).forEach((metric) => registry.registerMetric(metric));
