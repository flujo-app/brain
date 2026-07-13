import { Color } from 'three';
import type { Neuron } from './types';
import { PROVIDER_COLORS, providerLabel } from './theme';

export type GroupMode = 'provider' | 'folder' | 'model';

/** Ability (MCP server) neurons cluster in their own section in every mode. */
export const ABILITY_GROUP = '~abilities';
const ABILITY_COLOR = 0x4d8df6; // matches the mcp/server blue in the theme

export interface Group {
  id: string;
  label: string;
  color: Color;
  neuronIds: string[];
}

export interface Grouping {
  mode: GroupMode;
  groups: Group[];
  /** neuronId -> group id */
  byNeuron: Map<string, string>;
}

function keyFor(n: Neuron, mode: GroupMode): { key: string; label: string } {
  if (n.kind === 'ability') return { key: ABILITY_GROUP, label: 'Abilities' };
  if (mode === 'folder') {
    const f = n.folder?.trim();
    return { key: f || '~ungrouped', label: f || 'Ungrouped' };
  }
  if (mode === 'model') {
    const m = n.modelNames[0];
    return { key: m || '~none', label: m || 'no model' };
  }
  const p = n.providers[0];
  return { key: p || '~none', label: p ? providerLabel(p) : 'no model' };
}

/** Deterministic pleasant hue for groups that have no fixed provider colour. */
function paletteColor(index: number): Color {
  const hue = (index * 0.61803398875) % 1; // golden angle
  return new Color().setHSL(hue, 0.62, 0.6);
}

export function groupNeurons(neurons: Neuron[], mode: GroupMode): Grouping {
  const map = new Map<string, Group>();
  const order: string[] = [];

  for (const n of neurons) {
    const { key, label } = keyFor(n, mode);
    let g = map.get(key);
    if (!g) {
      g = { id: key, label, color: new Color(0xffffff), neuronIds: [] };
      map.set(key, g);
      order.push(key);
    }
    g.neuronIds.push(n.id);
  }

  // Assign colours: providers get their brand hue, everything else a palette hue.
  order.forEach((key, i) => {
    const g = map.get(key)!;
    if (key === ABILITY_GROUP) {
      g.color = new Color(ABILITY_COLOR);
    } else if (mode === 'provider' && PROVIDER_COLORS[key] !== undefined) {
      g.color = new Color(PROVIDER_COLORS[key]);
    } else {
      g.color = paletteColor(i);
    }
  });

  // Largest galaxies first — nicer label stacking and layout.
  const groups = order.map((k) => map.get(k)!).sort((a, b) => b.neuronIds.length - a.neuronIds.length);
  const byNeuron = new Map<string, string>();
  for (const g of groups) for (const id of g.neuronIds) byNeuron.set(id, g.id);

  return { mode, groups, byNeuron };
}
