// ---- Raw FLUJO shapes (subset of what /api/flow returns) ----

export type NodeType = 'start' | 'process' | 'finish' | 'mcp' | 'subflow';

export interface RawNode {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data: {
    label?: string;
    type?: string;
    description?: string;
    properties?: Record<string, unknown>;
  };
}

export interface RawEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface RawFlow {
  id: string;
  name: string;
  description?: string;
  folder?: string;
  nodes: RawNode[];
  edges: RawEdge[];
}

export interface ModelInfo {
  name: string;
  provider: string;
}

/**
 * MCP server state. `connected`/`disconnected` come from a live FLUJO;
 * a snapshot only knows `disabled` vs `unknown` (configured, state unknowable).
 */
export type ServerStatus = 'connected' | 'disconnected' | 'disabled' | 'unknown';

export interface BrainSnapshot {
  generatedAt: string | null;
  source: string;
  models: Record<string, ModelInfo>;
  servers?: Record<string, { status: ServerStatus }>;
  flows: RawFlow[];
}

// ---- Distilled "brain" model ----

/** A single node inside a flow, kept for the expanded inner view. */
export interface InnerNode {
  id: string;
  type: NodeType;
  label: string;
  /** For mcp nodes: the bound MCP server name (status lookup). */
  server?: string;
  /** Normalized position in [-1, 1] derived from the flow editor layout. */
  x: number;
  y: number;
}

/** One flow = one neuron. */
export interface Neuron {
  id: string;
  name: string;
  description: string;
  folder: string;
  counts: Record<NodeType, number>;
  nodeTotal: number;
  /** Resolved model provider names actually used (process nodes). */
  providers: string[];
  modelNames: string[];
  /** MCP server ids bound by mcp nodes. */
  servers: string[];
  /** Target flow ids this flow calls as subflows. */
  subflowRefs: string[];
  /** True when the flow has nodes but no wiring (a "dormant" neuron). */
  broken: boolean;
  inner: { nodes: InnerNode[]; edges: Array<{ source: string; target: string }> };
}

export type SynapseKind = 'subflow' | 'server' | 'model';

/** One relationship between two neurons. */
export interface Synapse {
  source: string;
  target: string;
  kind: SynapseKind;
  /** Number of shared resources (>=1); subflow links are always weight 1. */
  weight: number;
  /** subflow links are directed source -> target. */
  directed: boolean;
  /** Human-readable reason, e.g. shared server / model names. */
  detail: string;
}

export interface BrainGraph {
  neurons: Neuron[];
  synapses: Synapse[];
  /** MCP server name -> current status. */
  servers: Record<string, ServerStatus>;
  source: 'live' | 'snapshot';
}
