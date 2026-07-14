import {
  Clock,
  FogExp2,
  Group,
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

import type { BrainGraph, Neuron, NodeChatMessage, SynapseKind } from '../types';
import { abilityForTool, splitToolName } from '../data/distill';
import { BACKGROUND, nodeTypeLabel } from '../theme';
import { groupNeurons, type GroupMode } from '../grouping';
import { computeSectionedLayout, type SectionedLayout } from '../layout/sectionedLayout';
import { createStarfield } from './starfield';
import { createNebulae, setNebulaeDim } from './nebula';
import { FlowNodeLabels, SectionLabels } from './labels';
import { FlowGraph } from './flowGraph';
import { StarField } from './stars';
import { SynapseField } from './synapses';
import type { Hud, RelationLine } from '../ui/hud';
import { ChatBubbleLayer } from '../ui/bubbles';
import type { BrainActivityEvent } from '../data/execution';

const FOV = 55;
const BLOOM_OVERVIEW = 0.32;
const BLOOM_FOCUS = 0.08;

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
  private nebulae!: Group;

  // Focused-behaviour graph view.
  private flowGraph: FlowGraph | null = null;
  private flowLabels: FlowNodeLabels | null = null;
  private selectedNodeId: string | null = null;
  private hoveredNodeId: string | null = null;

  private kindsEnabled: Set<SynapseKind>;
  private groupMode: GroupMode;

  private focusId: string | null = null;
  private searchSet: Set<string> | null = null;
  private hoveredId: string | null = null;
  private dirty = true; // recolour synapses / spotlight on next frame

  // Live execution state (fed by the ExecutionWatcher).
  /** flowId -> wake-glow level; pulses while running, decays afterwards. */
  private glow = new Map<string, number>();
  /** conversationId -> behaviours currently executing in it. */
  private convFlows = new Map<string, Set<string>>();
  private followExec = true;
  private hudActivity: { flowId: string | null; detail?: string } | null = null;
  /** Chat output floating above the behaviour that produced it. */
  private bubbles = new ChatBubbleLayer();
  private bubbleV = new Vector3();
  /** The chat dock's conversation, grouped by the node that spoke. */
  private convByNode = new Map<string, NodeChatMessage[]>();

  private targetLookAt = new Vector3();
  /** Desired camera position while flying in/out of a focus; null = free. */
  private camGoal: Vector3 | null = null;
  private focusLerp = 1;
  private overviewDist = 100;
  private bloomTarget = BLOOM_OVERVIEW;

  private onWindowResize = () => this.resize();
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (this.selectedNodeId) this.selectNode(null);
    else this.clearFocus();
  };

  constructor(private canvas: HTMLCanvasElement, private graph: BrainGraph, private hud: Hud) {
    this.kindsEnabled = hud.enabledKinds();
    this.groupMode = hud.currentGroupMode();
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
    this.controls.screenSpacePanning = true;

    // Subtle depth cue only — the 2D view has no haze at all, and heavy fog
    // reads as murk rather than depth. The background starfield opts out.
    this.scene.fog = new FogExp2(BACKGROUND, 0.001);

    this.scene.add(createStarfield(1600, 900));
    this.scene.add(this.content);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), BLOOM_OVERVIEW, 0.4, 0.55);
    this.composer.addPass(this.bloom);

    this.raycaster.params.Points = { threshold: 2.6 };

    this.build();
    this.resize();
    this.frameCameraToBrain();
    this.wireHud();
    this.wireInput();
    window.addEventListener('resize', this.onWindowResize);

    this.hud.setStats(graph, this.currentGroupCount());

    // Deep link: ?focus=<behaviour name or id> jumps straight into it.
    const wanted = new URLSearchParams(location.search).get('focus')?.toLowerCase();
    if (wanted) {
      const match = graph.neurons.find((n) => n.id === wanted || n.name.toLowerCase() === wanted)
        ?? graph.neurons.find((n) => n.name.toLowerCase().includes(wanted));
      if (match) this.setFocus(match.id);
    }
    // Keep an active search filter across a renderer switch.
    const q = (document.getElementById('search') as HTMLInputElement | null)?.value.trim().toLowerCase();
    if (q) this.applySearch(q);

    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Tear down GL resources and listeners so a 2D renderer can take over. */
  dispose(): void {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('keydown', this.onKeyDown);
    this.clearContent();
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.bubbles.dispose();
    this.hud.hideTooltip();
    this.hud.setActivity(null);
    this.hud.hidePanel(true); // teardown, not a deselect — the chat target stays
  }

  private currentGroupCount(): number {
    return groupNeurons(this.graph.neurons, this.groupMode).groups.length;
  }

  private focusedNeuron(): Neuron | null {
    return this.focusId ? this.graph.neurons.find((n) => n.id === this.focusId) ?? null : null;
  }

  /** (Re)build all group-dependent scene content. */
  private build(): void {
    this.clearContent();
    const grouping = groupNeurons(this.graph.neurons, this.groupMode);
    this.layout = computeSectionedLayout(this.graph, grouping);

    this.stars = new StarField(this.graph, grouping, this.layout);
    this.synapses = new SynapseField(this.graph, this.layout.positions);
    this.labels = new SectionLabels(grouping, this.layout);
    this.nebulae = createNebulae(grouping, this.layout);

    this.content.add(
      this.nebulae,
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
    // keepSelection: setFocus below re-announces a surviving selection, and
    // the dock validates a vanished one against the new graph itself.
    this.hud.hidePanel(true);
    this.build();
    this.hud.setStats(graph, this.currentGroupCount());
    // Restore focus if that behaviour still exists after the refresh.
    if (hadFocus && graph.neurons.some((n) => n.id === hadFocus)) this.setFocus(hadFocus);
  }

  private clearContent(): void {
    this.clearFlowGraph();
    this.labels?.dispose();
    this.labels = undefined;
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

    // Scale the depth fade to the brain's actual size — kept faint (the far
    // side dims a few percent) so the view stays as crisp as the 2D renderer.
    const density = 0.15 / dist;
    (this.scene.fog as FogExp2).density = density;
    this.stars.setFog(density);
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
    this.hud.onBackToBehaviour = () => this.selectNode(null);
    this.hud.onFocusBehaviour = (id) => {
      if (this.graph.neurons.some((n) => n.id === id)) this.setFocus(id);
    };
    this.hud.onGroupMode = (mode) => {
      if (mode === this.groupMode) return;
      this.groupMode = mode;
      this.resetToOverview();
      this.hud.setStats(this.graph, this.currentGroupCount());
    };
    this.hud.onFollow = (on) => {
      this.followExec = on;
    };
    this.followExec = this.hud.followEnabled();
  }

  /** Full rebuild + camera reset after a grouping or view-mode change. */
  private resetToOverview(): void {
    this.focusId = null;
    this.searchSet = null;
    this.hoveredId = null;
    this.hud.hidePanel();
    this.build();
    this.frameCameraToBrain();
    this.controls.autoRotate = true;
    this.bloomTarget = BLOOM_OVERVIEW;
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
      this.handleClick();
    });
    window.addEventListener('keydown', this.onKeyDown);
  }

  private handleClick(): void {
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // Inside a focused behaviour, its graph nodes get first pick.
    if (this.flowGraph) {
      const nodeId = this.flowGraph.pick(this.raycaster);
      if (nodeId) {
        this.selectNode(nodeId);
        return;
      }
    }

    const id = this.pickCore();
    if (id && id !== this.focusId) this.setFocus(id);
    else if (!id) this.clearFocus();
  }

  private pickCore(): string | null {
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
    this.selectedNodeId = null;
    this.hoveredNodeId = null;
    this.controls.autoRotate = false;

    const neuron = this.graph.neurons.find((n) => n.id === id)!;
    const home = this.layout.positions.get(id) ?? new Vector3();
    const isAbility = neuron.kind === 'ability';

    this.clearFlowGraph();
    let dist = 26;
    if (isAbility) {
      // Abilities have no inner graph — spotlight the star where it lives,
      // galaxy clouds and section names stay up.
      this.bloomTarget = BLOOM_OVERVIEW;
      setNebulaeDim(this.nebulae, 1);
      this.labels?.setHidden(false);
    } else {
      this.bloomTarget = BLOOM_FOCUS;
      // Clear the stage: galaxy clouds and section names recede behind the graph.
      setNebulaeDim(this.nebulae, 0.12);
      this.labels?.setHidden(true);

      // Replace the glowing star with the behaviour's actual graph, oriented
      // toward the camera, then fly in to frame it head-on.
      this.flowGraph = new FlowGraph(neuron, this.graph.servers);
      this.flowGraph.group.position.copy(home);
      this.flowGraph.group.quaternion.copy(this.camera.quaternion);
      this.content.add(this.flowGraph.group);
      this.flowLabels = new FlowNodeLabels(neuron, this.flowGraph, (nodeId) => this.selectNode(nodeId), this.msgCounts());

      const halfV = Math.tan((FOV * Math.PI) / 360);
      dist = Math.max(
        (this.flowGraph.halfHeight * 1.25) / halfV,
        (this.flowGraph.halfWidth * 1.25) / (halfV * this.camera.aspect),
        10,
      );
    }

    this.targetLookAt.copy(home);
    const normal = new Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
    this.camGoal = home.clone().addScaledVector(normal, dist);
    this.focusLerp = 0;

    this.hud.showPanel(neuron, this.relationsOf(id), this.graph.servers);
    this.dirty = true;
  }

  /** Select a node inside the focused behaviour (null returns to overview panel). */
  private selectNode(nodeId: string | null): void {
    const neuron = this.focusedNeuron();
    if (!neuron || !this.flowGraph) return;
    this.selectedNodeId = nodeId;
    this.flowGraph.setSelected(nodeId);
    if (!nodeId) {
      this.hud.showPanel(neuron, this.relationsOf(neuron.id), this.graph.servers);
      return;
    }
    const node = neuron.inner.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const target = node.subflowId ? this.graph.neurons.find((n) => n.id === node.subflowId) ?? null : null;
    this.hud.showNodePanel(neuron, node, this.graph.servers, target, this.convByNode.get(nodeId) ?? []);
  }

  /** The chat dock's conversation changed — refresh the per-node overlay. */
  setConversation(msgs: NodeChatMessage[]): void {
    this.convByNode.clear();
    for (const m of msgs) {
      if (!this.convByNode.has(m.nodeId)) this.convByNode.set(m.nodeId, []);
      this.convByNode.get(m.nodeId)!.push(m);
    }
    // Focused graph open: rebuild the labels so 💬 badges stay current.
    const neuron = this.focusedNeuron();
    if (this.flowGraph && neuron) {
      this.flowLabels?.dispose();
      this.flowLabels = new FlowNodeLabels(neuron, this.flowGraph, (nodeId) => this.selectNode(nodeId), this.msgCounts());
      if (this.selectedNodeId) this.selectNode(this.selectedNodeId);
    }
  }

  private msgCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [id, msgs] of this.convByNode) counts.set(id, msgs.length);
    return counts;
  }

  private clearFocus(): void {
    if (!this.focusId && !this.searchSet) return;
    this.focusId = null;
    this.searchSet = null;
    this.selectedNodeId = null;
    this.controls.autoRotate = true;
    this.bloomTarget = BLOOM_OVERVIEW;
    setNebulaeDim(this.nebulae, 1);
    this.labels?.setHidden(false);
    this.clearFlowGraph();
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

  /**
   * Live execution event from the watcher (or the __brainSim debug hook).
   * Wakes neurons, flashes subflow axons, lights the active node in a focused
   * behaviour, and (with follow on) flies the camera to the executing flow.
   */
  handleExecution(e: BrainActivityEvent): void {
    switch (e.kind) {
      case 'run-start':
        this.touchFlow(e.conversationId, e.flowId);
        this.hudActivity = { flowId: e.flowId };
        this.followTo(e.flowId);
        break;
      case 'subflow-start':
        if (e.flowId && e.subflowId) this.synapses.flash(e.flowId, e.subflowId);
        this.touchFlow(e.conversationId, e.subflowId ?? null);
        this.hudActivity = { flowId: e.subflowId ?? e.flowId };
        this.followTo(e.subflowId ?? null);
        break;
      case 'subflow-done':
        if (e.subflowId) this.convFlows.get(e.conversationId)?.delete(e.subflowId);
        this.hudActivity = { flowId: e.flowId };
        break;
      case 'node-enter':
        this.touchFlow(e.conversationId, e.flowId);
        if (e.flowId && this.focusId === e.flowId) this.flowGraph?.setActive(e.node?.nodeId ?? null);
        this.hudActivity = { flowId: e.flowId, detail: e.node?.nodeName ?? undefined };
        break;
      case 'node-exit':
        // Keep the highlight until the next node lights up.
        break;
      case 'tool-call': {
        this.touchFlow(e.conversationId, e.flowId);
        const ability = abilityForTool(this.graph, e.toolName);
        if (ability) {
          this.glow.set(ability.id, 1);
          if (e.flowId) this.synapses.flash(e.flowId, ability.id);
        }
        if (e.toolName) {
          // A transient pill over the acting behaviour: ⚙ server · tool.
          const { server, tool } = splitToolName(e.toolName);
          const known = e.flowId && this.graph.neurons.some((n) => n.id === e.flowId);
          this.bubbles.push(known ? e.flowId : null, '', `⚙ ${server ? `${server} · ` : ''}${tool}`, { pill: true });
        }
        this.hudActivity = { flowId: e.flowId, detail: e.toolName ? `tool ${e.toolName}` : undefined };
        break;
      }
      case 'message':
        this.touchFlow(e.conversationId, e.flowId);
        if (e.text) {
          const name = e.flowId ? this.graph.neurons.find((n) => n.id === e.flowId)?.name : undefined;
          this.bubbles.push(name ? e.flowId : null, name ?? 'brain', e.text);
        }
        break;
      case 'run-done':
        this.convFlows.delete(e.conversationId);
        this.flowGraph?.setActive(null);
        if (!this.convFlows.size) this.hudActivity = null;
        break;
    }
    this.refreshActivityHud();
  }

  /** Note a behaviour as actively executing in a conversation. */
  private touchFlow(conversationId: string, flowId: string | null): void {
    if (!flowId || !this.graph.neurons.some((n) => n.id === flowId)) return;
    if (!this.convFlows.has(conversationId)) this.convFlows.set(conversationId, new Set());
    this.convFlows.get(conversationId)!.add(flowId);
    this.glow.set(flowId, 1);
  }

  /** Fly the camera to the executing behaviour when follow is on. */
  private followTo(flowId: string | null): void {
    if (!this.followExec || !flowId || flowId === this.focusId) return;
    if (!this.graph.neurons.some((n) => n.id === flowId)) return;
    this.setFocus(flowId);
  }

  private refreshActivityHud(): void {
    if (!this.convFlows.size || !this.hudActivity) {
      this.hud.setActivity(null);
      return;
    }
    const flow = this.hudActivity.flowId
      ? this.graph.neurons.find((n) => n.id === this.hudActivity!.flowId)?.name
      : undefined;
    this.hud.setActivity({
      flow: flow ?? 'thinking…',
      detail: this.hudActivity.detail,
      runs: this.convFlows.size,
    });
  }

  /** Pulse running behaviours, decay finished ones, push to the star shader. */
  private updateGlow(dt: number, t: number): void {
    if (!this.glow.size) return;
    const running = new Set<string>();
    for (const flows of this.convFlows.values()) for (const f of flows) running.add(f);
    for (const [id, level] of this.glow) {
      if (running.has(id)) {
        this.glow.set(id, 0.8 + 0.2 * Math.sin(t * 3.2));
      } else {
        const next = level * Math.exp(-dt * 1.1);
        if (next < 0.02) this.glow.delete(id);
        else this.glow.set(id, next);
      }
    }
    // The focused behaviour's star is hidden behind its flow graph — don't
    // let its wake glow bleed through. (A focused ability keeps its star.)
    if (this.focusId && this.flowGraph && this.glow.has(this.focusId)) {
      const masked = new Map(this.glow);
      masked.delete(this.focusId);
      this.stars.setBoost(masked);
    } else {
      this.stars.setBoost(this.glow);
    }
  }

  private clearFlowGraph(): void {
    this.flowGraph?.dispose();
    this.flowGraph = null;
    this.flowLabels?.dispose();
    this.flowLabels = null;
    this.hoveredNodeId = null;
  }

  private applySearch(q: string): void {
    if (this.focusId) this.clearFocus();
    this.searchSet = q ? new Set(this.graph.neurons.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.id)) : null;
    this.dirty = true;
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

  private updateHover(): void {
    if (!this.hasPointer) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    if (this.focusId && this.flowGraph) {
      const nodeId = this.flowGraph.pick(this.raycaster);
      if (nodeId !== this.hoveredNodeId) {
        this.hoveredNodeId = nodeId;
        this.flowGraph.setHover(nodeId);
        this.canvas.style.cursor = nodeId ? 'pointer' : 'default';
      }
      if (nodeId) {
        const node = this.focusedNeuron()?.inner.nodes.find((n) => n.id === nodeId);
        if (node) {
          this.hud.showTooltip(
            `${node.label} · ${nodeTypeLabel(node.type)}`,
            (this.pointer.x * 0.5 + 0.5) * window.innerWidth,
            (-this.pointer.y * 0.5 + 0.5) * window.innerHeight,
          );
        }
      } else {
        this.hud.hideTooltip();
      }
      return;
    }

    const id = this.pickCore();
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      this.canvas.style.cursor = id ? 'pointer' : 'default';
      this.dirty = true;
    }
    if (id) {
      const n = this.graph.neurons.find((x) => x.id === id)!;
      this.hud.showTooltip(
        n.kind === 'ability' ? `${n.name} · ability · ${this.graph.servers[n.name] ?? 'unknown'}` : `${n.name} · ${n.nodeTotal} nodes`,
        (this.pointer.x * 0.5 + 0.5) * window.innerWidth,
        (-this.pointer.y * 0.5 + 0.5) * window.innerHeight,
      );
    } else {
      this.hud.hideTooltip();
    }
  }

  private frame(): void {
    const dt = this.clock.getDelta();
    const t = this.clock.elapsedTime;
    this.controls.update();
    this.stars.setTime(t);
    this.synapses.animate(t);
    this.updateGlow(dt, t);
    this.updateHover();

    if (this.dirty) {
      this.applySpotlight();
      this.dirty = false;
    }

    // Ease bloom between the dreamy overview and the crisp focus view.
    this.bloom.strength += (this.bloomTarget - this.bloom.strength) * Math.min(1, dt * 3);

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
    this.flowLabels?.update(this.camera, window.innerWidth, window.innerHeight);
    this.bubbles.update((flowId) => {
      const pos = this.layout.positions.get(flowId);
      if (!pos) return null;
      this.bubbleV.copy(pos).project(this.camera);
      if (this.bubbleV.z > 1) return null; // behind the camera
      return {
        x: (this.bubbleV.x * 0.5 + 0.5) * window.innerWidth,
        y: (-this.bubbleV.y * 0.5 + 0.5) * window.innerHeight,
      };
    });
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

    // A focused ability has no flow graph — treat it like a bright hover
    // instead of hiding the star and receding the web.
    const graphOpen = this.flowGraph !== null;
    this.stars.spotlight(visible, focus, graphOpen);
    this.synapses.recolor(active, this.kindsEnabled, graphOpen);
  }
}
