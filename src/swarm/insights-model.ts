/** Versioned read-only detail projection. Shared verbatim with the private host. */
export interface Operation { id: string; label: string; state: string; observedAt: string }
export interface Machine { key: string; provider: 'modal' | 'fly'; accountId: string | null; appId: string | null; resourceId: string | null; runId: string | null; cellId: string | null; evidenceDigest: string | null; label: string; kind: 'machine' | 'app' | 'run'; state: string; freshness: 'retained' | 'provider_observed' | 'unavailable'; observedAt: string; region: string | null; operations: Operation[] }
export interface FlowNode { id: string; label: string; type: string }
export interface Flow { id: string; name: string; nodes: FlowNode[]; edges: Array<{ source: string; target: string }> }
export interface Message { id: string; role: 'user' | 'assistant' | 'tool'; content: string; truncated: boolean; at: string | null; nodeId: string | null; tools: Array<{ id: string; name: string; arguments: string }> }
export interface Conversation { id: string; title: string; status: string; flowId: string | null; currentNodeId: string | null; updatedAt: string; tokens: number | null; estimatedCostUsd: number | null; totalMessages: number; truncated: boolean; messages: Message[] }
export interface Worker { id: string; label: string; cellId: string | null; machineKey: string | null; availability: 'observed' | 'unavailable'; observedAt: string; conversationStatus: 'observed' | 'unavailable' | 'not_configured'; conversations: Conversation[]; flows: Flow[] }
export interface Budget { revision: number; limitCents: number; heldCents: number; availableCents: number; meteredCents: number | null; incomplete: boolean; reservations: Array<{ id: string; provider: string; state: string; heldCents: number }> }
export interface ObservationSource { sourceId: string; factoryId: string; observedAt: string; modalStatus: 'observed' | 'unavailable' | 'not_configured'; flyStatus: 'observed' | 'unavailable' | 'not_configured'; machines: Machine[]; workers: Worker[]; budget: Budget | null }
export interface Observatory { schemaVersion: 1; scope: 'factory-observatory'; commands: false; observedAt: string; sources: ObservationSource[] }
const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid detail observation.'); return v as Record<string, unknown>; };
const text = (v: unknown, max = 128): string => { if (typeof v !== 'string' || !v.length || v.length > max) throw new Error('Invalid detail text.'); return v; };
const body = (v: unknown, max: number): string => { if (typeof v !== 'string' || v.length > max) throw new Error('Detail content exceeds its bound.'); return v; };
const integer = (v: unknown): number => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error('Invalid detail count.'); return v as number; };
const nullable = (v: unknown): string | null => v === null ? null : text(v);
const time = (v: unknown): string => { const s = text(v, 64); if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(Date.parse(s))) throw new Error('Invalid detail time.'); return s; };
const choice = <T extends string>(v: unknown, values: readonly T[]): T => { if (!values.includes(v as T)) throw new Error('Invalid detail category.'); return v as T; };
const list = (v: unknown, max: number): unknown[] => { if (!Array.isArray(v) || v.length > max) throw new Error('Detail observation exceeds its bound.'); return v; };
const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) throw new Error('Duplicate detail identity.'); };
const status = (v: unknown) => choice(v, ['observed', 'unavailable', 'not_configured']);
export const machineKey = (provider: string, accountId: string | null, runId: string | null, resourceId: string | null, appId: string | null = null): string => JSON.stringify([provider, accountId, appId, runId, resourceId]);

