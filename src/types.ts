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
 * MCP server (ability) state, from the running FLUJO instance. `unknown` is
 * the lookup fallback for servers FLUJO didn't report on.
 */
export type ServerStatus = 'connected' | 'disconnected' | 'disabled' | 'unknown';

// ---- Distilled "brain" model ----

/** An ability (MCP server) bound to a process node, with its enabled tools. */
export interface BoundAbility {
  server: string;
  tools: string[];
}

/** A single node inside a behaviour, kept for the expanded inner view. */
export interface InnerNode {
  id: string;
  type: NodeType;
  label: string;
  /** For mcp nodes: the bound ability (MCP server) name (status lookup). */
  server?: string;
  /** Normalized position in [-1, 1] derived from the flow editor layout. */
  x: number;
  y: number;
  /** Process nodes: the node's prompt template. */
  prompt?: string;
  /** Process nodes: resolved model name shown in the detail panel. */
  modelName?: string;
  /** Process nodes: prompt-composition settings. */
  excludeModelPrompt?: boolean;
  excludeStartNodePrompt?: boolean;
  /** Process nodes: abilities wired into this node. */
  abilities?: BoundAbility[];
  /** Mcp nodes: tools enabled on the bound ability. */
  enabledTools?: string[];
  /** Subflow nodes: the behaviour this node calls, and how data flows. */
  subflowId?: string;
  inputMode?: string;
  outputMode?: string;
}

/** One behaviour (FLUJO flow) = one neuron. */
export interface Neuron {
  id: string;
  name: string;
  description: string;
  folder: string;
  counts: Record<NodeType, number>;
  /** Node count excluding start nodes (they are hidden from the viz). */
  nodeTotal: number;
  /** The behaviour-level prompt, taken from the start node. */
  prompt?: string;
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
  /** Ability (MCP server) name -> current status. */
  servers: Record<string, ServerStatus>;
}
