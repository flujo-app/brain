import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { BrainGraph, Synapse, SynapseKind } from '../types';
import { SYNAPSE_COLORS } from '../theme';
import { glowTexture } from './textures';
import { linkKey, linkWidthMul } from './heat';

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
}

export interface FlashOpts {
  /** Override the flash tint (e.g. red for an errored tool result). */
  color?: number | Color;
  /** Exponential decay rate; lower lives longer. Default 1.6 (≈3 s visible). */
  decay?: number;
}

const DEFAULT_FLASH_DECAY = 1.6;
/** Sustained-hold brightness: bright enough to read as "active", below a fresh flash. */
const HOLD_LEVEL = 0.6;

/**
 * All synapses as one fat-line draw plus a pulse layer.
 *
 * Lines use three's Line2 family (LineSegments2/LineMaterial) rather than the
 * built-in LineSegments, because WebGL ignores LineBasicMaterial.linewidth —
 * genuine per-link thickness (driven by the usage heatmap) is only possible
 * with the screen-space fat-line shader. Width is injected per segment via a
 * small onBeforeCompile patch (see buildMaterial).
 */
export class SynapseField {
  readonly lines: LineSegments2;
  readonly pulses: Points;
  readonly edges: Edge[] = [];
  private material: LineMaterial;
  /** Backing store for instanceColorStart/End (6 floats per segment). */
  private colorArray: Float32Array;
  private colorAttr: { needsUpdate: boolean };
  /** Per-segment width multiplier (heat + flash). */
  private widthArray: Float32Array;
  private widthAttr: InstancedBufferAttribute;
  private pulseColors: Float32BufferAttribute;
  private pulsePos: Float32BufferAttribute;
  readonly adjacency = new Map<string, Set<number>>();

  /** Execution flash per edge (decays each frame). */
  private boosts!: Float32Array;
  /** Per-edge flash decay rate (set by the flash that lit it). */
  private flashDecay!: Float32Array;
  /** Sustained-hold refcount per edge (a subagent running); pulses until released. */
  private holds!: Float32Array;
  /** Flash travel direction: 1 = along the synapse, -1 = reversed. */
  private flashDir!: Float32Array;
  /** Per-flash tint override; null = the edge's resting colour. */
  private flashColor: (Color | null)[] = [];
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

    graph.synapses.forEach((s) => {
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

      this.edges.push({ synapse: s, points, profile, color });

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

    const segCount = this.edges.length * SEG;

    const lineGeo = new LineSegmentsGeometry();
    lineGeo.setPositions(linePos);
    this.colorArray = new Float32Array(segCount * 6);
    lineGeo.setColors(this.colorArray);
    // Colours are rewritten every frame a flash decays — mark the shared
    // interleaved buffer dynamic and keep a handle to flag it dirty.
    const colorStart = lineGeo.getAttribute('instanceColorStart') as unknown as {
      needsUpdate: boolean;
      data: { setUsage: (u: number) => void };
    };
    colorStart.data.setUsage(DynamicDrawUsage);
    this.colorAttr = colorStart;

    // Per-segment width multiplier (one LineSegments2 instance == one segment).
    this.widthArray = new Float32Array(segCount).fill(1);
    this.widthAttr = new InstancedBufferAttribute(this.widthArray, 1);
    this.widthAttr.setUsage(DynamicDrawUsage);
    lineGeo.setAttribute('instanceWidth', this.widthAttr);
    lineGeo.computeBoundingSphere();

    this.material = this.buildMaterial();
    this.lines = new LineSegments2(lineGeo, this.material);
    this.lines.computeLineDistances();
    // The brain is always on screen; skip per-frame culling of the one big mesh.
    this.lines.frustumCulled = false;

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

    this.boosts = new Float32Array(this.edges.length);
    this.flashDecay = new Float32Array(this.edges.length).fill(DEFAULT_FLASH_DECAY);
    this.holds = new Float32Array(this.edges.length);
    this.flashDir = new Float32Array(this.edges.length);
    this.flashColor = new Array(this.edges.length).fill(null);
    // Bake the accumulated usage heatmap into resting link widths.
    for (let i = 0; i < this.edges.length; i++) this.applyWidth(i);
  }

  private buildMaterial(): LineMaterial {
    const mat = new LineMaterial({
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      linewidth: 2.4, // base device-pixel width; heat scales it per segment
    });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    // Inject a per-segment width multiplier. `instanceWidth` rides along the
    // same instancing as instanceStart/End, so one value covers a whole
    // segment. Patch both the screen-space (default) and world-units paths.
    mat.onBeforeCompile = (shader) => {
      const before = shader.vertexShader;
      shader.vertexShader = shader.vertexShader
        .replace('attribute vec3 instanceStart;', 'attribute vec3 instanceStart;\n\t\tattribute float instanceWidth;')
        .replace('offset *= linewidth;', 'offset *= linewidth * instanceWidth;')
        .replace('float hw = linewidth * 0.5;', 'float hw = linewidth * 0.5 * instanceWidth;');
      if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV && shader.vertexShader === before) {
        // The stock LineMaterial shader changed — width injection is a no-op.
        console.error('[synapses] fat-line width patch did not apply; check three.js version');
      }
    };
    mat.customProgramCacheKey = () => 'synapse-fatline-v1';
    return mat;
  }

