import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { BrainGraph, Neuron, ServerStatus } from '../types';
import type { Grouping } from '../grouping';
import type { SectionedLayout } from '../layout/sectionedLayout';
import { glowTexture } from './textures';

export function neuronRadius(n: Neuron): number {
  if (n.kind === 'ability') return 1.15;
  return 0.9 + Math.sqrt(n.nodeTotal) * 0.55;
}

/** Ability stars break from their group hue when the server isn't healthy. */
export function abilityTint(status: ServerStatus | undefined): number | null {
  if (status === 'disconnected') return 0xff5c8a;
  if (status === 'disabled') return 0x556080;
  if (status === 'unknown' || status === undefined) return 0x9aa6c8;
  return null; // connected — keep the abilities-section hue
}

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aPhase;
  attribute float aBoost;
  attribute vec3 aColor;
  uniform float uScale;
  uniform float uTime;
  uniform float uFogDensity;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFog;
  void main() {
    // Execution wake glow: boosted stars brighten toward white and swell.
    vColor = mix(aColor, vec3(1.0), aBoost * 0.3);
    // Gentle twinkle so the brain feels alive.
    vAlpha = (aAlpha + aBoost * 0.9) * (0.82 + 0.18 * sin(uTime * 1.3 + aPhase));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Exp2 depth fade: the brain's far side recedes instead of stacking flat.
    float fd = -mv.z * uFogDensity;
    vFog = exp(-fd * fd);
    gl_PointSize = aSize * (1.0 + aBoost * 0.35) * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uTex;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFog;
  void main() {
    vec4 t = texture2D(uTex, gl_PointCoord);
    float a = t.a * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * (0.5 + t.r) * vFog, a);
  }
