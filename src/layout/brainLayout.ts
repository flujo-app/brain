import { Vector3 } from 'three';
import type { BrainGraph } from '../types';
import type { Grouping } from '../grouping';
import { isStem } from '../data/distill';

export interface BrainLayout {
  positions: Map<string, Vector3>;
}

/**
 * A brain-shaped layout (replacing the old galaxy layout). The brain-stem sits
 * dead centre; every other behaviour is drawn toward the stem in proportion to
 * how often it is STATICALLY called (its subflow in-degree), so hubs cluster in
 * the core and leaves drift to the rim. All neurons are confined within a
 * bilateral brain silhouette — a lobed outline in the flat 2D view, a
 * front-heavy, top-grooved ellipsoid in 3D — so the whole reads as a brain,
 * not a sphere. Grouping no longer places neurons in space (it only tints
 * them); it is accepted for signature compatibility.
 *
 * Deterministic throughout (golden-angle seeding + integer hashing, never
 * Math.random) so the same graph always lays out identically.
 */

const GOLDEN_ANGLE = 2.399963;
const P = 0.85; // radius curve: >1 keeps the core sparse
const S_INNER = 0.12; // reserve the exact origin for the stem
const ABILITY_BIAS = 0.55; // even a popular server sits in a mid/outer shell
const K_RADIAL = 0.08; // pull toward the in-degree target radius
const INTRA_REPULSION = 26;
const DAMPING = 0.8;
const MAX_STEP = 3;
const MIN_GAP = 0.06; // hemisphere half-gap at the midline
const K_SIDE = 0.03;

const hash01 = (i: number): number => ((i * 2654435761) >>> 0) % 1000 / 1000;

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
const gauss = (x: number, mu: number, sig: number): number => Math.exp(-(angDiff(x, mu) ** 2) / (2 * sig * sig));

/** Boundary radius of the 2D brain outline in the direction φ. */
function rBound2D(phi: number, R: number): number {
  const a = 1.0;
  const b = 0.8;
  const ellipse = 1 / Math.hypot(Math.cos(phi) / a, Math.sin(phi) / b);
  const cleft = 0.16 * gauss(phi, Math.PI / 2, 0.28); // top medial fissure -> two lobes
  const stem = 0.1 * gauss(phi, -Math.PI / 2, 0.16); // taper to the brain-stem
  const lobe = 0.035 * Math.cos(6 * phi) + 0.02 * Math.cos(10 * phi + 0.7); // gyral waviness
  return R * ellipse * (1 - cleft - stem + lobe);
}

/** Boundary radius of the 3D brain volume along the unit direction u. */
function rBound3D(x: number, y: number, z: number, R: number): number {
  const A = 1.0; // lateral (widest)
  const B = 0.78; // vertical (flattest)
  const C = 1.12; // antero-posterior (longest)
  const ellip = 1 / Math.hypot(x / A, y / B, z / C);
  const cleft = 0.18 * Math.exp(-(x * x) / (2 * 0.22 * 0.22)) * Math.max(0, Math.min(1, y / 0.4)); // sagittal groove on top
  const stem = 0.1 * Math.exp(-((x * x + z * z)) / (2 * 0.18 * 0.18)) * Math.max(0, Math.min(1, -y / 0.5)); // taper below
  const lobe = 0.035 * Math.cos(5 * Math.atan2(z, x)) + 0.025 * y * y;
  return R * ellip * (1 - cleft - stem + lobe);
}

function boundFor(p: Vector3, R: number, flat: boolean): number {
  if (flat) return rBound2D(Math.atan2(p.y, p.x), R);
  const len = p.length() || 1;
  return rBound3D(p.x / len, p.y / len, p.z / len, R);
}

/** Assign each behaviour to a hemisphere by balancing subflow subtrees. */
function assignSides(graph: BrainGraph, stemId: string | null): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const s of graph.synapses) {
    if (s.kind !== 'subflow') continue;
    if (!children.has(s.source)) children.set(s.source, []);
    children.get(s.source)!.push(s.target);
  }
  const side = new Map<string, number>();
  const sizeOf = (root: string): number => {
    // Subtree node count (subflow-reachable), guarding cycles.
    const seen = new Set<string>();
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const c of children.get(n) ?? []) if (!seen.has(c)) stack.push(c);
    }
    return seen.size;
  };
  const paint = (root: string, s: number): void => {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (side.has(n)) continue;
      side.set(n, s);
      for (const c of children.get(n) ?? []) if (!side.has(c)) stack.push(c);
    }
  };
  let left = 0;
  let right = 0;
  for (const callee of stemId ? children.get(stemId) ?? [] : []) {
    if (side.has(callee)) continue;
    const s = left <= right ? -1 : 1;
    const sz = sizeOf(callee);
    if (s < 0) left += sz;
    else right += sz;
    paint(callee, s);
  }
  // Anything not reached from the stem (islands, abilities) — deterministic split.
  graph.neurons.forEach((n, i) => {
    if (!side.has(n.id)) side.set(n.id, hash01(i * 7 + 3) < 0.5 ? -1 : 1);
  });
  return side;
}

