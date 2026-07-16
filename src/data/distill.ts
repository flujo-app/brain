import type {
  BoundAbility,
  BrainGraph,
  InnerNode,
  ModelInfo,
  Neuron,
  NodeType,
  RawFlow,
  RawNode,
  ServerStatus,
  Synapse,
} from '../types';

const NODE_TYPES: NodeType[] = ['start', 'process', 'finish', 'mcp', 'subflow', 'resource'];

/** One zeroed per-type counter — the single authority so a new NodeType can't
 * silently miss an initializer. */
function zeroCounts(): Record<NodeType, number> {
  return { start: 0, process: 0, finish: 0, mcp: 0, subflow: 0, resource: 0 };
}

/** The brain-stem behaviour — the root flow carrying the mind's life goal. */
export const STEM_RE = /brain.?stem/i;

/** True for the brain-stem behaviour (never an ability neuron). */
export function isStem(n: Neuron): boolean {
  return n.kind !== 'ability' && STEM_RE.test(n.name);
}

function nodeType(n: RawNode): NodeType {
  const t = (n.data?.type ?? n.type ?? '') as NodeType;
  return NODE_TYPES.includes(t) ? t : 'process';
}

function prop<T = unknown>(n: RawNode, key: string): T | undefined {
  return n.data?.properties?.[key] as T | undefined;
}

/** FLUJO stores enabled tools as a whitespace-separated string. */
function parseTools(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  return [];
}

/** Abilities a process node binds, deduped by server name. */
function parseAbilities(n: RawNode): BoundAbility[] {
  const raw = prop<Array<{ properties?: { boundServer?: string; enabledTools?: unknown } }>>(n, 'mcpNodes');
  if (!Array.isArray(raw)) return [];
  const byServer = new Map<string, BoundAbility>();
  for (const m of raw) {
    const server = m?.properties?.boundServer;
    if (!server || byServer.has(server)) continue;
    byServer.set(server, { server, tools: parseTools(m.properties?.enabledTools) });
  }
  return [...byServer.values()];
}

function toInner(n: RawNode): Omit<InnerNode, 'x' | 'y'> {
  const type = nodeType(n);
  const inner: Omit<InnerNode, 'x' | 'y'> = {
    id: n.id,
    type,
    label: n.data?.label ?? type,
    description: n.data?.description || undefined,
  };
  if (type === 'process') {
    inner.prompt = prop<string>(n, 'promptTemplate') || undefined;
    inner.modelName = prop<string>(n, 'modelName');
    inner.excludeModelPrompt = prop<boolean>(n, 'excludeModelPrompt');
    inner.excludeStartNodePrompt = prop<boolean>(n, 'excludeStartNodePrompt');
    const abilities = parseAbilities(n);
    if (abilities.length) inner.abilities = abilities;
  } else if (type === 'mcp') {
    inner.server = prop<string>(n, 'boundServer');
    inner.enabledTools = parseTools(prop(n, 'enabledTools'));
  } else if (type === 'subflow') {
    inner.subflowId = prop<string>(n, 'subflowId');
    inner.inputMode = prop<string>(n, 'inputMode');
    inner.outputMode = prop<string>(n, 'outputMode');
  } else if (type === 'resource') {
    inner.resourceScope = prop<string>(n, 'scope') === 'run' ? 'run' : 'mcp';
    inner.server = prop<string>(n, 'boundServer');
    inner.uri = inner.resourceScope === 'run'
      ? prop<string>(n, 'runName')
      : prop<string>(n, 'uri');
  }
  return inner;
}

/**
 * Map raw flow-editor node coordinates into a normalized [-1, 1] box,
 * preserving the editor's aspect ratio. Start nodes are excluded — they are
 * pure entry markers and only add noise to the visual.
 */
function normalizeInner(nodes: RawNode[]): InnerNode[] {
  const kept = nodes.filter((n) => nodeType(n) !== 'start');
  if (!kept.length) return [];
  const pts = kept.map((n) => n.position ?? { x: 0, y: 0 });
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return kept.map((n) => {
    const p = n.position ?? { x: cx, y: cy };
    return {
      ...toInner(n),
      x: ((p.x - cx) / span) * 2,
      // Flow editor Y grows downward; flip so the graph reads upright.
      y: (-(p.y - cy) / span) * 2,
    };
  });
}