/** Unknown fields, worker URLs, credentials, system prompts and arbitrary node properties never cross this boundary. */
export function parseObservatory(value: unknown, allowed: Array<{ id: string; factoryId: string }>): Observatory {
  const input = record(value);
  if (input.schemaVersion !== 1 || input.scope !== 'factory-observatory' || input.commands !== false) throw new Error('Unsupported detail authority.');
  const sources = list(input.sources, 32).map(v => {
    const s = record(v), sourceId = text(s.sourceId), factoryId = text(s.factoryId);
    if (!allowed.some(a => a.id === sourceId && a.factoryId === factoryId)) throw new Error('Detail source is not registered.');
    const machines = list(s.machines, 128).map(v => {
      const m = record(v), provider = choice(m.provider, ['modal', 'fly']), accountId = nullable(m.accountId), appId = nullable(m.appId), resourceId = nullable(m.resourceId), runId = nullable(m.runId);
      const key = body(m.key, 512);
      if ((!resourceId && !runId) || key !== machineKey(provider, accountId, runId, resourceId, appId)) throw new Error('Invalid machine namespace.');
      const evidenceDigest = nullable(m.evidenceDigest); if (evidenceDigest !== null && !/^[a-f0-9]{64}$/.test(evidenceDigest)) throw new Error('Invalid machine evidence.');
      const operations = list(m.operations, 1000).map(v => { const o = record(v); return { id: text(o.id), label: text(o.label), state: text(o.state), observedAt: time(o.observedAt) }; });
      unique(operations.map(o => o.id));
      return { key, provider, accountId, appId, resourceId, runId, cellId: nullable(m.cellId), evidenceDigest, label: text(m.label), kind: choice(m.kind, ['machine', 'app', 'run']), state: text(m.state), freshness: choice(m.freshness, ['retained', 'provider_observed', 'unavailable']), observedAt: time(m.observedAt), region: nullable(m.region), operations };
    });
    unique(machines.map(m => m.key));
    const workers = list(s.workers, 16).map(v => {
      const w = record(v), flows = list(w.flows, 32).map(v => {
        const f = record(v), nodes = list(f.nodes, 512).map(v => { const n = record(v); return { id: text(n.id), label: text(n.label), type: text(n.type) }; });
        unique(nodes.map(n => n.id));
        const edges = list(f.edges, 2048).map(v => { const e = record(v); const edge = { source: text(e.source), target: text(e.target) }; if (!nodes.some(n => n.id === edge.source) || !nodes.some(n => n.id === edge.target)) throw new Error('Unbound flow edge.'); return edge; });
        return { id: text(f.id), name: text(f.name), nodes, edges };
      });
      unique(flows.map(f => f.id));
      const conversations = list(w.conversations, 12).map(v => {
        const c = record(v), messages = list(c.messages, 100).map(v => {
          const m = record(v), tools = list(m.tools, 64).map(v => { const t = record(v); return { id: text(t.id), name: text(t.name), arguments: body(t.arguments, 4096) }; });
          if (typeof m.truncated !== 'boolean') throw new Error('Invalid message window.');
          return { id: text(m.id), role: choice(m.role, ['user', 'assistant', 'tool']), content: body(m.content, 16384), truncated: m.truncated, at: m.at === null ? null : time(m.at), nodeId: nullable(m.nodeId), tools };
        });
        unique(messages.map(m => m.id));
        const totalMessages = integer(c.totalMessages);
        if (typeof c.truncated !== 'boolean' || totalMessages < messages.length) throw new Error('Invalid transcript window.');
        const cost = c.estimatedCostUsd;
        if (cost !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) throw new Error('Invalid estimated cost.');
        return { id: text(c.id), title: text(c.title, 256), status: text(c.status), flowId: nullable(c.flowId), currentNodeId: nullable(c.currentNodeId), updatedAt: time(c.updatedAt), tokens: c.tokens === null ? null : integer(c.tokens), estimatedCostUsd: cost as number | null, totalMessages, truncated: c.truncated, messages };
      });
      unique(conversations.map(c => c.id));
      const availability = choice(w.availability, ['observed', 'unavailable']), conversationStatus = status(w.conversationStatus);
      if (((availability === 'unavailable' || conversationStatus !== 'observed') && conversations.length) || (availability === 'unavailable' && flows.length)) throw new Error('Unavailable transcript must be erased.');
      return { id: text(w.id), label: text(w.label), cellId: nullable(w.cellId), machineKey: w.machineKey === null ? null : body(w.machineKey, 512), availability, observedAt: time(w.observedAt), conversationStatus, conversations, flows };
    });
    unique(workers.map(w => w.id));
    let budget: Budget | null = null;
    if (s.budget !== null) {
      const b = record(s.budget), limitCents = integer(b.limitCents), heldCents = integer(b.heldCents), availableCents = integer(b.availableCents);
      if (availableCents !== Math.max(0, limitCents - heldCents) || typeof b.incomplete !== 'boolean') throw new Error('Invalid paid budget.');
      const reservations = list(b.reservations, 1000).map(v => { const r = record(v); return { id: text(r.id), provider: text(r.provider), state: text(r.state), heldCents: integer(r.heldCents) }; });
      unique(reservations.map(r => r.id));
      if (reservations.reduce((n, r) => n + r.heldCents, 0) !== heldCents) throw new Error('Inconsistent paid reservations.');
      budget = { revision: integer(b.revision), limitCents, heldCents, availableCents, meteredCents: b.meteredCents === null ? null : integer(b.meteredCents), incomplete: b.incomplete, reservations };
    }
    return { sourceId, factoryId, observedAt: time(s.observedAt), modalStatus: status(s.modalStatus), flyStatus: status(s.flyStatus), machines, workers, budget };
  });
  unique(sources.map(s => s.sourceId));
  return { schemaVersion: 1, scope: 'factory-observatory', commands: false, observedAt: time(input.observedAt), sources };
}

/** Independent paid-ledger floors; unavailable private detail is never retained. */
export class ObservationFloors {
  private paid = new Map<string, number>();
  reset() { this.paid.clear(); }
  accept(value: unknown, allowed: Array<{ id: string; factoryId: string }>): Observatory {
    const keys = new Set(allowed.map(s => JSON.stringify([s.id, s.factoryId])));
    for (const key of this.paid.keys()) if (!keys.has(key)) this.paid.delete(key);
    const next = parseObservatory(value, allowed);
    for (const s of next.sources) if (s.budget) {
      const key = JSON.stringify([s.sourceId, s.factoryId]), floor = this.paid.get(key) ?? -1;
      if (s.budget.revision < floor) s.budget = null;
      else this.paid.set(key, s.budget.revision);
    }
    return next;
  }
}
