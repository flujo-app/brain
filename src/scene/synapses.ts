import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import type { BrainGraph, Synapse, SynapseKind } from '../types';
import { SYNAPSE_COLORS } from '../theme';
import { glowTexture } from './textures';

/** Curve segments per synapse — enough for a smooth arc, cheap to draw. */
const SEG = 22;

const UP = new Vector3(0, 0, 1);

interface Edge {
  synapse: Synapse;
  /** Sampled bezier, (SEG+1) points * xyz. */
  points: Float32Array;
  /** Per-point intensity: long edges fade toward their middle. */
  profile: Float32Array;
  color: Color;
  speed: number;
  phase: number;
}

export class SynapseField {
  readonly lines: LineSegments;
  readonly pulses: Points;
  readonly edges: Edge[] = [];
  private lineColors: Float32BufferAttribute;
  private pulseColors: Float32BufferAttribute;
  private pulsePos: Float32BufferAttribute;
  readonly adjacency = new Map<string, Set<number>>();

  /** Execution flash per edge (decays each frame). */
  private boosts!: Float32Array;
  private lastTime = 0;
  // Last recolor() inputs, so flashes can re-derive an edge's resting colour.
  private lastActive: Set<number> | null = null;
  private lastKinds = new Set<SynapseKind>();
  private lastFocus = false;