function toNeuron(flow: RawFlow, models: Record<string, ModelInfo>): Neuron {
  const counts = zeroCounts();
  const providers = new Set<string>();
  const modelNames = new Set<string>();
  const servers = new Set<string>();
  const subflowRefs = new Set<string>();
  const startIds = new Set<string>();
  let flowPrompt: string | undefined;

  for (const n of flow.nodes) {
    const t = nodeType(n);
    counts[t]++;
    if (t === 'start') {
      startIds.add(n.id);
      const p = prop<string>(n, 'promptTemplate');
      if (p && !flowPrompt) flowPrompt = p;
    } else if (t === 'process') {
      const boundModel = prop<string>(n, 'boundModel');
      const modelName = prop<string>(n, 'modelName');
      if (boundModel && models[boundModel]) {
        providers.add(models[boundModel].provider);
        modelNames.add(models[boundModel].name);
      } else if (modelName) {
        modelNames.add(modelName);
      }
      for (const a of parseAbilities(n)) servers.add(a.server);
    } else if (t === 'mcp') {
      const server = prop<string>(n, 'boundServer');
      if (server) servers.add(server);
    } else if (t === 'subflow') {
      const ref = prop<string>(n, 'subflowId');
      if (ref) subflowRefs.add(ref);
    }
  }

  return {
    id: flow.id,
    name: flow.name ?? 'untitled',
    description: flow.description ?? '',
    folder: flow.folder ?? '',
    counts,
    nodeTotal: flow.nodes.length - counts.start,
    prompt: flowPrompt,
    providers: [...providers],
    modelNames: [...modelNames],
    servers: [...servers],
    subflowRefs: [...subflowRefs],
    broken: flow.nodes.length > 1 && flow.edges.length === 0,
    inner: {
      nodes: normalizeInner(flow.nodes),
      // Edges touching a start node vanish with it.
      edges: flow.edges
        .filter((e) => !startIds.has(e.source) && !startIds.has(e.target))
        .map((e) => ({ source: e.source, target: e.target })),
    },
  };
}

function intersect(a: string[], b: string[]): string[] {
  const bs = new Set(b);
  return a.filter((x) => bs.has(x));
}

/** Stable neuron id for an MCP server, distinct from any flow id. */
export function abilityId(server: string): string {
  return `ability:${server}`;
}

/**
 * Match a live tool-call name to the ability (MCP server) it belongs to.
 * FLUJO tool names are typically "<server>_<tool>" or "-_-"-joined; the
 * longest server-name prefix followed by a separator wins.
 */
export function abilityForTool(graph: BrainGraph, toolName?: string): Neuron | null {
  if (!toolName) return null;
  const t = toolName.toLowerCase();
  let best: Neuron | null = null;
  for (const n of graph.neurons) {
    if (n.kind !== 'ability') continue;
    const s = n.name.toLowerCase();
    const next = t[s.length];
    if (t.startsWith(s) && (next === undefined || !/[a-z0-9]/.test(next))) {
      if (!best || s.length > best.name.length) best = n;
    }
  }
  return best;
}

/**
 * Split a wire tool name into its server and tool halves for display:
 * "memory__open_nodes" → { server: "memory", tool: "open nodes" }.
 * Handles the agent-SDK "<server>__<tool>" scheme and the legacy
 * "_-_-_"-joined one; anything else is shown whole as the tool.
 */
export function splitToolName(name: string): { server: string | null; tool: string } {
  const pretty = (s: string) => s.replace(/_/g, ' ').trim();
  const legacy = name.split('_-_-_').filter(Boolean);
  if (legacy.length >= 2) return { server: legacy[0], tool: pretty(legacy.slice(1).join(' ')) };
  const sep = name.indexOf('__');
  if (sep > 0) return { server: name.slice(0, sep), tool: pretty(name.slice(sep + 2)) };
  return { server: null, tool: pretty(name) };
}

