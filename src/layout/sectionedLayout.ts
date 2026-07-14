import { Vector3 } from 'three';
import type { BrainGraph } from '../types';
import type { Grouping } from '../grouping';
import { isStem } from '../data/distill';

export interface SectionedLayout {
  positions: Map<string, Vector3>;
  /** group id -> galaxy centre, for nebulae and labels. */
  centers: Map<string, Vector3>;
  /** group id -> approximate galaxy radius. */
  radii: Map<string, number>;
}

/**
 * Two-level layout: each group becomes a spatially separated "galaxy". Group
 * centres are spread on a Fibonacci sphere; within a galaxy, neurons are pulled
 * to their centre and gently repel each other, while synapses add local
 * structure (subflow ties pull hardest, cross-galaxy ties barely pull so the
 * galaxies stay distinct).
 */
export function computeSectionedLayout(graph: BrainGraph, grouping: Grouping, flat = false, iterations = 260): SectionedLayout {
  const nodes = graph.neurons;
  const n = nodes.length;
  const groups = grouping.groups;
  const g = groups.length;

  // Galaxy centres on a Fibonacci sphere; in flat mode, on a sunflower disc
  // in the z=0 plane (single group -> origin).
  const centers = new Map<string, Vector3>();
  const spread = g <= 1 ? 0 : 22 + Math.sqrt(g) * 14 + Math.cbrt(n) * 4;
  groups.forEach((grp, i) => {
    if (g <= 1) {
      centers.set(grp.id, new Vector3(0, 0, 0));
      return;
    }
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    if (flat) {
      const r = spread * 1.15 * Math.sqrt((i + 0.5) / g);
      centers.set(grp.id, new Vector3(r * Math.cos(theta), r * Math.sin(theta), 0));
      return;
    }
    const t = (i + 0.5) / g;
    const phi = Math.acos(1 - 2 * t);
    centers.set(
      grp.id,
      new Vector3(spread * Math.sin(phi) * Math.cos(theta), spread * Math.cos(phi) * 0.7, spread * Math.sin(phi) * Math.sin(theta)),
    );
  });

  const groupOf = grouping.byNeuron;
  const pos = new Map<string, Vector3>();
  const vel = new Map<string, Vector3>();

  // Seed each neuron near its galaxy centre with a deterministic offset.
  nodes.forEach((node, i) => {
    const c = centers.get(groupOf.get(node.id)!)!;
    const a = i * 2.399963; // golden angle
    const r = 3 + ((i * 2654435761) % 1000) / 1000 * 5;
    pos.set(
      node.id,
      flat
        ? new Vector3(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, 0)
        : new Vector3(c.x + Math.cos(a) * r, c.y + Math.sin(a * 1.7) * r * 0.6, c.z + Math.sin(a) * r),
    );
    vel.set(node.id, new Vector3());
  });

  const sameGroup = (a: string, b: string) => groupOf.get(a) === groupOf.get(b);
  const springK = (kind: string, intra: boolean) => {
    if (kind === 'subflow') return intra ? 0.05 : 0.012;
    if (kind === 'server') return intra ? 0.03 : 0.004;
    return intra ? 0.018 : 0.002;
  };

  const CENTER_PULL = 0.06; // toward own galaxy centre
  const INTRA_REPULSION = 26; // spread neurons inside a galaxy
  const DAMPING = 0.8;
  const MAX_STEP = 3;
  const tmp = new Vector3();

  for (let iter = 0; iter < iterations; iter++) {
    const cool = 1 - iter / iterations;

    // Repulsion between neurons in the same galaxy only (keeps galaxies tight).
    for (let i = 0; i < n; i++) {
      const a = pos.get(nodes[i].id)!;
      const va = vel.get(nodes[i].id)!;
      for (let j = i + 1; j < n; j++) {
        if (!sameGroup(nodes[i].id, nodes[j].id)) continue;
        const b = pos.get(nodes[j].id)!;
        tmp.copy(a).sub(b);
        let d2 = tmp.lengthSq();
        if (d2 < 0.01) {
          tmp.set((i % 3) - 1, (j % 3) - 1, ((i + j) % 3) - 1);
          d2 = 1;
        }
        tmp.normalize().multiplyScalar(INTRA_REPULSION / d2);
        va.add(tmp);
        vel.get(nodes[j].id)!.sub(tmp);
      }
    }

    // Synapse springs.
    for (const s of graph.synapses) {
      const a = pos.get(s.source);
      const b = pos.get(s.target);
      if (!a || !b) continue;
      const intra = sameGroup(s.source, s.target);
      const rest = s.kind === 'subflow' ? 6 : 9;
      tmp.copy(b).sub(a);
      const dist = tmp.length() || 0.001;
      const force = (dist - rest) * springK(s.kind, intra) * Math.min(s.weight, 3);
      tmp.normalize().multiplyScalar(force);
      vel.get(s.source)!.add(tmp);
      vel.get(s.target)!.sub(tmp);
    }

    // Pull toward own galaxy centre + integrate.
    for (const node of nodes) {
      const p = pos.get(node.id)!;
      const v = vel.get(node.id)!;
      const c = centers.get(groupOf.get(node.id)!)!;
      tmp.copy(c).sub(p).multiplyScalar(CENTER_PULL);
      v.add(tmp);
      v.multiplyScalar(DAMPING);
      if (v.length() > MAX_STEP) v.setLength(MAX_STEP);
      p.addScaledVector(v, cool);
      if (flat) {
        p.z = 0;
        v.z = 0;
      }
    }
  }

  // Measure galaxy radii from the settled positions.
  const radii = new Map<string, number>();
  for (const grp of groups) {
    const c = centers.get(grp.id)!;
    let max = 4;
    for (const id of grp.neuronIds) max = Math.max(max, pos.get(id)!.distanceTo(c));
    radii.set(grp.id, max);
  }

  // Recentre the whole brain. The brain-stem — the mind's root — always sits
  // dead centre when one exists (both renderers frame the camera on the
  // origin), so it reads as the core the rest of the brain grows around.
  // Without a stem we fall back to the geometric centroid.
  const stem = nodes.find(isStem);
  const origin = (stem && pos.get(stem.id)) || (() => {
    const centroid = new Vector3();
    for (const p of pos.values()) centroid.add(p);
    return centroid.multiplyScalar(1 / Math.max(n, 1));
  })();
  const shift = origin.clone();
  for (const p of pos.values()) p.sub(shift);
  for (const c of centers.values()) c.sub(shift);

  return { positions: pos, centers, radii };
}
