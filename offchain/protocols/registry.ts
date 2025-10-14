import type { ProtocolKey } from '../infra/config';
import type { ProtocolAdapter } from './types';
import { aavev3Adapter } from './aavev3';
import { compoundv3Adapter } from './compoundv3';
import { morphoBlueAdapter } from './morphoblue';
import { radiantAdapter } from './radiant';
import { siloAdapter } from './silo';
import { ionicAdapter } from './ionic';
import { exactlyAdapter } from './exactly';

const adapters: Partial<Record<ProtocolKey, ProtocolAdapter>> = {
  aavev3: aavev3Adapter,
  compoundv3: compoundv3Adapter,
  morphoblue: morphoBlueAdapter,
  radiant: radiantAdapter,
  silo: siloAdapter,
  ionic: ionicAdapter,
  exactly: exactlyAdapter,
};

export function getProtocolAdapter(key: ProtocolKey): ProtocolAdapter {
  const adapter = adapters[key];
  if (!adapter) {
    throw new Error(`protocol-adapter-missing:${key}`);
  }
  return adapter;
}

export function defaultProtocolAdapter(): ProtocolAdapter {
  return getProtocolAdapter('aavev3');
}

export function listProtocolAdapters(): ProtocolAdapter[] {
  return Object.values(adapters).filter((adapter): adapter is ProtocolAdapter => Boolean(adapter));
}