`;

interface CoreMeta {
  neuron: Neuron;
  color: Color;
  base: number; // resting alpha
}

/** All neuron cores + their internal-node satellites in two Points draw calls. */
export class StarField {
  readonly cores: Points;
  readonly satellites: Points;
  private material: ShaderMaterial;
  private coreMeta: CoreMeta[] = [];
  readonly indexById = new Map<string, number>();
  private coreAlpha: Float32BufferAttribute;
  private satAlpha: Float32BufferAttribute;
  private coreBoost: Float32BufferAttribute;
  private satBoost: Float32BufferAttribute;
  private satOwner: number[] = []; // satellite -> core index
  private satBase: number[] = [];

  constructor(graph: BrainGraph, grouping: Grouping, layout: SectionedLayout) {
    const colorOf = new Map<string, Color>();
    for (const g of grouping.groups) for (const id of g.neuronIds) colorOf.set(id, g.color);

    const cPos: number[] = [];
    const cCol: number[] = [];
    const cSize: number[] = [];
    const cAlpha: number[] = [];
    const cPhase: number[] = [];

    const sPos: number[] = [];
    const sCol: number[] = [];
    const sSize: number[] = [];
    const sAlpha: number[] = [];
    const sPhase: number[] = [];

    graph.neurons.forEach((neuron, ci) => {
      const p = layout.positions.get(neuron.id) ?? new Vector3();
      let color = (colorOf.get(neuron.id) ?? new Color(0x9aa6c8)).clone();
      const radius = neuronRadius(neuron);
      let base = neuron.broken ? 0.4 : 0.95;
      if (neuron.kind === 'ability') {
        const status = graph.servers[neuron.name];
        const tint = abilityTint(status);
        if (tint !== null) color = new Color(tint);
        if (status === 'disabled') base = 0.45;
      }

      this.coreMeta.push({ neuron, color, base });
      this.indexById.set(neuron.id, ci);

      cPos.push(p.x, p.y, p.z);
      cCol.push(color.r, color.g, color.b);
      cSize.push(radius * 2.1);
      cAlpha.push(base);
      cPhase.push((ci * 12.9898) % 6.28);

      // Satellites: the behaviour's internal nodes, scattered tightly around
      // the core. Kept subtle — the focused view renders the real graph.
      const spread = radius * 1.7 + 1.2;
      neuron.inner.nodes.forEach((node, k) => {
        const jz = (((ci * 7 + k) * 2654435761) % 1000) / 1000 - 0.5;
        const sp = new Vector3(p.x + node.x * spread, p.y + node.y * spread, p.z + jz * spread);
        const shade = 0.55 + (((ci + k) * 40503) % 100) / 100 * 0.4;
        sPos.push(sp.x, sp.y, sp.z);
        // Ability nodes whose server is down/disabled break from the galaxy hue.
        const status = node.type === 'mcp' && node.server ? graph.servers[node.server] : undefined;
        if (status === 'disconnected') sCol.push(1.0 * shade, 0.36 * shade, 0.54 * shade);
        else if (status === 'disabled') sCol.push(0.33 * shade, 0.38 * shade, 0.5 * shade);
        else sCol.push(color.r * shade, color.g * shade, color.b * shade);
        sSize.push(0.34 + shade * 0.4);
        sAlpha.push(0.55);
        sPhase.push(((ci * 31 + k * 17) % 628) / 100);
        this.satOwner.push(ci);
        this.satBase.push(0.55);
      });
    });

    this.material = new ShaderMaterial({
      uniforms: {
        uTex: { value: glowTexture() },
        uScale: { value: 600 },
        uTime: { value: 0 },
        uFogDensity: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.cores = this.buildPoints(cPos, cCol, cSize, cAlpha, cPhase);
    this.coreAlpha = this.cores.geometry.getAttribute('aAlpha') as Float32BufferAttribute;
    this.coreBoost = this.cores.geometry.getAttribute('aBoost') as Float32BufferAttribute;
    this.satellites = this.buildPoints(sPos, sCol, sSize, sAlpha, sPhase);
    this.satAlpha = this.satellites.geometry.getAttribute('aAlpha') as Float32BufferAttribute;
    this.satBoost = this.satellites.geometry.getAttribute('aBoost') as Float32BufferAttribute;
    this.satellites.renderOrder = -0.5;
  }

  private buildPoints(pos: number[], col: number[], size: number[], alpha: number[], phase: number[]): Points {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new Float32BufferAttribute(col, 3));
    geo.setAttribute('aSize', new Float32BufferAttribute(size, 1));
    const a = new Float32BufferAttribute(alpha, 1);
    a.setUsage(DynamicDrawUsage);
    geo.setAttribute('aAlpha', a);
    geo.setAttribute('aPhase', new Float32BufferAttribute(phase, 1));
    const boost = new Float32BufferAttribute(new Float32Array(alpha.length), 1);
    boost.setUsage(DynamicDrawUsage);
    geo.setAttribute('aBoost', boost);
    return new Points(geo, this.material);
  }

  neuronAt(index: number): Neuron | null {
    return this.coreMeta[index]?.neuron ?? null;
  }

  setScale(heightPx: number, fovDeg: number): void {
    this.material.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  setTime(t: number): void {
    this.material.uniforms.uTime.value = t;
  }

  setFog(density: number): void {
    this.material.uniforms.uFogDensity.value = density;
  }

  /** Execution wake glow per behaviour (0..1); satellites follow their core. */
  setBoost(levels: ReadonlyMap<string, number>): void {
    const cb = this.coreBoost.array as Float32Array;
    this.coreMeta.forEach((m, i) => {
      cb[i] = levels.get(m.neuron.id) ?? 0;
    });
    this.coreBoost.needsUpdate = true;
    const sb = this.satBoost.array as Float32Array;
    for (let i = 0; i < this.satOwner.length; i++) {
      sb[i] = (levels.get(this.coreMeta[this.satOwner[i]].neuron.id) ?? 0) * 0.7;
    }
    this.satBoost.needsUpdate = true;
  }

  /**
   * Spotlight a subset. `visible === null` -> resting glow. Satellites follow
   * their owning neuron. `hideFocused` blanks the focused star entirely so the
   * flow-graph view can take its place without glow bleeding through.
   */
  spotlight(visible: Set<string> | null, focusId: string | null, hideFocused = false): void {
    const ca = this.coreAlpha.array as Float32Array;
    this.coreMeta.forEach((m, i) => {
      if (m.neuron.id === focusId) ca[i] = hideFocused ? 0 : Math.min(m.base * 1.5, 1.4);
      else if (!visible) ca[i] = m.base;
      else if (visible.has(m.neuron.id)) ca[i] = hideFocused ? m.base * 0.3 : m.base;
      else ca[i] = hideFocused ? 0.02 : 0.08;
    });
    this.coreAlpha.needsUpdate = true;

    const sa = this.satAlpha.array as Float32Array;
    for (let i = 0; i < this.satOwner.length; i++) {
      const owner = this.coreMeta[this.satOwner[i]];
      const base = this.satBase[i];
      if (owner.neuron.id === focusId) sa[i] = hideFocused ? 0 : Math.min(base * 1.3, 1);
      else if (!visible) sa[i] = base;
      else if (visible.has(owner.neuron.id)) sa[i] = hideFocused ? base * 0.18 : base;
      else sa[i] = hideFocused ? 0.01 : 0.04;
    }
    this.satAlpha.needsUpdate = true;
  }
}
