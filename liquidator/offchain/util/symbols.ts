import type { AssetPolicy, TokenInfo } from '../infra/config';

export type SymbolLookupResult<T> = { key: string; value: T };

function normalizeRawSymbol(symbol: string): string {
  const normalized = symbol.normalize('NFKD');
  const withReplacements = normalized
    .replace(/₮/g, 'T')
    .replace(/＄/g, 'S');
  let simplified = withReplacements.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (symbol.includes('₮0') && simplified.endsWith('0')) {
    simplified = simplified.slice(0, -1);
  }
  return simplified;
}

export function normalizeSymbolKey(symbol: string | null | undefined): string {
  if (!symbol) return '';
  try {
    return normalizeRawSymbol(symbol);
  } catch {
    return String(symbol).toUpperCase();
  }
}

export function symbolsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeSymbolKey(a) === normalizeSymbolKey(b);
}

export function lookupBySymbol<T>(table: Record<string, T> | undefined, symbol: string | null | undefined): SymbolLookupResult<T> | undefined {
  if (!table || !symbol) return undefined;
  if (Object.prototype.hasOwnProperty.call(table, symbol)) {
    return { key: symbol, value: table[symbol]! };
  }
  const normalized = normalizeSymbolKey(symbol);
  if (!normalized) return undefined;
  for (const [key, value] of Object.entries(table)) {
    if (normalizeSymbolKey(key) === normalized) {
      return { key, value };
    }
  }
  return undefined;
}

export function lookupAssetPolicy(table: Record<string, AssetPolicy>, symbol: string | null | undefined): SymbolLookupResult<AssetPolicy> | undefined {
  return lookupBySymbol(table, symbol);
}

export function lookupToken(
  table: Record<string, TokenInfo>,
  symbol: string | null | undefined,
  address: string | null | undefined = undefined,
): SymbolLookupResult<TokenInfo> | undefined {
  if (address) {
    const normalizedAddress = address.toLowerCase();
    for (const [key, value] of Object.entries(table)) {
      if (value.address.toLowerCase() === normalizedAddress) {
        return { key, value };
      }
    }
  }
  const bySymbol = lookupBySymbol(table, symbol);
  if (bySymbol) return bySymbol;
  return undefined;
}
