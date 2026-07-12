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

const NODE_TYPES: NodeType[] = ['start', 'process', 'finish', 'mcp', 'subflow'];

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
  const counts = { start: 0, process: 0, finish: 0, mcp: 0, subflow: 0 } as Record<NodeType, number>;
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

  // 2 & 3. Shared abilities and shared models — undirected synaptic ties.
  for (let i = 0; i < neurons.length; i++) {
    for (let j = i + 1; j < neurons.length; j++) {
      const a = neurons[i];
      const b = neurons[j];

      const sharedServers = intersect(a.servers, b.servers);
      if (sharedServers.length) {
        synapses.push({
          source: a.id,
          target: b.id,
          kind: 'server',
          weight: sharedServers.length,
          directed: false,
          detail: `share abilit${sharedServers.length > 1 ? 'ies' : 'y'}: ${sharedServers.join(', ')}`,
        });
      }

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