export function computeBrainLayout(graph: BrainGraph, _grouping: Grouping, flat = false, iterations = 260): BrainLayout {
  const nodes = graph.neurons;
  const n = nodes.length;

  // Static call frequency: subflow in-degree (behaviours) and server degree
  // (abilities) — the pull toward the core.
  const inDeg = new Map<string, number>();
  const useDeg = new Map<string, number>();
  for (const s of graph.synapses) {
    if (s.kind === 'subflow') inDeg.set(s.target, (inDeg.get(s.target) ?? 0) + 1);
    // Abilities and memories both pull toward the core by how many
    // behaviours touch them.
    else if (s.kind === 'server' || s.kind === 'resource') useDeg.set(s.target, (useDeg.get(s.target) ?? 0) + 1);
  }
  let maxInLog = 1e-6;
  let maxUseLog = 1e-6;
  for (const v of inDeg.values()) maxInLog = Math.max(maxInLog, Math.log1p(v));
  for (const v of useDeg.values()) maxUseLog = Math.max(maxUseLog, Math.log1p(v));

  const stem = nodes.find(isStem) ?? null;
  const stemId = stem?.id ?? null;
  const nBeh = nodes.reduce((c, nd) => c + (nd.kind ? 0 : 1), 0);
  const R = 26 + Math.sqrt(Math.max(1, nBeh)) * 6;

  // Radius fraction s in [0,1] per neuron: 0 = dead centre, 1 = rim.
  const frac = new Map<string, number>();
  nodes.forEach((nd, i) => {
    let s: number;
    if (nd.id === stemId) {
      s = 0;
    } else if (nd.kind === 'ability' || nd.kind === 'resource') {
      const core = Math.log1p(useDeg.get(nd.id) ?? 0) / maxUseLog;
      s = ABILITY_BIAS + (1 - core) * (1 - ABILITY_BIAS);
    } else {
      const core = Math.log1p(inDeg.get(nd.id) ?? 0) / maxInLog;
      s = Math.min(1, Math.max(S_INNER, Math.pow(1 - core, P)));
    }
    // Deterministic radial jitter so equal-frequency nodes don't ring up.
    frac.set(nd.id, s * (0.88 + 0.24 * hash01(i * 2 + 1)));
  });

  const side = assignSides(graph, stemId);

  const pos = new Map<string, Vector3>();
  const vel = new Map<string, Vector3>();
  // Seed each neuron along a golden-angle direction at its target radius.
  nodes.forEach((nd, i) => {
    const s = frac.get(nd.id)!;
    let dir: Vector3;
    if (flat) {
      const a = i * GOLDEN_ANGLE;
      dir = new Vector3(Math.cos(a), Math.sin(a), 0);
    } else {
      const y = 1 - 2 * (i + 0.5) / n;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = i * GOLDEN_ANGLE;
      dir = new Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
    }
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const rad = s * boundFor(dir, R, flat);
    pos.set(nd.id, dir.multiplyScalar(rad));
    vel.set(nd.id, new Vector3());
  });
  if (stemId) pos.get(stemId)!.set(0, 0, 0);

  const springK = (kind: string): number => (kind === 'subflow' ? 0.025 : kind === 'server' ? 0.004 : 0);
  const tmp = new Vector3();

  for (let iter = 0; iter < iterations; iter++) {
    const cool = 1 - iter / iterations;

    // Global repulsion — no galaxies, the whole brain spreads.
    for (let i = 0; i < n; i++) {
      const a = pos.get(nodes[i].id)!;
      const va = vel.get(nodes[i].id)!;
      for (let j = i + 1; j < n; j++) {
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

    // Synapse springs shape ANGLE (families fan into a shared bearing), not
    // radius — the radial pull below owns distance-from-stem.
    for (const s of graph.synapses) {
      const k = springK(s.kind);
      if (k === 0) continue;
      const a = pos.get(s.source);
      const b = pos.get(s.target);
      if (!a || !b) continue;
      const rest = s.kind === 'subflow' ? 6 : 9;
      tmp.copy(b).sub(a);
      const dist = tmp.length() || 0.001;
      const force = (dist - rest) * k * Math.min(s.weight, 3);
      tmp.normalize().multiplyScalar(force);
      vel.get(s.source)!.add(tmp);
      vel.get(s.target)!.sub(tmp);
    }

    for (const nd of nodes) {
      if (nd.id === stemId) continue;
      const p = pos.get(nd.id)!;
      const v = vel.get(nd.id)!;
      const rb = boundFor(p, R, flat);
      const rho = p.length() || 0.001;

      // Radial pull toward the in-degree target radius (dominant term).
      tmp.copy(p).multiplyScalar((frac.get(nd.id)! * rb - rho) * K_RADIAL / rho);
      v.add(tmp);

      // Soft midline bias — separate hemispheres without a hard cut, so core
      // nodes still straddle x≈0 (a corpus-callosum-like crossing).
      const sd = side.get(nd.id) ?? 1;
      const targetX = sd * MIN_GAP * rb;
      if (Math.sign(p.x) !== sd || Math.abs(p.x) < Math.abs(targetX)) v.x += (targetX - p.x) * K_SIDE;

      v.multiplyScalar(DAMPING);
      if (v.length() > MAX_STEP) v.setLength(MAX_STEP);
      p.addScaledVector(v, cool);
      if (flat) {
        p.z = 0;
        v.z = 0;
      }
      // Confine within the silhouette.
      const bound = boundFor(p, R, flat);
      if (p.length() > bound) p.setLength(bound);
    }
  }

  // Safety recentre: pin the stem (or the centroid) at the origin.
  const origin = (stemId && pos.get(stemId)) || (() => {
    const c = new Vector3();
    for (const p of pos.values()) c.add(p);
    return c.multiplyScalar(1 / Math.max(n, 1));
  })();
  const shift = origin.clone();
  for (const p of pos.values()) p.sub(shift);

  return { positions: pos };
}
