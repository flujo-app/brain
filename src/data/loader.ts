import type { BrainGraph, BrainSnapshot, ModelInfo, RawFlow, ServerStatus } from '../types';
import { distill } from './distill';

const LIVE_BASE = 'http://localhost:4200';
const LIVE_TIMEOUT_MS = 2500;

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

async function fetchLiveModels(): Promise<Record<string, ModelInfo>> {
  const models: Record<string, ModelInfo> = {};
  try {
    const raw = await fetchJson<unknown>(`${LIVE_BASE}/api/model`);
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

async function fetchLiveServers(): Promise<Record<string, ServerStatus>> {
  const servers: Record<string, ServerStatus> = {};
  try {
    const configs = await fetchJson<Array<{ name?: string; disabled?: boolean }>>(`${LIVE_BASE}/api/mcp/servers`);
    if (!Array.isArray(configs)) return servers;
    const enabled = configs.filter((c) => c?.name && !c.disabled);
    for (const c of configs) if (c?.name && c.disabled) servers[c.name] = 'disabled';
    // Live connection status, one call per enabled server (they're few).
    const statuses = await Promise.allSettled(
      enabled.map((c) =>
        fetchJson<{ status?: string }>(`${LIVE_BASE}/api/mcp/servers/${encodeURIComponent(c.name!)}/status`),
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

/** Fetch from a running FLUJO instance. Returns null if unreachable. */
async function fetchLive(): Promise<BrainData | null> {
  try {
    const flows = await fetchJson<RawFlow[]>(`${LIVE_BASE}/api/flow`);
    if (!Array.isArray(flows) || !flows.length) return null;
    const [models, servers] = await Promise.all([fetchLiveModels(), fetchLiveServers()]);
    const graph = distill(flows, models, servers, 'live');
    return { graph, hash: hashString(JSON.stringify({ flows, models, servers })) };
  } catch {
    return null;
  }
}

async function fetchSnapshot(): Promise<BrainData> {
  const base = import.meta.env.BASE_URL ?? './';
  const snap = await fetchJson<BrainSnapshot>(`${base}data/flows.json`, 10000);
  const servers: Record<string, ServerStatus> = {};
  for (const [name, s] of Object.entries(snap.servers ?? {})) servers[name] = s.status;
  const graph = distill(snap.flows, snap.models ?? {}, servers, 'snapshot');
  return { graph, hash: 'snapshot:' + hashString(JSON.stringify(snap.flows)) };
}

/** Try a running FLUJO instance first, fall back to the bundled snapshot. */
export async function loadBrain(): Promise<BrainData> {
  return (await fetchLive()) ?? (await fetchSnapshot());
}

/**
 * Poll the live FLUJO for changes (new flows, edited flows, new/removed MCP
 * servers, connection state). Calls `onUpdate` whenever the data's hash
 * changes — including the first time a live instance appears while the
 * snapshot is being shown.
 */
export function watchBrain(getCurrentHash: () => string, onUpdate: (data: BrainData) => void, intervalMs = 8000): () => void {
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight || document.hidden) return;
    inFlight = true;
    try {
      const live = await fetchLive();
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