  constructor(graph: BrainGraph, positions: Map<string, Vector3>) {
    const linePos: number[] = [];
    const pulseP: number[] = [];
    const mid = new Vector3();
    const out = new Vector3();
    const ctrl = new Vector3();
    const pt = new Vector3();

    graph.synapses.forEach((s, i) => {
      const a = positions.get(s.source);
      const b = positions.get(s.target);
      if (!a || !b) return;
      const color = new Color(SYNAPSE_COLORS[s.kind]);
      const len = a.distanceTo(b);

      // Quadratic bezier bowing away from the brain centre, so hub-heavy
      // wiring arcs around the core instead of slicing straight through it.
      // (In the flat 2D layout the outward direction stays in-plane.)
      mid.copy(a).add(b).multiplyScalar(0.5);
      out.copy(mid);
      if (out.lengthSq() < 4) out.copy(b).sub(a).cross(UP);
      if (out.lengthSq() < 0.01) out.set(0, 1, 0);
      out.normalize();
      ctrl.copy(mid).addScaledVector(out, 1.5 + len * 0.16);

      const points = new Float32Array((SEG + 1) * 3);
      const profile = new Float32Array(SEG + 1);
      // Long edges fade toward the middle so distant ties read as faint
      // filaments; short intra-galaxy links stay solid.
      const fade = Math.min(0.85, Math.max(0, (len - 8) / 50));
      for (let j = 0; j <= SEG; j++) {
        const t = j / SEG;
        const u = 1 - t;
        pt.set(
          u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x,
          u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y,
          u * u * a.z + 2 * u * t * ctrl.z + t * t * b.z,
        );
        points[j * 3] = pt.x;
        points[j * 3 + 1] = pt.y;
        points[j * 3 + 2] = pt.z;
        profile[j] = 1 - fade * Math.pow(Math.sin(Math.PI * t), 1.4);
      }

      this.edges.push({
        synapse: s,
        points,
        profile,
        color,
        speed: 0.12 + ((i * 2654435761) % 1000) / 1000 * 0.35 + (s.kind === 'subflow' ? 0.2 : 0),
        phase: ((i * 40503) % 1000) / 1000,
      });

      for (let j = 0; j < SEG; j++) {
        linePos.push(
          points[j * 3], points[j * 3 + 1], points[j * 3 + 2],
          points[(j + 1) * 3], points[(j + 1) * 3 + 1], points[(j + 1) * 3 + 2],
        );
      }
      pulseP.push(a.x, a.y, a.z);

      for (const id of [s.source, s.target]) {
        if (!this.adjacency.has(id)) this.adjacency.set(id, new Set());
        this.adjacency.get(id)!.add(this.edges.length - 1);
      }
    });

    const lineGeo = new BufferGeometry();
    lineGeo.setAttribute('position', new Float32BufferAttribute(linePos, 3));
    this.lineColors = new Float32BufferAttribute(new Float32Array(this.edges.length * SEG * 6), 3);
    this.lineColors.setUsage(DynamicDrawUsage);
    lineGeo.setAttribute('color', this.lineColors);
    this.lines = new LineSegments(
      lineGeo,
      new LineBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, opacity: 0.8, depthWrite: false }),
    );

    const pulseGeo = new BufferGeometry();
    this.pulsePos = new Float32BufferAttribute(new Float32Array(pulseP), 3);
    this.pulsePos.setUsage(DynamicDrawUsage);
    pulseGeo.setAttribute('position', this.pulsePos);
    this.pulseColors = new Float32BufferAttribute(new Float32Array(this.edges.length * 3), 3);
    this.pulseColors.setUsage(DynamicDrawUsage);
    pulseGeo.setAttribute('color', this.pulseColors);
    this.pulses = new Points(
      pulseGeo,
      new PointsMaterial({
        size: 1.6,
        map: glowTexture(),
        vertexColors: true,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
  }

  private baseDim(e: Edge, kinds: Set<SynapseKind>): number {
    if (!kinds.has(e.synapse.kind)) return 0;
    return e.synapse.kind === 'subflow' ? 0.9 : e.synapse.kind === 'server' ? 0.38 : 0.2;
  }

  /** The edge's resting intensity under the last recolor() inputs. */
  private restingM(i: number): number {
    const e = this.edges[i];
    let m = this.baseDim(e, this.lastKinds);
    if (this.lastActive) m *= this.lastActive.has(i) ? (this.lastFocus ? 0.45 : 1.8) : (this.lastFocus ? 0.012 : 0.05);
    return m;
  }

  /** Write one edge's line + pulse colours at intensity `m`. */
  private writeEdge(i: number, m: number): void {
    const lc = this.lineColors.array as Float32Array;
    const pc = this.pulseColors.array as Float32Array;
    const e = this.edges[i];
    const base = i * SEG * 6;
    for (let j = 0; j < SEG; j++) {
      const iA = m * e.profile[j];
      const iB = m * e.profile[j + 1];
      const o = base + j * 6;
      lc[o] = e.color.r * iA; lc[o + 1] = e.color.g * iA; lc[o + 2] = e.color.b * iA;
      lc[o + 3] = e.color.r * iB; lc[o + 4] = e.color.g * iB; lc[o + 5] = e.color.b * iB;
    }
    const pm = m * 1.6;
    pc[i * 3] = e.color.r * pm; pc[i * 3 + 1] = e.color.g * pm; pc[i * 3 + 2] = e.color.b * pm;
  }

  /**
   * Recolour lines and pulses. Call only when focus / hover / kinds change.
   * `focusMode` = a behaviour's flow graph is open: the whole web recedes so
   * the focused graph owns the screen.
   */
  recolor(active: Set<number> | null, kinds: Set<SynapseKind>, focusMode = false): void {
    this.lastActive = active;
    this.lastKinds = kinds;
    this.lastFocus = focusMode;
    if (!this.boosts || this.boosts.length !== this.edges.length) this.boosts = new Float32Array(this.edges.length);
    for (let i = 0; i < this.edges.length; i++) this.writeEdge(i, this.restingM(i) + this.boosts[i] * 1.2);
    this.lineColors.needsUpdate = true;
    this.pulseColors.needsUpdate = true;
  }

  /** Flash the subflow axon source -> target (a live behaviour call). */
  flash(sourceId: string, targetId: string): void {
    const i = this.edges.findIndex(
      (e) => e.synapse.kind === 'subflow' && e.synapse.source === sourceId && e.synapse.target === targetId,
    );
    if (i < 0) return;
    if (!this.boosts || this.boosts.length !== this.edges.length) this.boosts = new Float32Array(this.edges.length);
    this.boosts[i] = 1;
  }

  /** Advance travelling signal positions along the curve. Cheap; call every frame. */
  animate(time: number): void {
    const dt = Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;

    // Decay execution flashes and rewrite just the affected edges.
    if (this.boosts) {
      let touched = false;
      for (let i = 0; i < this.boosts.length; i++) {
        if (this.boosts[i] <= 0.01) continue;
        this.boosts[i] *= Math.exp(-dt * 1.6);
        if (this.boosts[i] <= 0.01) this.boosts[i] = 0;
        this.writeEdge(i, this.restingM(i) + this.boosts[i] * 1.2);
        touched = true;
      }
      if (touched) {
        this.lineColors.needsUpdate = true;
        this.pulseColors.needsUpdate = true;
      }
    }

    const pp = this.pulsePos.array as Float32Array;
    this.edges.forEach((e, i) => {
      let f = (time * e.speed + e.phase) % 1;
      if (!e.synapse.directed) f = f < 0.5 ? f * 2 : (1 - f) * 2;
      const x = f * SEG;
      const j = Math.min(SEG - 1, Math.floor(x));
      const t = x - j;
      const p = e.points;
      pp[i * 3] = p[j * 3] + (p[(j + 1) * 3] - p[j * 3]) * t;
      pp[i * 3 + 1] = p[j * 3 + 1] + (p[(j + 1) * 3 + 1] - p[j * 3 + 1]) * t;
      pp[i * 3 + 2] = p[j * 3 + 2] + (p[(j + 1) * 3 + 2] - p[j * 3 + 2]) * t;
    });
    this.pulsePos.needsUpdate = true;
  }
}
