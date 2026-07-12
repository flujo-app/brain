import type {
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

/** Map raw flow-editor node coordinates into a normalized [-1, 1] box. */
function normalizeInner(nodes: RawNode[]): InnerNode[] {
  const pts = nodes.map((n) => n.position ?? { x: 0, y: 0 });
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const span = Math.max(spanX, spanY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return nodes.map((n) => {
    const p = n.position ?? { x: cx, y: cy };
    return {
      id: n.id,
      type: nodeType(n),
      label: n.data?.label ?? nodeType(n),
      server: prop<string>(n, 'boundServer'),
      x: ((p.x - cx) / span) * 2,
      // Flow editor Y grows downward; flip so the neuron reads upright.
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

  for (const n of flow.nodes) {
    const t = nodeType(n);
    counts[t]++;
    if (t === 'process') {
      const boundModel = prop<string>(n, 'boundModel');
      const modelName = prop<string>(n, 'modelName');
      if (boundModel && models[boundModel]) {
        providers.add(models[boundModel].provider);
        modelNames.add(models[boundModel].name);
      } else if (modelName) {
        modelNames.add(modelName);
      }
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
    nodeTotal: flow.nodes.length,
    providers: [...providers],
    modelNames: [...modelNames],
    servers: [...servers],
    subflowRefs: [...subflowRefs],
    broken: flow.nodes.length > 1 && flow.edges.length === 0,
    inner: {
      nodes: normalizeInner(flow.nodes),
      edges: flow.edges.map((e) => ({ source: e.source, target: e.target })),
    },
  };
}

function intersect(a: string[], b: string[]): string[] {
  const bs = new Set(b);
  return a.filter((x) => bs.has(x));
}

/** Turn raw flows into neurons + the synapses that wire them together. */
export function distill(
  flows: RawFlow[],
  models: Record<string, ModelInfo>,
  servers: Record<string, ServerStatus>,
  source: 'live' | 'snapshot',
): BrainGraph {
  const neurons = flows.map((f) => toNeuron(f, models));
  const byId = new Map(neurons.map((n) => [n.id, n]));
  const synapses: Synapse[] = [];

  // 1. Subflow calls — explicit, directed axons.
  for (const n of neurons) {
    for (const ref of n.subflowRefs) {
      if (byId.has(ref) && ref !== n.id) {
        synapses.push({
          source: n.id,
          target: ref,
          kind: 'subflow',
          weight: 1,
          directed: true,
          detail: `calls "${byId.get(ref)!.name}" as a subflow`,
        });
      }
    }
  }

  // 2 & 3. Shared MCP servers and shared models — undirected synaptic ties.
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
          detail: `share MCP server${sharedServers.length > 1 ? 's' : ''}: ${sharedServers.join(', ')}`,
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

  return { neurons, synapses, servers, source };
}
