process.env.REDIS_URL = '';

import { isEdgeThrottled, recordEdgeAttempt, resetEdgeThrottle } from '../arb_fabric/throttle';
import { test, expect } from './test_harness';

const chainId = 42161;
const pairId = 'test-pair';

async function reset(): Promise<void> {
  resetEdgeThrottle(chainId, pairId);
  // allow async redis cleanup (noop in fallback)
  await Promise.resolve();
}

test('edge throttling increments up to limit', async () => {
  await reset();
  const limit = 2;
  let throttled = await isEdgeThrottled(chainId, pairId, limit);
  expect(!throttled, 'Edge should not be throttled initially');

  await recordEdgeAttempt(chainId, pairId);
  throttled = await isEdgeThrottled(chainId, pairId, limit);
  expect(!throttled, 'Edge should allow first attempt');

  await recordEdgeAttempt(chainId, pairId);
  throttled = await isEdgeThrottled(chainId, pairId, limit);
  expect(throttled, 'Edge should be throttled after reaching limit');
});

test('resetEdgeThrottle clears fallback counter', async () => {
  await reset();
  const limit = 1;
  await recordEdgeAttempt(chainId, pairId);
  let throttled = await isEdgeThrottled(chainId, pairId, limit);
  expect(throttled, 'Edge should be throttled after increment');

  resetEdgeThrottle(chainId, pairId);
  throttled = await isEdgeThrottled(chainId, pairId, limit);
  expect(!throttled, 'Edge should no longer be throttled after reset');
});
