import type { Neuron, ServerStatus } from '../types';

/** World radius for a neuron core — abilities/memories are fixed, behaviours grow with size. */
export function neuronRadius(n: Neuron): number {
  if (n.kind === 'ability') return 1.15;
  if (n.kind === 'resource') return 0.9; // memories are the smallest hubs
  return 0.9 + Math.sqrt(n.nodeTotal) * 0.55;
}

/** Ability stars break from their group hue when the server isn't healthy. */
export function abilityTint(status: ServerStatus | undefined): number | null {
  if (status === 'disconnected') return 0xff5c8a;
  if (status === 'disabled') return 0x556080;
  if (status === 'unknown' || status === undefined) return 0x9aa6c8;
  return null; // connected — keep the abilities-section hue
}
