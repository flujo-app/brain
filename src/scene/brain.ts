import {
  BufferGeometry,
  Clock,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import type { BrainGraph, SynapseKind } from '../types';
import { BACKGROUND } from '../theme';
import { groupNeurons, type GroupMode } from '../grouping';
import { computeSectionedLayout, type SectionedLayout } from '../layout/sectionedLayout';
import { createStarfield } from './starfield';
import { createNebulae } from './nebula';
import { InnerNodeLabels, SectionLabels } from './labels';
import { StarField } from './stars';
import { SynapseField } from './synapses';
import { Hud, type RelationLine } from '../ui/hud';

const FOV = 55;

export class Brain {
  private renderer: WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new Scene();
  private camera: PerspectiveCamera;
  private controls: OrbitControls;
  private clock = new Clock();
  private raycaster = new Raycaster();
  private pointer = new Vector2(-2, -2);
  private hasPointer = false;

  // Rebuildable content (regenerated when grouping mode or data changes).
  private content = new Group();
  private stars!: StarField;
  private synapses!: SynapseField;
  private layout!: SectionedLayout;
  private labels?: SectionLabels;
  private innerLabels?: InnerNodeLabels;
  private focusWiring: LineSegments | null = null;

  private hud = new Hud();
  private kindsEnabled = new Set<SynapseKind>(['subflow', 'server']);
  private groupMode: GroupMode = 'provider';

  private focusId: string | null = null;
  private searchSet: Set<string> | null = null;
  private hoveredId: string | null = null;
  private dirty = true; // recolour synapses / spotlight on next frame

  private targetLookAt = new Vector3();
  /** Desired camera position while flying in/out of a focus; null = free. */
  private camGoal: Vector3 | null = null;
  private focusLerp = 1;
  private overviewDist = 100;

  constructor(private canvas: HTMLCanvasElement, private graph: BrainGraph) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(BACKGROUND, 1);

    this.camera = new PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 4000);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.rotateSpeed = 0.55;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.28;

    this.scene.add(createStarfield(1600, 900));
    this.scene.add(this.content);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), 0.7, 0.5, 0.5);
    this.composer.addPass(this.bloom);

    this.raycaster.params.Points = { threshold: 2.6 };

    this.build();
    this.resize();
    this.frameCameraToBrain();
    this.wireHud();
    this.wireInput();
    window.addEventListener('resize', () => this.resize());

    this.hud.setSource(graph.source);
    this.hud.setStats(graph.neurons.length, graph.synapses.length, this.currentGroupCount());
    this.hud.setGroupMode(this.groupMode);

    // Deep link: ?focus=<flow name or id> jumps straight into a neuron.
    const wanted = new URLSearchParams(location.search).get('focus')?.toLowerCase();
    if (wanted) {
      const match = graph.neurons.find((n) => n.id === wanted || n.name.toLowerCase() === wanted)
        ?? graph.neurons.find((n) => n.name.toLowerCase().includes(wanted));
      if (match) this.setFocus(match.id);
    }

    this.renderer.setAnimationLoop(() => this.frame());
  }

  private currentGroupCount(): number {
    return groupNeurons(this.graph.neurons, this.groupMode).groups.length;
  }

  /** (Re)build all group-dependent scene content. */
  private build(): void {
    this.clearContent();
    const grouping = groupNeurons(this.graph.neurons, this.groupMode);
    this.layout = computeSectionedLayout(this.graph, grouping);

    this.stars = new StarField(this.graph, grouping, this.layout);
    this.synapses = new SynapseField(this.graph, this.layout.positions);
    this.labels = new SectionLabels(grouping, this.layout);

    this.content.add(
      createNebulae(grouping, this.layout),
      this.synapses.lines,
      this.synapses.pulses,
      this.stars.satellites,
      this.stars.cores,
    );

    this.stars.setScale(this.renderer.domElement.height, FOV);
    this.synapses.recolor(null, this.kindsEnabled);
    this.dirty = true;
  }

  /** Swap in fresh data (live refresh) and rebuild, keeping the camera. */
  setGraph(graph: BrainGraph): void {
    const hadFocus = this.focusId;
    this.graph = graph;
    this.focusId = null;
    this.searchSet = null;
    this.hoveredId = null;
    this.hud.hidePanel();
    this.build();
    this.hud.setSource(graph.source);
    this.hud.setStats(graph.neurons.length, graph.synapses.length, this.currentGroupCount());
    // Restore focus if that flow still exists after the refresh.
    if (hadFocus && graph.neurons.some((n) => n.id === hadFocus)) this.setFocus(hadFocus);
  }

  private clearContent(): void {
    this.clearFocusWiring();
    this.labels?.dispose();
    this.labels = undefined;
    this.innerLabels?.dispose();
    this.innerLabels = undefined;
    for (const child of [...this.content.children]) {
      this.content.remove(child);
      child.traverse?.((o) => {
        const m = o as { geometry?: { dispose?: () => void }; material?: { dispose?: () => void } };
        m.geometry?.dispose?.();
        m.material?.dispose?.();
      });
    }
  }

  private frameCameraToBrain(): void {
    let max = 10;
    for (const p of this.layout.positions.values()) max = Math.max(max, p.length());
    const dist = max * 1.7 + 20;
    this.overviewDist = dist;
    this.camera.position.set(0, dist * 0.28, dist);
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = 3;
    this.controls.maxDistance = dist * 3;
    this.camera.updateProjectionMatrix();
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w / 2, h / 2); // half-res bloom — cheaper, still smooth
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.stars?.setScale(this.renderer.domElement.height, FOV);
  }

  private wireHud(): void {
    this.hud.onToggleKind = (kind, on) => {
      if (on) this.kindsEnabled.add(kind);
      else this.kindsEnabled.delete(kind);
      this.dirty = true;
    };
    this.hud.onCloseFocus = () => this.clearFocus();
    this.hud.onSearch = (q) => this.applySearch(q);
    this.hud.onGroupMode = (mode) => {
      if (mode === this.groupMode) return;
      this.groupMode = mode;
      this.focusId = null;
      this.searchSet = null;
      this.hoveredId = null;
      this.hud.hidePanel();
      this.build();
      this.frameCameraToBrain();
      this.controls.autoRotate = true;
      this.hud.setStats(this.graph.neurons.length, this.graph.synapses.length, this.currentGroupCount());
    };
  }

  private wireInput(): void {
    // The user grabbing the controls cancels any in-flight camera animation.
    this.controls.addEventListener('start', () => {
      this.camGoal = null;
      this.focusLerp = 1;
    });
    this.canvas.addEventListener('pointermove', (e) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      this.hasPointer = true;
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hasPointer = false;
      this.hud.hideTooltip();
    });
    const downAt = new Vector2();
    this.canvas.addEventListener('pointerdown', (e) => downAt.set(e.clientX, e.clientY));
    this.canvas.addEventListener('pointerup', (e) => {
      if (downAt.distanceTo(new Vector2(e.clientX, e.clientY)) > 6) return;
      const id = this.pick();
      if (id) this.setFocus(id);
      else this.clearFocus();
    });
  }

  private pick(): string | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.stars.cores, false);
    if (!hits.length || hits[0].index == null) return null;
    return this.stars.neuronAt(hits[0].index)?.id ?? null;
  }

  private neighboursOf(id: string): Set<string> {
    const set = new Set<string>([id]);
    for (const s of this.graph.synapses) {
      if (!this.kindsEnabled.has(s.kind)) continue;
      if (s.source === id) set.add(s.target);
      if (s.target === id) set.add(s.source);
    }
    return set;
  }

  private relationsOf(id: string): RelationLine[] {
    const lines: RelationLine[] = [];
    for (const s of this.graph.synapses) {
      if (s.source !== id && s.target !== id) continue;
      const otherId = s.source === id ? s.target : s.source;
      const other = this.graph.neurons.find((n) => n.id === otherId);
      if (!other) continue;
      lines.push({ synapse: s, otherName: other.name, outgoing: s.source === id });
    }
    return lines.sort((a, b) =>
      a.synapse.kind === b.synapse.kind ? b.synapse.weight - a.synapse.weight : a.synapse.kind === 'subflow' ? -1 : 1,
    );
  }

  private setFocus(id: string): void {
    this.focusId = id;
    this.searchSet = null;
    this.controls.autoRotate = false;
    this.showFocusWiring(id);

    const neuron = this.graph.neurons.find((n) => n.id === id)!;
    const home = this.layout.positions.get(id);
    if (home) {
      this.targetLookAt.copy(home);
      // Fly the camera in close enough that the flow's inner constellation
      // fills the view: distance scales with the neuron's satellite spread.
      const spread = Math.sqrt(neuron.nodeTotal) * 2.2 + 8;
      const dir = this.camera.position.clone().sub(home);
      if (dir.lengthSq() < 0.01) dir.set(0, 0.3, 1);
      this.camGoal = home.clone().addScaledVector(dir.normalize(), spread);
      this.focusLerp = 0;
    }

    this.innerLabels?.dispose();
    this.innerLabels = new InnerNodeLabels(neuron, this.stars.innerWorld.get(id) ?? new Map(), this.graph.servers);
    this.hud.showPanel(neuron, this.relationsOf(id), this.graph.servers);
    this.dirty = true;
  }

  private clearFocus(): void {
    if (!this.focusId && !this.searchSet) return;
    this.focusId = null;
    this.searchSet = null;
    this.controls.autoRotate = true;
    this.clearFocusWiring();
    this.innerLabels?.dispose();
    this.innerLabels = undefined;
    this.hud.hidePanel();
    this.targetLookAt.set(0, 0, 0);
    // Fly back out to the overview along the current view direction.
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 0.01) dir.set(0, 0.3, 1);
    this.camGoal = dir.normalize().multiplyScalar(this.overviewDist);
    this.focusLerp = 0;
    (document.getElementById('search') as HTMLInputElement).value = '';
    this.dirty = true;
  }

  private applySearch(q: string): void {
    if (this.focusId) this.clearFocus();
    this.searchSet = q ? new Set(this.graph.neurons.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.id)) : null;
    this.dirty = true;
  }

  /** Draw the focused flow's internal node wiring as a thin overlay. */
  private showFocusWiring(id: string): void {
    this.clearFocusWiring();
    const inner = this.stars.innerWorld.get(id);
    const neuron = this.graph.neurons.find((n) => n.id === id);
    if (!inner || !neuron) return;
    const verts: number[] = [];
    for (const e of neuron.inner.edges) {
      const a = inner.get(e.source);
      const b = inner.get(e.target);
      if (a && b) verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    if (!verts.length) return;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(verts, 3));
    this.focusWiring = new LineSegments(geo, new LineBasicMaterial({ color: 0xcfe0ff, transparent: true, opacity: 0.7 }));
    this.content.add(this.focusWiring);
  }

  private clearFocusWiring(): void {
    if (!this.focusWiring) return;
    this.content.remove(this.focusWiring);
    this.focusWiring.geometry.dispose();
    (this.focusWiring.material as LineBasicMaterial).dispose();
    this.focusWiring = null;
  }

  private activeEdgesFor(visible: Set<string>, requireBoth: boolean): Set<number> {
    const set = new Set<number>();
    this.synapses.edges.forEach((e, i) => {
      const a = visible.has(e.synapse.source);
      const b = visible.has(e.synapse.target);
      if (requireBoth ? a || b : a && b) set.add(i);
    });
    return set;
  }

  private frame(): void {
    const dt = this.clock.getDelta();
    const t = this.clock.elapsedTime;
    this.controls.update();
    this.stars.setTime(t);
    this.synapses.animate(t);

    // Hover (only when nothing is focused).
    if (this.hasPointer && !this.focusId) {
      const id = this.pick();
      if (id !== this.hoveredId) {
        this.hoveredId = id;
        this.canvas.style.cursor = id ? 'pointer' : 'default';
        this.dirty = true;
      }
      if (id) {
        const n = this.graph.neurons.find((x) => x.id === id)!;
        this.hud.showTooltip(
          `${n.name} · ${n.nodeTotal} nodes`,
          (this.pointer.x * 0.5 + 0.5) * window.innerWidth,
          (-this.pointer.y * 0.5 + 0.5) * window.innerHeight,
        );
      } else {
        this.hud.hideTooltip();
      }
    }

    if (this.dirty) {
      this.applySpotlight();
      this.dirty = false;
    }

    // Fly the orbit pivot and camera toward the current goal.
    if (this.focusLerp < 1) {
      this.focusLerp = Math.min(1, this.focusLerp + dt * 1.2);
      this.controls.target.lerp(this.targetLookAt, 0.1);
      if (this.camGoal) {
        this.camera.position.lerp(this.camGoal, 0.08);
        if (this.focusLerp >= 1) this.camGoal = null;
      }
    }

    this.labels?.update(this.camera, window.innerWidth, window.innerHeight);
    this.innerLabels?.update(this.camera, window.innerWidth, window.innerHeight);
    this.composer.render();
  }

  private applySpotlight(): void {
    let visible: Set<string> | null = null;
    let active: Set<number> | null = null;
    const focus = this.focusId ?? this.hoveredId;

    if (this.focusId) {
      visible = this.neighboursOf(this.focusId);
      active = this.activeEdgesFor(visible, true);
    } else if (this.searchSet) {
      visible = this.searchSet;
      active = this.activeEdgesFor(visible, false);
    } else if (this.hoveredId) {
      visible = this.neighboursOf(this.hoveredId);
      active = this.activeEdgesFor(visible, true);
    }

    this.stars.spotlight(visible, focus);
    this.synapses.recolor(active, this.kindsEnabled);
  }
}
