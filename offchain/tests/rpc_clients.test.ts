import type { ChainCfg } from '../infra/config';
import {
  disableWebSocket,
  enableWebSocket,
  getRealtimeClient,
  resetRpcClients,
  evictRpcClients,
} from '../infra/rpc_clients';
import { test, expect, expectEqual } from './test_harness';

const baseChain: ChainCfg = {
  id: 999,
  name: 'testnet',
  rpc: 'https://rpc.example',
  aaveProvider: '0x0000000000000000000000000000000000000001',
  uniV3Router: '0x0000000000000000000000000000000000000002',
  quoter: '0x0000000000000000000000000000000000000003',
  enabled: true,
  tokens: {},
};

// Ensure no ambient WebSocket implementation interferes with fallback logic during tests.
delete (globalThis as any).WebSocket;

test('realtime client falls back to HTTP when WebSocket is disabled', () => {
  resetRpcClients();
  disableWebSocket(baseChain.id, 60_000);

  const realtime = getRealtimeClient(baseChain);
  expectEqual(realtime.kind, 'http', 'should fall back to HTTP transport while WS is disabled');
});

test('evicting clients clears cached fallback instances', () => {
  resetRpcClients();
  disableWebSocket(baseChain.id, 60_000);

  const first = getRealtimeClient(baseChain);
  expectEqual(first.kind, 'http', 'fallback while disabled should be HTTP');

  evictRpcClients(baseChain.id);
  const second = getRealtimeClient(baseChain);
  expectEqual(second.kind, 'http', 'client after eviction should be recreated as HTTP fallback');
  expect(first.client !== second.client, 'client instance should differ after eviction');
});

test('enabling WebSocket after disable allows retry attempts', () => {
  resetRpcClients();
  disableWebSocket(baseChain.id, 10);
  let realtime = getRealtimeClient(baseChain);
  expectEqual(realtime.kind, 'http', 'should prefer HTTP while disabled');

  enableWebSocket(baseChain.id);
  realtime = getRealtimeClient(baseChain);
  expectEqual(realtime.kind, 'ws', 'WebSocket should be re-attempted once re-enabled');
});
