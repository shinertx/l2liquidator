import { formatUnits, parseUnits } from 'viem';

export function parseTokenAmount(amount: string, decimals: number): bigint {
  const normalized = amount.trim();
  if (!normalized) throw new Error('Empty amount string');
  return parseUnits(normalized as `${number}`, decimals);
}

export function formatTokenAmount(amount: bigint, decimals: number, precision = 6): string {
  const raw = formatUnits(amount, decimals);
  const [integer, fraction = ''] = raw.split('.');
  if (precision <= 0) return integer;
  const trimmedFraction = fraction.slice(0, precision).replace(/0+$/, '');
  return trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
}

export function basisPointsToRatio(bps: number): number {
  return bps / 10_000;
}

export function weiToEth(wei: bigint): number {
  return Number(formatUnits(wei, 18));
}

export function safeSub(a: bigint, b: bigint): bigint {
  const result = a - b;
  return result >= 0n ? result : 0n;
}

export function bigintMax(a: bigint, b: bigint): bigint {
  return a >= b ? a : b;
}

export function bigintMin(a: bigint, b: bigint): bigint {
  return a <= b ? a : b;
}
