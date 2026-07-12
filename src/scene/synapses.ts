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

interface Edge {
  synapse: Synapse;
  a: Vector3;
  b: Vector3;
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

  constructor(graph: BrainGraph, positions: Map<string, Vector3>) {
    const linePos: number[] = [];
    const pulseP: number[] = [];

    graph.synapses.forEach((s, i) => {
      const a = positions.get(s.source);
      const b = positions.get(s.target);
      if (!a || !b) return;
      const color = new Color(SYNAPSE_COLORS[s.kind]);
      this.edges.push({
        synapse: s,
        a: a.clone(),
        b: b.clone(),
        color,
        speed: 0.12 + ((i * 2654435761) % 1000) / 1000 * 0.35 + (s.kind === 'subflow' ? 0.2 : 0),
        phase: ((i * 40503) % 1000) / 1000,
      });
      linePos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      pulseP.push(a.x, a.y, a.z);

      for (const id of [s.source, s.target]) {
        if (!this.adjacency.has(id)) this.adjacency.set(id, new Set());
        this.adjacency.get(id)!.add(this.edges.length - 1);
      }
    });

    const lineGeo = new BufferGeometry();
    lineGeo.setAttribute('position', new Float32BufferAttribute(linePos, 3));
    this.lineColors = new Float32BufferAttribute(new Float32Array(this.edges.length * 6), 3);
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
        size: 1.7,
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
    return e.synapse.kind === 'subflow' ? 0.9 : e.synapse.kind === 'server' ? 0.42 : 0.22;
  }

  /** Recolour lines and pulses. Call only when focus / hover / kinds change. */
  recolor(active: Set<number> | null, kinds: Set<SynapseKind>): void {
    const lc = this.lineColors.array as Float32Array;
    const pc = this.pulseColors.array as Float32Array;
    this.edges.forEach((e, i) => {
      let m = this.baseDim(e, kinds);
      if (active) m *= active.has(i) ? 1.8 : 0.05;
      const r = e.color.r * m;
      const g = e.color.g * m;
      const b = e.color.b * m;
      lc[i * 6] = r; lc[i * 6 + 1] = g; lc[i * 6 + 2] = b;
      lc[i * 6 + 3] = r; lc[i * 6 + 4] = g; lc[i * 6 + 5] = b;
      const pm = m * 1.6;
      pc[i * 3] = e.color.r * pm; pc[i * 3 + 1] = e.color.g * pm; pc[i * 3 + 2] = e.color.b * pm;
    });
    this.lineColors.needsUpdate = true;
    this.pulseColors.needsUpdate = true;
  }

  /** Advance travelling signal positions. Cheap; call every frame. */
  animate(time: number): void {
    const pp = this.pulsePos.array as Float32Array;
    this.edges.forEach((e, i) => {
      let f = (time * e.speed + e.phase) % 1;
      if (!e.synapse.directed) f = f < 0.5 ? f * 2 : (1 - f) * 2;
      pp[i * 3] = e.a.x + (e.b.x - e.a.x) * f;
      pp[i * 3 + 1] = e.a.y + (e.b.y - e.a.y) * f;
      pp[i * 3 + 2] = e.a.z + (e.b.z - e.a.z) * f;
    });
    this.pulsePos.needsUpdate = true;
  }
}
