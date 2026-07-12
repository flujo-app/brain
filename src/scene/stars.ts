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
import type { BrainGraph, Neuron } from '../types';
import type { Grouping } from '../grouping';
import type { SectionedLayout } from '../layout/sectionedLayout';
import { glowTexture } from './textures';

export function neuronRadius(n: Neuron): number {
  return 0.9 + Math.sqrt(n.nodeTotal) * 0.55;
}

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aPhase;
  attribute vec3 aColor;
  uniform float uScale;
  uniform float uTime;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    // Gentle twinkle so the brain feels alive.
    vAlpha = aAlpha * (0.82 + 0.18 * sin(uTime * 1.3 + aPhase));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uTex;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 t = texture2D(uTex, gl_PointCoord);
    float a = t.a * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * (0.5 + t.r), a);
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
  /** neuronId -> (innerNodeId -> world position), for the focus wiring overlay. */
  readonly innerWorld = new Map<string, Map<string, Vector3>>();
  private coreAlpha: Float32BufferAttribute;
  private satAlpha: Float32BufferAttribute;
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
      const color = (colorOf.get(neuron.id) ?? new Color(0x9aa6c8)).clone();
      const radius = neuronRadius(neuron);
      const base = neuron.broken ? 0.4 : 0.95;

      this.coreMeta.push({ neuron, color, base });
      this.indexById.set(neuron.id, ci);

      cPos.push(p.x, p.y, p.z);
      cCol.push(color.r, color.g, color.b);
      cSize.push(radius * 2.1);
      cAlpha.push(base);
      cPhase.push((ci * 12.9898) % 6.28);

      // Satellites: the flow's internal nodes, scattered tightly around the core.
      const spread = radius * 1.7 + 1.2;
      const inner = new Map<string, Vector3>();
      this.innerWorld.set(neuron.id, inner);
      neuron.inner.nodes.forEach((node, k) => {
        const jz = (((ci * 7 + k) * 2654435761) % 1000) / 1000 - 0.5;
        const sp = new Vector3(p.x + node.x * spread, p.y + node.y * spread, p.z + jz * spread);
        inner.set(node.id, sp);
        const shade = 0.55 + (((ci + k) * 40503) % 100) / 100 * 0.4;
        sPos.push(sp.x, sp.y, sp.z);
        // MCP nodes whose server is down/disabled break from the galaxy hue.
        const status = node.type === 'mcp' && node.server ? graph.servers[node.server] : undefined;
        if (status === 'disconnected') sCol.push(1.0 * shade, 0.36 * shade, 0.54 * shade);
        else if (status === 'disabled') sCol.push(0.33 * shade, 0.38 * shade, 0.5 * shade);
        else sCol.push(color.r * shade, color.g * shade, color.b * shade);
        sSize.push(0.42 + shade * 0.5);
        sAlpha.push(0.7);
        sPhase.push(((ci * 31 + k * 17) % 628) / 100);
        this.satOwner.push(ci);
        this.satBase.push(0.7);
      });
    });

    this.material = new ShaderMaterial({
      uniforms: {
        uTex: { value: glowTexture() },
        uScale: { value: 600 },
        uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.cores = this.buildPoints(cPos, cCol, cSize, cAlpha, cPhase);
    this.coreAlpha = this.cores.geometry.getAttribute('aAlpha') as Float32BufferAttribute;
    this.satellites = this.buildPoints(sPos, sCol, sSize, sAlpha, sPhase);
    this.satAlpha = this.satellites.geometry.getAttribute('aAlpha') as Float32BufferAttribute;
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

  /**
   * Spotlight a subset. `visible === null` -> resting glow. Satellites follow
   * their owning neuron.
   */
  spotlight(visible: Set<string> | null, focusId: string | null): void {
    const ca = this.coreAlpha.array as Float32Array;
    this.coreMeta.forEach((m, i) => {
      if (!visible) ca[i] = m.base;
      else if (m.neuron.id === focusId) ca[i] = Math.min(m.base * 1.5, 1.4);
      else if (visible.has(m.neuron.id)) ca[i] = m.base;
      else ca[i] = 0.1;
    });
    this.coreAlpha.needsUpdate = true;

    const sa = this.satAlpha.array as Float32Array;
    for (let i = 0; i < this.satOwner.length; i++) {
      const owner = this.coreMeta[this.satOwner[i]];
      const base = this.satBase[i];
      if (!visible) sa[i] = base;
      else if (owner.neuron.id === focusId) sa[i] = Math.min(base * 1.3, 1);
      else if (visible.has(owner.neuron.id)) sa[i] = base;
      else sa[i] = 0.05;
    }
    this.satAlpha.needsUpdate = true;
  }
}