/** An MCP server as a small neuron of its own. */
function toAbility(server: string): Neuron {
  return {
    id: abilityId(server),
    kind: 'ability',
    name: server,
    description: '',
    folder: '',
    counts: zeroCounts(),
    nodeTotal: 0,
    providers: [],
    modelNames: [],
    servers: [server],
    subflowRefs: [],
    broken: false,
    inner: { nodes: [], edges: [] },
  };
}

// ---- Resources ("memories", Tier 3) ----------------------------------------

/** djb2 — deterministic short hash so very long uris still yield a stable id. */
function hashUri(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Stable neuron id for a STATIC resource on a server. */
export function resourceId(server: string, uri: string): string {
  const body = uri.length <= 64 ? uri : hashUri(uri);
  return `resource:${server}:${body}`;
}

/** Stable, conversation-agnostic id for a RUN artifact (run uris are id-based
 * and per-conversation, so the NAME is the identity). */
export function runResourceId(name: string): string {
  return `resource:flujo:run:${name}`;
}

/** A referenced data artifact, collected from a flow's resource nodes + pills. */
interface ResourceRef {
  id: string;
  name: string;
  uri: string;
  server?: string;
  /** 'produce' when a process→resource edge writes into it; else 'consume'. */
  role: 'consume' | 'produce';
}

/** `${resource:<server>__<uri>}` pills in process prompts (new format only). */
const PILL_RE = /\$\{resource:([^}]+)\}/g;

/**
 * Every data artifact a flow references: resource NODES (role from edge
 * direction — an edge INTO the resource node means the flow writes it) and
 * resource PILLS in process prompt templates (always reads).
 */
function collectResourceRefs(flow: RawFlow): ResourceRef[] {
  const refs = new Map<string, ResourceRef>();
  const upsert = (ref: ResourceRef) => {
    const existing = refs.get(ref.id);
    // 'produce' wins: a flow that both writes and reads shows as the writer.
    if (!existing || (ref.role === 'produce' && existing.role === 'consume')) refs.set(ref.id, ref);
  };

  for (const n of flow.nodes) {
    if (nodeType(n) !== 'resource') continue;
    const scope = prop<string>(n, 'scope') === 'run' ? 'run' : 'mcp';
    const produced = flow.edges.some((e) => e.target === n.id);
    if (scope === 'run') {
      const name = prop<string>(n, 'runName');
      if (!name) continue;
      upsert({
        id: runResourceId(name),
        name,
        uri: `run:${name}`,
        server: 'flujo',
        role: produced ? 'produce' : 'consume',
      });
    } else {
      const server = prop<string>(n, 'boundServer');
      const uri = prop<string>(n, 'uri');
      if (!server || !uri) continue;
      upsert({
        id: resourceId(server, uri),
        name: n.data?.label || uri.split('/').pop() || uri,
        uri,
        server,
        role: 'consume', // static resources are read-only
      });
    }
  }

  for (const n of flow.nodes) {
    if (nodeType(n) !== 'process') continue;
    const promptText = prop<string>(n, 'promptTemplate');
    if (!promptText) continue;
    PILL_RE.lastIndex = 0;
    for (let m = PILL_RE.exec(promptText); m; m = PILL_RE.exec(promptText)) {
      const body = m[1];
      const sep = body.indexOf('__');
      if (sep <= 0) continue; // legacy/odd pill bodies are skipped
      const server = body.slice(0, sep);
      const uri = body.slice(sep + 2);
      upsert({
        id: resourceId(server, uri),
        name: uri.split('/').pop() || uri,
        uri,
        server,
        role: 'consume',
      });
    }
  }

  return [...refs.values()];
}

/** A data artifact as a small "memory" neuron. */
function toResource(ref: ResourceRef): Neuron {
  return {
    id: ref.id,
    kind: 'resource',
    name: ref.name,
    description: '',
    folder: '',
    counts: zeroCounts(),
    nodeTotal: 0,
    providers: [],
    modelNames: [],
    servers: ref.server ? [ref.server] : [],
    subflowRefs: [],
    broken: false,
    uri: ref.uri,
    inner: { nodes: [], edges: [] },
  };
}

