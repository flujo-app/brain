import {
  AdditiveBlending,
  Color,
  Group,
  Raycaster,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import type { BrainGraph, Neuron } from '../types';
import type { Grouping } from '../grouping';
import { glowTexture } from './textures';
import { abilityTint, neuronRadius } from './neuronStyle';
import { neuronSizeMul } from './heat';

/** World-unit diameter per unit of neuron radius. */
const WORLD_SCALE = 2.3;

interface Meta {
  neuron: Neuron;
  color: Color;
  /** Resting alpha (broken/disabled dim). */
  base: number;
  /** Base world diameter before heat + boost. */
  size: number;
  sprite: Sprite;
}

/**
 * Neurons as soft additive glow sprites — one Sprite per neuron, no custom
 * GLSL. Colour comes from the provider grouping; alpha follows the spotlight;
 * a wake-glow boost swells and whitens a firing neuron; and the persistent
 * usage heatmap scales each neuron's size (fires more → grows bigger).
 */
export class NeuronField {
  readonly object = new Group();
  private meta: Meta[] = [];
  private spotAlpha: number[] = [];
  private boost: number[] = [];

  constructor(graph: BrainGraph, grouping: Grouping, layout: { positions: Map<string, Vector3> }) {
    const colorOf = new Map<string, Color>();
    for (const g of grouping.groups) for (const id of g.neuronIds) colorOf.set(id, g.color);
    const tex = glowTexture();

    graph.neurons.forEach((neuron) => {
      const p = layout.positions.get(neuron.id) ?? new Vector3();
      let color = (colorOf.get(neuron.id) ?? new Color(0x9aa6c8)).clone();
      let base = neuron.broken ? 0.4 : 0.95;
      if (neuron.kind === 'ability') {
        const status = graph.servers[neuron.name];
        const tint = abilityTint(status);
        if (tint !== null) color = new Color(tint);
        if (status === 'disabled') base = 0.45;
      }

      const mat = new SpriteMaterial({
        map: tex,
        color: color.clone(),
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        opacity: base,
      });
      const sprite = new Sprite(mat);
      sprite.position.copy(p);
      sprite.userData.neuronId = neuron.id;
      const size = neuronRadius(neuron) * WORLD_SCALE;
      this.object.add(sprite);
      this.meta.push({ neuron, color, base, size, sprite });
      this.spotAlpha.push(base);
      this.boost.push(0);
    });

    this.refreshAll();
  }

  /** Compose spotlight alpha, wake boost and heat into one sprite's look. */
  private refresh(i: number): void {
    const m = this.meta[i];
    const heat = neuronSizeMul(m.neuron.id);
    const b = this.boost[i];
    const mat = m.sprite.material as SpriteMaterial;
    mat.opacity = Math.min(1.4, this.spotAlpha[i] + b * 0.9);
    mat.color.copy(m.color).lerp(WHITE, b * 0.3);
    const s = m.size * heat * (1 + b * 0.35);
    m.sprite.scale.set(s, s, 1);
  }

  private refreshAll(): void {
    for (let i = 0; i < this.meta.length; i++) this.refresh(i);
  }

  /** Kept for API parity with the old point-shader field; sprites are world-sized. */
  setScale(): void {}
  setTime(): void {}
  setFog(): void {}

  /** Execution wake glow per neuron (0..1). */
  setBoost(levels: ReadonlyMap<string, number>): void {
    for (let i = 0; i < this.meta.length; i++) this.boost[i] = levels.get(this.meta[i].neuron.id) ?? 0;
    this.refreshAll();
  }

  /**
   * Spotlight a subset. `visible === null` -> resting. `hideFocused` blanks the
   * focused neuron entirely so a flow-graph view can take its place.
   */
  spotlight(visible: Set<string> | null, focusId: string | null, hideFocused = false): void {
    for (let i = 0; i < this.meta.length; i++) {
      const m = this.meta[i];
      if (m.neuron.id === focusId) this.spotAlpha[i] = hideFocused ? 0 : Math.min(m.base * 1.5, 1.4);
      else if (!visible) this.spotAlpha[i] = m.base;
      else if (visible.has(m.neuron.id)) this.spotAlpha[i] = hideFocused ? m.base * 0.3 : m.base;
      else this.spotAlpha[i] = hideFocused ? 0.02 : 0.08;
    }
    this.refreshAll();
  }

  /** The neuron id under the ray, if any. */
  pick(raycaster: Raycaster): string | null {
    const hits = raycaster.intersectObjects(this.object.children, false);
    return (hits[0]?.object.userData.neuronId as string | undefined) ?? null;
  }
}

const WHITE = new Color(0xffffff);
