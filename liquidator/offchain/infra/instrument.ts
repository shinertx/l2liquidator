import { histogram, counter } from './metrics';

type OperationType = 'db' | 'rpc';

export async function instrument<T>(
  operationType: OperationType,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const metric =
    operationType === 'db'
      ? histogram.dbQueryDuration
      : histogram.rpcCallDuration;
  const errorCounter =
    operationType === 'db' ? counter.dbErrors : counter.rpcErrors;

  const end = metric.startTimer();
  const labels = {
    operation: name,
  };

  try {
    const result = await operation();
    end({ ...labels, status: 'success' });
    return result;
  } catch (error) {
    end({ ...labels, status: 'error' });
    errorCounter.inc();
    throw error;
  }
}
