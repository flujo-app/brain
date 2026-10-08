/** Public read-only transport, shared structurally with the Brain Online adapter.
 * No provider locations, credentials, commands or arbitrary navigation URLs. */
export interface Cell { id: string; parentId: string | null; depth: number; role: 'coordinator' | 'developer' | 'verifier' | 'watcher'; status: 'reserved' | 'ready' | 'retired'; purpose: string; heartbeat: string; allocationCents: number; budgetBasis: 'logical-allocation' }
export interface Task { id: string; projectId: string; branch: string; status: 'ready' | 'running' | 'review' | 'verified' | 'delivered' | 'rejected' | 'completed' | 'cancelled'; owner: string | null; attempt: number; leaseExpiry: string | null; specDigest: string; candidate: { sha256: string } | null; review: { accepted: boolean; reviewerId: string; evidenceDigest: string; candidateDigest: string; specDigest: string; attempt: number } | null }
export interface Effect { key: string; kind: 'provision' | 'flow_call' | 'message' | 'flow_cancel' | 'retire' | 'delivery' | 'worker_wake' | 'worker_sleep'; state: 'accepted' | 'running' | 'unknown' | 'succeeded' | 'cancelled' | 'not_applied'; owner: string; taskId: string | null; scope: 'task' | 'project' | 'cleanup' | 'worker'; scopeId: string; ownerEpoch: number; controlEpoch: number; createdAt: string; updatedAt: string; requestDigest: string }
export interface Change { seq: number; type: string; subject: string; observedAt: string }
export interface Snapshot {
  schemaVersion: 1; factoryId: string; revision: number; cursor: string; observedAt: string; scope: 'local-coordinator'; buildRevision: string;
  capabilities: { snapshot: true; events: true; commands: false };
  snapshot: { control: { status: 'active' | 'paused'; epoch: number; mission: string }; cells: Cell[]; tasks: Task[]; effects: Effect[]; workerQuiescence: 'unverified' };
}
export interface Source { id: string; label: string; factoryId: string; status: 'observed' | 'stale' | 'unavailable'; snapshot: Snapshot | null; events: Change[] }
export interface Swarm { schemaVersion: 1; scope: 'operator-source-registry'; observedAt: string; commands: false; sources: Source[]; sample?: boolean }
export interface Selection { sourceId: string; kind: 'source' | 'cell' | 'task' | 'effect'; id: string }
export interface Point { x: number; y: number; z: number }
export interface Node { key: string; selection: Selection; source: Source; cell: Cell | null; label: string; parent: string | null; point: Point; activity: 'idle' | 'recent' | 'uncertain' }

const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid observation.'); return value as Record<string, unknown>; };
const text = (value: unknown, max = 128): string => { if (typeof value !== 'string' || value.length > max) throw new Error('Invalid observation text.'); return value; };
const id = (value: unknown): string => { const result = text(value); if (!result) throw new Error('Missing identity.'); return result; };
const num = (value: unknown): number => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid observation sequence.'); return value as number; };
const date = (value: unknown): string => { const result = text(value, 64); if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error('Invalid observation time.'); return result; };
const digest = (value: unknown): string => { const result = text(value); if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('Invalid evidence hash.'); return result; };
const choice = <T extends string>(value: unknown, values: readonly T[]): T => { if (!values.includes(value as T)) throw new Error('Unsupported observation value.'); return value as T; };
const array = (value: unknown, max: number): unknown[] => { if (!Array.isArray(value) || value.length > max) throw new Error('Observation exceeds its bounds.'); return value; };
const optionalId = (value: unknown): string | null => value === null ? null : id(value);
const unique = (values: string[]) => { if (new Set(values).size !== values.length) throw new Error('Duplicate observation identity.'); };

