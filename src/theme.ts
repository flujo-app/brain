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

export const SYNAPSE_COLORS: Record<SynapseKind, number> = {
  subflow: 0xffd24a, // bright gold axon — the strongest tie
  server: 0x35e0d0, // teal — shared MCP tooling
  model: 0x7d7bff, // indigo — shared model
};

export const NODE_TYPE_COLORS: Record<NodeType, number> = {
  start: 0x5cf2a0,
  process: 0xff8a3d,
  mcp: 0x35e0d0,
  subflow: 0xffd24a,
  finish: 0xff5c8a,
};

export const BACKGROUND = 0x05070f;

export function providerLabel(p: string): string {
  return p.replace('claude-subscription', 'claude').replace(/-/g, ' ');
}