  /** Keep fat-line widths correct in screen space; call on every resize. */
  setResolution(width: number, height: number): void {
    this.material.resolution.set(width, height);
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

  /** Write one segment-block of line + this edge's pulse colours at intensity `m`. */
  private writeEdge(i: number, m: number): void {
    const lc = this.colorArray;
    const pc = this.pulseColors.array as Float32Array;
    const e = this.edges[i];
    // A live flash can retint the boosted contribution (e.g. red on error).
    const flashing = this.boosts[i] > 0.01 && this.flashColor[i] ? this.flashColor[i]! : e.color;
    const boost = this.boosts[i] * 1.2;
    const base = i * SEG * 6;
    for (let j = 0; j < SEG; j++) {
      // Blend resting colour (m) with the flash tint (boost) per endpoint.
      const iA = m * e.profile[j];
      const iB = m * e.profile[j + 1];
      const o = base + j * 6;
      lc[o] = e.color.r * iA + flashing.r * boost;
      lc[o + 1] = e.color.g * iA + flashing.g * boost;
      lc[o + 2] = e.color.b * iA + flashing.b * boost;
      lc[o + 3] = e.color.r * iB + flashing.r * boost;
      lc[o + 4] = e.color.g * iB + flashing.g * boost;
      lc[o + 5] = e.color.b * iB + flashing.b * boost;
    }
    // Pulses are interaction-only: they light up with an execution flash
    // (subflow handoff, tool call, tool result) and vanish with it.
    const pm = this.boosts[i] * 2.0;
    pc[i * 3] = flashing.r * pm; pc[i * 3 + 1] = flashing.g * pm; pc[i * 3 + 2] = flashing.b * pm;
  }

  /** Set an edge's segment widths from its accumulated heat. */
  private applyWidth(i: number): void {
    const e = this.edges[i];
    const w = linkWidthMul(linkKey(e.synapse.source, e.synapse.target, e.synapse.kind));
    const base = i * SEG;
    for (let j = 0; j < SEG; j++) this.widthArray[base + j] = w;
    this.widthAttr.needsUpdate = true;
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
    for (let i = 0; i < this.edges.length; i++) this.writeEdge(i, this.restingM(i));
    this.colorAttr.needsUpdate = true;
    this.pulseColors.needsUpdate = true;
  }

  private edgeIndex(fromId: string, toId: string): number {
    return this.edges.findIndex(
      (e) =>
        (e.synapse.source === fromId && e.synapse.target === toId) ||
        (e.synapse.source === toId && e.synapse.target === fromId),
    );
  }

  /**
   * Flash the synapse between two neurons; the pulse travels from -> to.
   * `opts.color` overrides the tint (e.g. red for an errored tool result).
   */
  flash(fromId: string, toId: string, opts: FlashOpts = {}): void {
    const i = this.edgeIndex(fromId, toId);
    if (i < 0) return;
    this.boosts[i] = 1;
    this.flashDecay[i] = opts.decay ?? DEFAULT_FLASH_DECAY;
    // The pulse travels from the acting end toward the other.
    this.flashDir[i] = this.edges[i].synapse.source === fromId ? 1 : -1;
    this.flashColor[i] = opts.color != null ? new Color(opts.color) : null;
    // Fresh traffic may have just bumped this link's heat — refresh its width.
    this.applyWidth(i);
  }

  /**
   * Hold the synapse lit (a subagent is running): the launch flash decays into
   * a breathing glow with a pulse looping from -> to until release(). Refcounted
   * — parallel lanes over the same link stack.
   */
  hold(fromId: string, toId: string): void {
    const i = this.edgeIndex(fromId, toId);
    if (i < 0) return;
    this.holds[i]++;
    this.boosts[i] = 1;
    this.flashDecay[i] = DEFAULT_FLASH_DECAY;
    this.flashDir[i] = this.edges[i].synapse.source === fromId ? 1 : -1;
    this.flashColor[i] = null;
    this.applyWidth(i);
  }

  /** Release one hold on the synapse; its glow decays out naturally. */
  release(fromId: string, toId: string): void {
    const i = this.edgeIndex(fromId, toId);
    if (i >= 0) this.holds[i] = Math.max(0, this.holds[i] - 1);
  }

  /** Decay execution flashes and move their pulses. Cheap; call every frame. */
  animate(time: number): void {
    const dt = Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    if (!this.boosts) return;

    // Each flash decays while its pulse launches from the acting end and
    // eases toward the other; when the flash dies the pulse goes with it.
    const pp = this.pulsePos.array as Float32Array;
    let touched = false;
    for (let i = 0; i < this.boosts.length; i++) {
      const held = this.holds[i] > 0;
      if (!held && this.boosts[i] <= 0.01) continue;
      if (held) {
        // The launch flash decays into a breathing floor until released.
        this.boosts[i] = Math.max(
          this.boosts[i] * Math.exp(-dt * this.flashDecay[i]),
          HOLD_LEVEL + 0.12 * Math.sin(time * 3),
        );
      } else {
        this.boosts[i] *= Math.exp(-dt * this.flashDecay[i]);
        if (this.boosts[i] <= 0.01) {
          this.boosts[i] = 0;
          this.flashColor[i] = null;
        }
      }
      this.writeEdge(i, this.restingM(i));

      // Held: the pulse loops continuously toward the subagent; otherwise it
      // rides the decaying flash across once.
      const along = held ? (time * 0.45) % 1 : 1 - this.boosts[i];
      const f = this.flashDir[i] >= 0 ? along : 1 - along;
      const x = f * SEG;
      const j = Math.min(SEG - 1, Math.floor(x));
      const t = x - j;
      const p = this.edges[i].points;
      pp[i * 3] = p[j * 3] + (p[(j + 1) * 3] - p[j * 3]) * t;
      pp[i * 3 + 1] = p[j * 3 + 1] + (p[(j + 1) * 3 + 1] - p[j * 3 + 1]) * t;
      pp[i * 3 + 2] = p[j * 3 + 2] + (p[(j + 1) * 3 + 2] - p[j * 3 + 2]) * t;
      touched = true;
    }
    if (touched) {
      this.colorAttr.needsUpdate = true;
      this.pulseColors.needsUpdate = true;
      this.pulsePos.needsUpdate = true;
    }
  }
}
