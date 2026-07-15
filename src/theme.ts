import { Color } from 'three';
import type { NodeType, SynapseKind } from './types';

/** Neuron hue is driven by the model provider it leans on. */
export const PROVIDER_COLORS: Record<string, number> = {
  'claude-subscription': 0xff8a3d, // amber
  anthropic: 0xff8a3d,
  openrouter: 0x5cf2a0, // green
  openai: 0x10d0a0, // teal-green
  ollama: 0x38d0ff, // cyan
  gemini: 0x8f7bff, // violet
  google: 0x8f7bff,
  xai: 0xff5c8a, // pink
  requesty: 0xd0b04a, // gold
  unknown: 0x9aa6c8, // slate
};

const NEUTRAL = 0x9aa6c8;

export function providerColor(providers: string[]): Color {
  if (!providers.length) return new Color(NEUTRAL);
  return new Color(PROVIDER_COLORS[providers[0]] ?? NEUTRAL);
}

/**
 * Synapse hues follow FLUJO's editor: subflow nodes are amber (warning),
 * MCP/ability nodes are blue (info). Shared model gets its own violet.
 */
export const SYNAPSE_COLORS: Record<SynapseKind, number> = {
  subflow: 0xf59e0b, // amber axon — the strongest tie
  server: 0x4d8df6, // blue — shared MCP tooling
  model: 0xa78bfa, // violet — shared model
};

/** A tool result that failed — the reverse flash burns red. */
export const SYNAPSE_ERROR = 0xff3b3b;

/** FLUJO's own node palette (brightened for additive glow on dark). */
export const NODE_TYPE_COLORS: Record<NodeType, number> = {
  start: 0xa1887f, // brown, as in FLUJO
  process: 0x9aa7b8, // grey (FLUJO secondary)
  mcp: 0x4d8df6, // blue (FLUJO info)
  subflow: 0xf59e0b, // amber (FLUJO warning)
  finish: 0x4ade80, // green (FLUJO success)
};

export const BACKGROUND = 0x05070f;

/** UI vocabulary: flows are "behaviours", MCP servers are "abilities". */
export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  start: 'start',
  process: 'process',
  mcp: 'ability',
  subflow: 'behaviour',
  finish: 'finish',
};

export function nodeTypeLabel(t: NodeType): string {
  return NODE_TYPE_LABELS[t];
}

export function providerLabel(p: string): string {
  return p.replace('claude-subscription', 'claude').replace(/-/g, ' ');
}
