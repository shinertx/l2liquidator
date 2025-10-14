export function normalizeDropReason(input: unknown, fallback = 'unknown'): string {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length > 0) return trimmed;
    return fallback;
  }
  if (input == null) return fallback;
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    return String(input);
  }
  if (typeof input === 'symbol') {
    return input.description ?? fallback;
  }
  if (typeof input === 'object') {
    const candidate =
      (input as { reason?: unknown }).reason ??
      (input as { code?: unknown }).code ??
      (input as { message?: unknown }).message;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
    try {
      const serialized = JSON.stringify(input);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // ignore serialization errors and fall through to fallback
    }
    const tagKey = String(Symbol.toStringTag);
    const tag = (input as Record<string, unknown>)[tagKey as unknown as keyof typeof input];
    return typeof tag === 'string' && tag.length > 0 ? tag : 'object';
  }
  return fallback;
}
