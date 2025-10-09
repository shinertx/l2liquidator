import { AdaptiveThresholds } from '../infra/adaptive_thresholds';
import { test, expect } from './test_harness';

const SAMPLE = {
  chainId: 42161,
  chainName: 'arbitrum',
  assetKey: 'USDC-WETH',
  baseHealthFactorMax: 0.98,
  baseGapCapBps: 90,
  observedGapBps: 100,
};

test('adaptive thresholds nudge up during calm periods', () => {
  const adaptive = new AdaptiveThresholds();
  const result = adaptive.update(SAMPLE);

  const expectedHf = SAMPLE.baseHealthFactorMax + 0.01;
  expect(Math.abs(result.healthFactorMax - expectedHf) < 1e-9, 'health factor should relax slightly');
  expect(result.gapCapBps > SAMPLE.baseGapCapBps, 'gap cap should increase when volatility is low');
  expect(result.volatility < 150, 'volatility should remain low on first update');
});

test('adaptive thresholds tighten under high volatility', () => {
  const adaptive = new AdaptiveThresholds();
  const jitterySample = { ...SAMPLE, observedGapBps: 600 };

  // Pump volatility by feeding multiple extreme observations.
  for (let i = 0; i < 6; i += 1) {
    adaptive.update(jitterySample);
  }

  const tightened = adaptive.update(jitterySample);

  expect(tightened.volatility > 500, 'volatility should spike under repeated shocks');
  expect(tightened.healthFactorMax <= SAMPLE.baseHealthFactorMax, 'health factor max should tighten');
  expect(tightened.gapCapBps <= SAMPLE.baseGapCapBps, 'gap cap should tighten as well');
});