/** Positive allowlist even when running outside Brain Online's validated host. */
export function parseSwarm(value: unknown): Swarm {
  const input = record(value);
  if (input.schemaVersion !== 1 || input.scope !== 'operator-source-registry' || input.commands !== false) throw new Error('Unsupported swarm observation.');
  const sources = array(input.sources, 32).map(value => {
    const source = record(value), sourceId = id(source.id), factoryId = id(source.factoryId);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sourceId)) throw new Error('Invalid registered source.');
    let snapshot: Snapshot | null = null;
    if (source.snapshot !== null) {
      const envelope = record(source.snapshot), state = record(envelope.snapshot), control = record(state.control), caps = record(envelope.capabilities);
      if (envelope.schemaVersion !== 1 || envelope.factoryId !== factoryId || envelope.scope !== 'local-coordinator' || caps.commands !== false || caps.snapshot !== true || caps.events !== true || state.workerQuiescence !== 'unverified') throw new Error('Unsupported FACTORY authority.');
      const cells = array(state.cells, 10000).map(value => {
        const cell = record(value);
        return { id: id(cell.id), parentId: optionalId(cell.parentId), depth: num(cell.depth),
          role: choice(cell.role, ['coordinator', 'developer', 'verifier', 'watcher']), status: choice(cell.status, ['reserved', 'ready', 'retired']),
          heartbeat: date(cell.heartbeat), purpose: text(cell.purpose, 512), allocationCents: num(cell.allocationCents), budgetBasis: choice(cell.budgetBasis, ['logical-allocation']) };
      });
      const tasks = array(state.tasks, 10000).map(value => {
        const task = record(value), review = task.review === null ? null : record(task.review);
        if (review && typeof review.accepted !== 'boolean') throw new Error('Invalid review.');
        return { id: id(task.id), projectId: id(task.projectId), branch: text(task.branch, 256),
          status: choice(task.status, ['ready', 'running', 'review', 'verified', 'delivered', 'rejected', 'completed', 'cancelled']),
          attempt: num(task.attempt), owner: optionalId(task.owner), leaseExpiry: task.leaseExpiry === null ? null : date(task.leaseExpiry), specDigest: digest(task.specDigest),
          candidate: task.candidate === null ? null : { sha256: digest(record(task.candidate).sha256) },
          review: review ? { accepted: review.accepted as boolean, reviewerId: id(review.reviewerId), evidenceDigest: digest(review.evidenceDigest), candidateDigest: digest(review.candidateDigest), specDigest: digest(review.specDigest), attempt: num(review.attempt) } : null };
      });
      const effects = array(state.effects, 10000).map(value => {
        const effect = record(value);
        return { key: id(effect.key), kind: choice(effect.kind, ['provision', 'flow_call', 'message', 'flow_cancel', 'retire', 'delivery', 'worker_wake', 'worker_sleep']), state: choice(effect.state, ['accepted', 'running', 'unknown', 'succeeded', 'cancelled', 'not_applied']),
          owner: id(effect.owner), taskId: optionalId(effect.taskId), scope: choice(effect.scope, ['task', 'project', 'cleanup', 'worker']), scopeId: id(effect.scopeId),
          ownerEpoch: num(effect.ownerEpoch), controlEpoch: num(effect.controlEpoch), createdAt: date(effect.createdAt), updatedAt: date(effect.updatedAt), requestDigest: digest(effect.requestDigest) };
      });
      unique(cells.map(cell => cell.id)); unique(tasks.map(task => task.id)); unique(effects.map(effect => effect.key));
      const cursor = text(envelope.cursor, 32), buildRevision = text(envelope.buildRevision, 40);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(cursor) || !(buildRevision === 'unknown' || /^[a-f0-9]{40}$/.test(buildRevision))) throw new Error('Invalid provenance.');
      snapshot = { schemaVersion: 1, factoryId, revision: num(envelope.revision), cursor, observedAt: date(envelope.observedAt), scope: 'local-coordinator', buildRevision,
        capabilities: { snapshot: true, events: true, commands: false }, snapshot: { control: { status: choice(control.status, ['active', 'paused']), epoch: num(control.epoch), mission: text(control.mission, 2048) }, cells, tasks, effects, workerQuiescence: 'unverified' } };
    }
    const status = choice(source.status, ['observed', 'stale', 'unavailable']);
    if ((status === 'observed' || status === 'stale') && !snapshot) throw new Error('Missing recorded source.');
    const events = array(source.events ?? [], 1000).map(value => { const event = record(value); return { seq: num(event.seq), type: id(event.type), subject: text(event.subject), observedAt: date(event.observedAt) }; });
    return { id: sourceId, label: id(source.label), factoryId, status, snapshot, events };
  });
  unique(sources.map(source => source.id));
  return { schemaVersion: 1, scope: 'operator-source-registry', commands: false, observedAt: date(input.observedAt), sources, sample: input.sample === true };
}

