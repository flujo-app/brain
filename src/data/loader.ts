import type { BrainGraph, ModelInfo, RawFlow, ServerStatus } from '../types';
import { distill } from './distill';

// Generous: first hits can traverse two proxies and a cold Next.js route.
const LIVE_TIMEOUT_MS = 8000;

/**
 * Where FLUJO lives. Tried in order, first reachable wins:
 * 1. explicit override (?flujo=<url>, window.__FLUJO_URL__, or VITE_FLUJO_URL)
 * 2. same-origin /flujo proxy (vite dev proxy locally, nginx in Docker) —
 *    required for the execution watcher: FLUJO's /v1 conversation + SSE
 *    endpoints send no CORS headers
 * 3. direct localhost:4200 (static hosting; structural /api only)
 */
const OVERRIDE =
  new URLSearchParams(location.search).get('flujo') ??
  (window as { __FLUJO_URL__?: string }).__FLUJO_URL__ ??
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_FLUJO_URL;
const CANDIDATES = OVERRIDE ? [OVERRIDE.replace(/\/+$/, '')] : ['/flujo', 'http://localhost:4200'];

let resolvedBase: string | null = null;

async function resolveBase(): Promise<string | null> {
  if (resolvedBase) return resolvedBase;
  for (const base of CANDIDATES) {
    try {
      await fetchJson<unknown>(`${base}/api/flow`, 1500);
      resolvedBase = base;
      return base;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** The FLUJO base URL once first contact succeeded, else null. */
export function flujoBase(): string | null {
  return resolvedBase;
}

async function fetchJson<T>(url: string, timeout = LIVE_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Cheap deterministic hash so we can detect data changes between polls. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + s.length;
}

export interface BrainData {
  graph: BrainGraph;
  hash: string;
}

async function fetchModels(base: string): Promise<Record<string, ModelInfo>> {
  const models: Record<string, ModelInfo> = {};
  try {
    const raw = await fetchJson<unknown>(`${base}/api/model`);
    const list = (Array.isArray(raw) ? raw : (raw as { models?: unknown[] })?.models ?? []) as Array<{
      id?: string;
      name?: string;
      provider?: string;
    }>;
    for (const m of list) {
      if (m?.id) models[m.id] = { name: m.name ?? m.id, provider: m.provider ?? 'unknown' };
    }
  } catch {
    // Colors degrade gracefully without model metadata.
  }
  return models;
}

async function fetchServers(base: string): Promise<Record<string, ServerStatus>> {
  const servers: Record<string, ServerStatus> = {};
  try {
    const configs = await fetchJson<Array<{ name?: string; disabled?: boolean }>>(`${base}/api/mcp/servers`);
    if (!Array.isArray(configs)) return servers;
    const enabled = configs.filter((c) => c?.name && !c.disabled);
    for (const c of configs) if (c?.name && c.disabled) servers[c.name] = 'disabled';
    // Live connection status, one call per enabled server (they're few).
    const statuses = await Promise.allSettled(
      enabled.map((c) =>
        fetchJson<{ status?: string }>(`${base}/api/mcp/servers/${encodeURIComponent(c.name!)}/status`),
      ),
    );
    enabled.forEach((c, i) => {
      const r = statuses[i];
      servers[c.name!] = r.status === 'fulfilled' && r.value?.status === 'connected' ? 'connected' : 'disconnected';
    });
  } catch {
    // No server info — statuses stay unknown.
  }
  return servers;
}

/**
 * Fetch everything from the running FLUJO instance. Returns null when FLUJO
 * is unreachable. Nothing is persisted — the graph lives in memory only and
 * a page reload starts from scratch.
 */
export async function fetchBrain(): Promise<BrainData | null> {
  try {
    const base = await resolveBase();
    if (!base) return null;
    const flows = await fetchJson<RawFlow[]>(`${base}/api/flow`);
    if (!Array.isArray(flows) || !flows.length) return null;
    const [models, servers] = await Promise.all([fetchModels(base), fetchServers(base)]);
    const graph = distill(flows, models, servers);
    return { graph, hash: hashString(JSON.stringify({ flows, models, servers })) };
  } catch {
    return null;
  }
}

/**
 * Poll FLUJO for changes (new flows, edited flows, new/removed MCP servers,
 * connection state). Calls `onUpdate` whenever the data's hash changes —
 * including the first time FLUJO becomes reachable at all.
 */
export function watchBrain(getCurrentHash: () => string | null, onUpdate: (data: BrainData) => void, intervalMs = 8000): () => void {
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight || document.hidden) return;
    inFlight = true;
    try {
      const live = await fetchBrain();
      if (!stopped && live && live.hash !== getCurrentHash()) onUpdate(live);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

