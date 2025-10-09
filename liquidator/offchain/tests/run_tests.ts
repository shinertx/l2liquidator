#!/usr/bin/env ts-node
import { runAll } from './test_harness';

import './adaptive_thresholds.test';
import './rpc_clients.test';

runAll().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
