import { histogram, counter } from './metrics';

type OperationType = 'db' | 'rpc';

export function metricTargetFromRpc(rpc: string, fallback = 'public'): string {
  try {
    const url = new URL(rpc);
    return url.host;
  } catch {
    return fallback;
  }
}

type InstrumentLabels = {
  target?: string;
};

export async function instrument<T>(
  operationType: OperationType,
  name: string,
  operation: () => Promise<T>,
  labels: InstrumentLabels = {},
): Promise<T> {
  const metric =
    operationType === 'db'
      ? histogram.dbQueryDuration
      : histogram.rpcCallDuration;
  const errorCounter =
    operationType === 'db' ? counter.dbErrors : counter.rpcErrors;

  const end = metric.startTimer();
  const target = labels.target ?? (operationType === 'db' ? 'postgres' : 'public');
  const baseLabels = {
    operation: name,
    target,
  };

  try {
    const result = await operation();
    end({ ...baseLabels, status: 'success' });
    return result;
  } catch (error) {
    end({ ...baseLabels, status: 'error' });
    errorCounter.inc(baseLabels);
    throw error;
  }
}
