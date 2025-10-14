import { createPublicClient, http, webSocket } from 'viem';
import type { ChainCfg } from './config';
import { log } from './logger';

export type ManagedClient = ReturnType<typeof createPublicClient>;

type PublicClientInstance = ReturnType<typeof createPublicClient>;

type RealtimeClient = {
  client: PublicClientInstance;
  kind: 'ws' | 'http';
};

const httpClients = new Map<number, PublicClientInstance>();
const realtimeClients = new Map<number, RealtimeClient>();
const wsFailures = new Set<number>();
const wsDisabledUntil = new Map<number, number>();
const wsFallbackCursor = new Map<number, number>();

function ensureWebSocketConstructor(): boolean {
  if (typeof (globalThis as any).WebSocket !== 'undefined') {
    return true;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const wsModule = require('ws');
    const WebSocketImpl = wsModule.WebSocket ?? wsModule;
    if (WebSocketImpl) {
      (globalThis as any).WebSocket = WebSocketImpl;
      return true;
    }
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, 'rpc-websocket-constructor-missing');
  }
  return false;
}

export function deriveWsUrl(rpcUrl: string | undefined): string | null {
  if (!rpcUrl) return null;
  if (rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')) return rpcUrl;
  if (rpcUrl.startsWith('https://')) return `wss://${rpcUrl.slice('https://'.length)}`;
  if (rpcUrl.startsWith('http://')) return `ws://${rpcUrl.slice('http://'.length)}`;
  return null;
}

function normalizeWsUrls(urls: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of urls) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    let normalized = trimmed;
    if (!normalized.startsWith('ws')) {
      normalized = deriveWsUrl(normalized) ?? normalized;
    }
    if (!normalized.startsWith('ws')) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function wsFallbacksFromEnv(chain: ChainCfg): string[] {
  const candidates: string[] = [];
  const keyById = `RPC_WS_FALLBACK_${chain.id}`;
  const keyByName = `RPC_WS_FALLBACK_${chain.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
  for (const key of [keyById, keyByName]) {
    const raw = process.env[key];
    if (!raw) continue;
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    candidates.push(...parts);
  }
  return candidates;
}

function wsCandidatesForChain(chain: ChainCfg): string[] {
  const primary = chain.wsRpc ?? deriveWsUrl(chain.rpc);
  const cfgFallbacks = Array.isArray(chain.wsRpcFallbacks) ? chain.wsRpcFallbacks : [];
  const envFallbacks = wsFallbacksFromEnv(chain);
  return normalizeWsUrls([primary, ...cfgFallbacks, ...envFallbacks]);
}

function createHttpClient(chain: ChainCfg): PublicClientInstance {
  const client = createPublicClient({
    transport: http(chain.rpc, {
      batch: {
        // Allow viem to coalesce requests per tick, reducing raw RPC volume under load.
        batchSize: Number(process.env.RPC_HTTP_BATCH_SIZE ?? 20),
        wait: Number(process.env.RPC_HTTP_BATCH_DELAY_MS ?? 10),
      },
    }),
  });
  log.info({ chainId: chain.id, rpc: chain.rpc }, 'rpc-http-client-created');
  return client;
}

function createWebSocketClient(chain: ChainCfg, url: string): PublicClientInstance | null {
  if (!ensureWebSocketConstructor()) return null;
  try {
    const client = createPublicClient({
      transport: webSocket(url, {
        retryCount: Number(process.env.RPC_WS_RETRY_COUNT ?? 5),
        retryDelay: Number(process.env.RPC_WS_RETRY_DELAY_MS ?? 1_000),
      }),
    });
    log.info({ chainId: chain.id, wsRpc: url }, 'rpc-ws-client-created');
    return client;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ chainId: chain.id, wsRpc: url, err: message }, 'rpc-ws-client-failed');
    return null;
  }
}

export function getPublicClient(chain: ChainCfg): PublicClientInstance {
  const cached = httpClients.get(chain.id);
  if (cached) return cached;
  const client = createHttpClient(chain);
  httpClients.set(chain.id, client);
  return client;
}

export function getRealtimeClient(chain: ChainCfg): RealtimeClient {
  const cached = realtimeClients.get(chain.id);
  if (cached) return cached;
  const wsCandidates = wsCandidatesForChain(chain);

  const disabledUntil = wsDisabledUntil.get(chain.id);
  if (disabledUntil !== undefined) {
    if (Date.now() < disabledUntil) {
      const httpClient = getPublicClient(chain);
      const fallback = { client: httpClient, kind: 'http' as const };
      realtimeClients.set(chain.id, fallback);
      if (wsCandidates.length > 0) {
        log.debug({ chainId: chain.id, wsRpc: wsCandidates[0], disabledUntil }, 'rpc-ws-temporarily-disabled');
      }
      return fallback;
    }
    wsDisabledUntil.delete(chain.id);
    wsFailures.delete(chain.id);
  }

  if (!wsFailures.has(chain.id) && wsCandidates.length > 0) {
    const startIdx = wsFallbackCursor.get(chain.id) ?? 0;
    for (let offset = 0; offset < wsCandidates.length; offset += 1) {
      const idx = (startIdx + offset) % wsCandidates.length;
      const url = wsCandidates[idx];
      const wsClient = createWebSocketClient(chain, url);
      if (wsClient) {
        wsFallbackCursor.set(chain.id, idx);
        const managed = { client: wsClient, kind: 'ws' as const };
        realtimeClients.set(chain.id, managed);
        if (idx > 0) {
          log.info({ chainId: chain.id, wsRpc: url, fallbackIdx: idx }, 'rpc-ws-fallback-used');
        }
        return managed;
      }
    }
    log.warn({ chainId: chain.id, candidates: wsCandidates.length }, 'rpc-ws-all-failed');
    wsFailures.add(chain.id);
  }

  const httpClient = getPublicClient(chain);
  const fallback = { client: httpClient, kind: 'http' as const };
  realtimeClients.set(chain.id, fallback);
  log.info({ chainId: chain.id }, 'rpc-realtime-falling-back-http');
  return fallback;
}

export function evictRpcClients(chainId: number): void {
  httpClients.delete(chainId);
  realtimeClients.delete(chainId);
  wsFailures.delete(chainId);
  wsFallbackCursor.delete(chainId);
}

export function resetRpcClients(): void {
  httpClients.clear();
  realtimeClients.clear();
  wsFailures.clear();
  wsDisabledUntil.clear();
  wsFallbackCursor.clear();
}

export function disableWebSocket(chainId: number, durationMs: number): void {
  const until = Date.now() + Math.max(durationMs, 0);
  wsDisabledUntil.set(chainId, until);
  realtimeClients.delete(chainId);
  wsFailures.delete(chainId);
  wsFallbackCursor.delete(chainId);
}

export function enableWebSocket(chainId: number): void {
  wsDisabledUntil.delete(chainId);
  wsFailures.delete(chainId);
  realtimeClients.delete(chainId);
  wsFallbackCursor.delete(chainId);
}