/**
 * Resolve which neuron a live resource event lights up:
 * exact static id (server+uri) → run-artifact id (event name) → the owning
 * ability hub (typically `ability:flujo` for run resources without a declared
 * memory neuron). Null when nothing matches at all.
 */
export function resourceNeuronFor(
  graph: BrainGraph,
  server?: string,
  uri?: string,
  name?: string,
): Neuron | null {
  const byId = new Map(graph.neurons.map((n) => [n.id, n]));
  if (server && uri) {
    const exact = byId.get(resourceId(server, uri));
    if (exact) return exact;
  }
  if (name) {
    const byName = byId.get(runResourceId(name));
    if (byName) return byName;
  }
  if (server) {
    const hub = byId.get(abilityId(server));
    if (hub) return hub;
  }
  return null;
}

/** Turn raw flows into behaviours + the synapses that wire them together. */
export function distill(
  flows: RawFlow[],
  models: Record<string, ModelInfo>,
  servers: Record<string, ServerStatus>,
): BrainGraph {
  const neurons = flows.map((f) => toNeuron(f, models));
  const byId = new Map(neurons.map((n) => [n.id, n]));
  const synapses: Synapse[] = [];

  // 1. Behaviour calls — explicit, directed axons.
  for (const n of neurons) {
    for (const ref of n.subflowRefs) {
      if (byId.has(ref) && ref !== n.id) {
        synapses.push({
          source: n.id,
          target: ref,
          kind: 'subflow',
          weight: 1,
          directed: true,
          detail: `calls behaviour "${byId.get(ref)!.name}"`,
        });
      }
    }
  }

  // 2. Abilities — every MCP server (configured in FLUJO or bound by a flow)
  // becomes its own small neuron, tied to each behaviour that uses it. Shared
  // tooling still reads at a glance: sharing behaviours meet at the same hub.
  const serverNames = new Set<string>(Object.keys(servers));
  for (const n of neurons) for (const s of n.servers) serverNames.add(s);
  const abilities = [...serverNames].sort().map(toAbility);
  for (const n of neurons) {
    for (const s of n.servers) {
      synapses.push({
        source: n.id,
        target: abilityId(s),
        kind: 'server',
        weight: 1,
        directed: false,
        detail: `uses ability "${s}"`,
      });
    }
  }
  neurons.push(...abilities);

  // 2.5 Memories (Tier 3) — every data artifact a flow references (resource
  // nodes + resource pills) becomes a small "memory" neuron. Only
  // flow-referenced resources are distilled — listing every server's full
  // resource catalog would be unbounded, and only referenced ones can ever
  // light up. Writes are directed behaviour → memory; reads are undirected.
  const resourceNeurons = new Map<string, Neuron>();
  for (const flow of flows) {
    for (const ref of collectResourceRefs(flow)) {
      if (!resourceNeurons.has(ref.id)) resourceNeurons.set(ref.id, toResource(ref));
      synapses.push({
        source: flow.id,
        target: ref.id,
        kind: 'resource',
        weight: 1,
        directed: ref.role === 'produce',
        detail: ref.role === 'produce'
          ? `writes memory "${ref.name}"`
          : `reads memory "${ref.name}"`,
      });
    }
  }
  neurons.push(...resourceNeurons.values());

  // 3. Shared models — undirected synaptic ties (abilities have none).
  for (let i = 0; i < neurons.length; i++) {
    for (let j = i + 1; j < neurons.length; j++) {
      const a = neurons[i];
      const b = neurons[j];

      const sharedModels = intersect(a.modelNames, b.modelNames);
      if (sharedModels.length) {
        synapses.push({
          source: a.id,
          target: b.id,
          kind: 'model',
          weight: sharedModels.length,
          directed: false,
          detail: `share model${sharedModels.length > 1 ? 's' : ''}: ${sharedModels.join(', ')}`,
        });
      }
    }
  }

  return { neurons, synapses, servers };
}