export const nodeKey = (source: Pick<Source, 'id' | 'factoryId'>, kind: string, localId: string) => JSON.stringify([source.id, source.factoryId, kind, localId]);
export const selectionKey = (source: Source, selection: Selection) => nodeKey(source, selection.kind, selection.id);
export const selectionFragment = (source: Pick<Source, 'id' | 'factoryId'>, selection: Selection): string => new URLSearchParams({ source: source.id, factory: source.factoryId, kind: selection.kind, id: selection.id }).toString();
/** A saved link must name the authority, not just a reusable registry alias. */
export function selectionFromFragment(swarm: Swarm, fragment: string): Selection | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  if (['source', 'factory', 'kind', 'id'].some(key => params.getAll(key).length !== 1)) return null;
  const source = swarm.sources.find(source => source.id === params.get('source'));
  if (!source || source.factoryId !== params.get('factory')) return null;
  const kind = params.get('kind'), localId = params.get('id')!;
  const state = source.snapshot?.snapshot;
  const valid = kind === 'source' ? localId === source.id : kind === 'cell' ? state?.cells.some(cell => cell.id === localId) : kind === 'task' ? state?.tasks.some(task => task.id === localId) : kind === 'effect' && state?.effects.some(effect => effect.key === localId);
  return valid ? { sourceId: source.id, kind: kind as Selection['kind'], id: localId } : null;
}
const hash = (value: string) => { let result = 2166136261; for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619); return (result >>> 0) / 4294967296; };

/** O(cells + tasks + effects), including expiry independent of read time. */
export function activities(source: Source, now: number, sample = false): Map<string, Node['activity']> {
  const state = source.snapshot?.snapshot, result = new Map<string, Node['activity']>();
  if (!state) return result;
  const running = new Map<string, number>();
  for (const task of state.tasks) if (task.status === 'running' && task.owner) running.set(task.owner, Math.min(running.get(task.owner) ?? Infinity, task.leaseExpiry ? Date.parse(task.leaseExpiry) : 0));
  const unknown = new Set(state.effects.filter(effect => effect.state === 'unknown').map(effect => effect.owner));
  const observedAge = now - Date.parse(source.snapshot!.observedAt);
  for (const cell of state.cells) {
    const expiry = running.get(cell.id), heartbeatAge = now - Date.parse(cell.heartbeat);
    // Task completion does not resolve an external operation's unknown outcome.
    result.set(cell.id, unknown.has(cell.id) ? 'uncertain' : expiry === undefined ? 'idle' : source.status !== 'observed' || (!sample && (observedAge > 15000 || observedAge < -5000)) || state.control.status !== 'active' || cell.status !== 'ready' || heartbeatAge < 0 || heartbeatAge > 60000 || expiry <= now ? 'uncertain' : 'recent');
  }
  return result;
}

