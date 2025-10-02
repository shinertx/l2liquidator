export type JsonRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // fall through to JSON method below
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeInto(target: JsonRecord, source: JsonRecord): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      const next = { ...current };
      mergeInto(next, value);
      target[key] = next;
      continue;
    }
    target[key] = clone(value);
  }
}

export function deepMerge<T extends JsonRecord>(base: T, patch: JsonRecord): T {
  const result = clone(base);
  mergeInto(result, patch);
  return result as T;
}