/** Full searchable index, stable source clusters and hierarchy. No force solver. */
export class SwarmIndex {
  readonly nodes = new Map<string, Node>();
  readonly children = new Map<string, string[]>();
  readonly sources = new Map<string, Source>();
  readonly issues: string[] = [];
  constructor(readonly swarm: Swarm, now = Date.now()) {
    const sorted = [...swarm.sources].sort((a, b) => a.id.localeCompare(b.id));
    sorted.forEach((source, index) => {
      this.sources.set(source.id, source);
      const angle = index * 2.3999632297, radius = sorted.length === 1 ? 0 : 95 * Math.sqrt(index + 1);
      const sourceKey = nodeKey(source, 'source', source.id), centre = { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius };
      this.nodes.set(sourceKey, { key: sourceKey, source, cell: null, selection: { sourceId: source.id, kind: 'source', id: source.id }, label: source.label, parent: null, point: { ...centre, y: -18 }, activity: 'idle' });
      const cells = source.snapshot?.snapshot.cells ?? [], byId = new Map(cells.map(cell => [cell.id, cell]));
      const activity = activities(source, now, swarm.sample);
      const resolved = new Map<string, Point>(), visiting = new Set<string>();
      // Iterative ancestor traversal handles a 10,000-level chain without stack overflow.
      const locate = (cell: Cell): Point => {
        if (resolved.has(cell.id)) return resolved.get(cell.id)!;
        const path: Cell[] = []; let cursor: Cell | undefined = cell;
        while (cursor && !resolved.has(cursor.id) && !visiting.has(cursor.id)) {
          visiting.add(cursor.id); path.push(cursor); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
        if (cursor && visiting.has(cursor.id)) this.issues.push(`${source.label}: delegation cycle at ${cursor.id}`);
        let point = cursor && resolved.get(cursor.id) || centre;
        for (const next of path.reverse()) {
          const phase = hash(nodeKey(source, 'cell', next.id)) * Math.PI * 2;
          const distance = next.parentId ? Math.max(8, 38 / Math.sqrt(Math.min(next.depth + 1, 12))) : 0;
          point = { x: point.x + Math.cos(phase) * distance, y: point.y + Math.sin(phase * 1.7) * distance * .4 + (next.parentId ? 5 : 0), z: point.z + Math.sin(phase) * distance };
          resolved.set(next.id, point); visiting.delete(next.id);
        }
        return resolved.get(cell.id)!;
      };
      for (const cell of cells) {
        const key = nodeKey(source, 'cell', cell.id), parent = cell.parentId && byId.has(cell.parentId) ? nodeKey(source, 'cell', cell.parentId) : sourceKey;
        if (cell.parentId && !byId.has(cell.parentId)) this.issues.push(`${source.label}: parent of ${cell.id} is not observed`);
        this.nodes.set(key, { key, source, cell, selection: { sourceId: source.id, kind: 'cell', id: cell.id }, label: cell.id, parent, point: locate(cell), activity: activity.get(cell.id) ?? 'idle' });
        const children = this.children.get(parent) ?? []; children.push(key); this.children.set(parent, children);
      }
    });
    for (const children of this.children.values()) children.sort();
  }
  ancestors(key: string): Node[] {
    const path: Node[] = [], seen = new Set<string>(); let node = this.nodes.get(key);
    while (node && !seen.has(node.key)) { seen.add(node.key); path.push(node); node = node.parent ? this.nodes.get(node.parent) : undefined; }
    return path.reverse();
  }
  /** Every indexed identity remains navigable; only the drawing is bounded. */
  visible(focus: string | null, page = 0, limit = 600): Node[] {
    if (this.nodes.size <= limit) return [...this.nodes.values()];
    const keys = new Set<string>([...this.nodes.values()].filter(node => !node.cell).map(node => node.key));
    if (focus) {
      for (const node of this.ancestors(focus).slice(-32)) keys.add(node.key);
      const nearby = this.children.get(focus) ?? [];
      const pageKeys = nearby.slice(page * 128, (page + 1) * 128);
      for (const key of pageKeys) keys.add(key);
      if (!this.nodes.get(focus)?.cell) for (const root of pageKeys) for (const key of (this.children.get(root) ?? []).slice(0, 12)) keys.add(key);
      const parent = this.nodes.get(focus)?.parent;
      if (parent) for (const key of (this.children.get(parent) ?? []).slice(0, 128)) keys.add(key);
    } else {
      for (const source of this.sources.values()) {
        for (const root of (this.children.get(nodeKey(source, 'source', source.id)) ?? []).slice(0, 128)) {
          keys.add(root);
          for (const key of (this.children.get(root) ?? []).slice(0, 12)) keys.add(key);
        }
      }
    }
    return [...keys].slice(0, limit).map(key => this.nodes.get(key)!).filter(Boolean);
  }
  search(query: string): Selection[] {
    const needle = query.trim().toLowerCase(), matches: Selection[] = [];
    if (!needle) return matches;
    for (const node of this.nodes.values()) if (`${node.label} ${node.source.label} ${node.source.factoryId} ${node.cell?.purpose ?? ''}`.toLowerCase().includes(needle)) matches.push(node.selection);
    for (const source of this.sources.values()) {
      for (const task of source.snapshot?.snapshot.tasks ?? []) if (`${task.id} ${task.projectId} ${task.branch}`.toLowerCase().includes(needle)) matches.push({ sourceId: source.id, kind: 'task', id: task.id });
      for (const effect of source.snapshot?.snapshot.effects ?? []) if (`${effect.key} ${effect.kind}`.toLowerCase().includes(needle)) matches.push({ sourceId: source.id, kind: 'effect', id: effect.key });
    }
    return matches;
  }
  nodeFor(selection: Selection): Node | undefined {
    const source = this.sources.get(selection.sourceId); if (!source) return;
    if (selection.kind === 'cell' || selection.kind === 'source') return this.nodes.get(selectionKey(source, selection));
    const state = source.snapshot?.snapshot;
    const owner = selection.kind === 'task' ? state?.tasks.find(task => task.id === selection.id)?.owner : state?.effects.find(effect => effect.key === selection.id)?.owner;
    return this.nodes.get(nodeKey(source, owner ? 'cell' : 'source', owner ?? source.id));
  }
}
