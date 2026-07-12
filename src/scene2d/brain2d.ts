import type { BrainGraph, Neuron, Synapse, SynapseKind } from '../types';
import { BACKGROUND, SYNAPSE_COLORS, nodeTypeLabel } from '../theme';
import { groupNeurons, type GroupMode, type Grouping } from '../grouping';
import { computeSectionedLayout } from '../layout/sectionedLayout';
import { neuronRadius } from '../scene/stars';
import type { Hud, RelationLine } from '../ui/hud';
import type { BrainActivityEvent } from '../data/execution';
import { buildStarfield, glowSprite, nebulaSprite, toward } from './sprites';
import { FlowGraph2D } from './flowGraph2d';

/**
 * The true-2D renderer: the same brain — galaxies, synapses, live execution —
 * drawn with the Canvas 2D API instead of WebGL. No shaders, no bloom passes;
 * glow comes from pre-rendered gradient sprites composited additively, and the
 * frame loop throttles right down while nothing moves. Built for hardware
 * where the 3D view struggles.
 *
 * World space matches the flat sectioned layout, with y flipped once so it
 * grows downward like the canvas.
 */

const BG = '#' + BACKGROUND.toString(16).padStart(6, '0');

function hexOf(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

interface Star {
  neuron: Neuron;
  x: number;
  y: number;
  /** World radius (same scale the 3D StarField uses). */
  r: number;
  color: string;
  base: number;
  phase: number;
  sats: Array<{ x: number; y: number; size: number; color: string }>;
}

interface Edge2 {
  synapse: Synapse;
  ax: number; ay: number;
  bx: number; by: number;
  cx: number; cy: number; // quadratic control point
  fade: number; // long edges thin out
  color: string;
  speed: number;
  phase: number;
}

interface CamGoal { x: number; y: number; s: number }

export class Brain2D {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private starLayer!: HTMLCanvasElement;

  // Camera: world-space centre + scale (screen px per world unit).
  private cam = { x: 0, y: 0, s: 4 };
  private camGoal: CamGoal | null = null;
  private overviewScale = 4;

  // Rebuildable content.
  private grouping!: Grouping;
  private pos2 = new Map<string, { x: number; y: number }>();
  private stars: Star[] = [];
  private edges: Edge2[] = [];
  private groupGeo: Array<{ id: string; label: string; color: string; x: number; y: number; radius: number; count: number; gi: number }> = [];

  // Interaction / view state.
  private kindsEnabled: Set<SynapseKind>;
  private groupMode: GroupMode;
  private focusId: string | null = null;
  private searchSet: Set<string> | null = null;
  private hoveredId: string | null = null;
  private flowGraph: FlowGraph2D | null = null;
  private selectedNodeId: string | null = null;
  private hoveredNodeId: string | null = null;

  // Spotlight caches, recomputed when focus / hover / search / kinds change.
  private starAlpha: number[] = [];
  private edgeM: number[] = [];
  private dirty = true;
  private needsDraw = true;

  // Live execution state (fed by the ExecutionWatcher).
  private glow = new Map<string, number>();
  private convFlows = new Map<string, Set<string>>();
  private edgeBoost: number[] = [];
  private followExec = true;
  private hudActivity: { flowId: string | null; detail?: string } | null = null;

  // Eased visual state.
  private focusEase = 0; // 0 = overview, 1 = flow graph fully in
  private nebulaDim = 1;

  // Pointer state.
  private pointers = new Map<number, { x: number; y: number }>();
  private downAt = { x: 0, y: 0 };
  private dragged = false;
  private lastPointer = { x: 0, y: 0 };
  private hasPointer = false;
  private pinchDist = 0;

  private raf = 0;
  private lastT = 0;
  private lastDrawT = 0;
  private onResize = () => this.resize();
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (this.selectedNodeId) this.selectNode(null);
    else this.clearFocus();
  };

  constructor(private canvas: HTMLCanvasElement, private graph: BrainGraph, private hud: Hud) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.kindsEnabled = hud.enabledKinds();
    this.groupMode = hud.currentGroupMode();

    this.build();
    this.resize();
    this.frameOverview(true);
    this.wireHud();
    this.wireInput();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);

    this.hud.setStats(graph.neurons.length, graph.synapses.length, this.grouping.groups.length);
    this.followExec = hud.followEnabled();

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

    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  // ---------- content ----------

  /** (Re)build all group-dependent derived geometry. */
  private build(): void {
    this.grouping = groupNeurons(this.graph.neurons, this.groupMode);
    const layout = computeSectionedLayout(this.graph, this.grouping, true);

    this.pos2.clear();
    for (const [id, p] of layout.positions) this.pos2.set(id, { x: p.x, y: -p.y });

    const colorOf = new Map<string, string>();
    for (const g of this.grouping.groups) {
      for (const id of g.neuronIds) colorOf.set(id, '#' + g.color.getHexString());
    }

    this.stars = this.graph.neurons.map((neuron, ci) => {
      const p = this.pos2.get(neuron.id) ?? { x: 0, y: 0 };
      const color = colorOf.get(neuron.id) ?? '#9aa6c8';
      const radius = neuronRadius(neuron);
      const spread = radius * 1.7 + 1.2;
      const sats = neuron.inner.nodes.map((node, k) => {
        const shade = 0.55 + (((ci + k) * 40503) % 100) / 100 * 0.4;
        const status = node.type === 'mcp' && node.server ? this.graph.servers[node.server] : undefined;
        const satColor =
          status === 'disconnected' ? '#ff5c8a'
          : status === 'disabled' ? '#556080'
          : toward('#000000', color, shade);
        return { x: p.x + node.x * spread, y: p.y - node.y * spread, size: 0.34 + shade * 0.4, color: satColor };
      });
      return {
        neuron,
        x: p.x,
        y: p.y,
        r: radius,
        color,
        base: neuron.broken ? 0.4 : 0.95,
        phase: (ci * 12.9898) % 6.28,
        sats,
      };
    });

    this.edges = [];
    this.graph.synapses.forEach((s, i) => {
      const a = this.pos2.get(s.source);
      const b = this.pos2.get(s.target);
      if (!a || !b) return;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      // Bow away from the brain centre so hub wiring arcs around the core.
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      let ox = mx;
      let oy = my;
      if (ox * ox + oy * oy < 4) {
        ox = -(b.y - a.y);
        oy = b.x - a.x;
      }
      const ol = Math.hypot(ox, oy) || 1;
      const bow = 1.5 + len * 0.16;
      this.edges.push({
        synapse: s,
        ax: a.x, ay: a.y, bx: b.x, by: b.y,
        cx: mx + (ox / ol) * bow, cy: my + (oy / ol) * bow,
        fade: Math.min(0.85, Math.max(0, (len - 8) / 50)),
        color: hexOf(SYNAPSE_COLORS[s.kind]),
        speed: 0.12 + ((i * 2654435761) % 1000) / 1000 * 0.35 + (s.kind === 'subflow' ? 0.2 : 0),
        phase: ((i * 40503) % 1000) / 1000,
      });
    });
    this.edgeBoost = new Array(this.edges.length).fill(0);

    this.groupGeo = this.grouping.groups.map((g, gi) => {
      const c = layout.centers.get(g.id)!;
      return {
        id: g.id,
        label: g.label,
        color: '#' + g.color.getHexString(),
        x: c.x,
        y: -c.y,
        radius: layout.radii.get(g.id) ?? 4,
        count: g.neuronIds.length,
        gi,
      };
    });

    this.dirty = true;
    this.needsDraw = true;
  }

  /** Swap in fresh data (live refresh) and rebuild, keeping the camera. */
  setGraph(graph: BrainGraph): void {
    const hadFocus = this.focusId;
    this.graph = graph;
    this.focusId = null;
    this.searchSet = null;
    this.hoveredId = null;
    this.flowGraph = null;
    this.hud.hidePanel();
    this.build();
    this.hud.setStats(graph.neurons.length, graph.synapses.length, this.grouping.groups.length);
    if (hadFocus && graph.neurons.some((n) => n.id === hadFocus)) this.setFocus(hadFocus);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    this.hud.hideTooltip();
    this.hud.setActivity(null);
    this.hud.hidePanel();
  }

  // ---------- camera ----------

  private w2s = (wx: number, wy: number): [number, number] => [
    this.w / 2 + (wx - this.cam.x) * this.cam.s,
    this.h / 2 + (wy - this.cam.y) * this.cam.s,
  ];

  private s2w(sx: number, sy: number): [number, number] {
    return [this.cam.x + (sx - this.w / 2) / this.cam.s, this.cam.y + (sy - this.h / 2) / this.cam.s];
  }

  private frameOverview(instant = false): void {
    let max = 10;
    for (const p of this.pos2.values()) max = Math.max(max, Math.hypot(p.x, p.y));
    const s = (Math.min(this.w, this.h) * 0.5) / (max * 1.18 + 14);
    this.overviewScale = s;
    if (instant) {
      this.cam = { x: 0, y: 0, s };
      this.camGoal = null;
    } else {
      this.camGoal = { x: 0, y: 0, s };
    }
    this.needsDraw = true;
  }

  private resize(): void {
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.starLayer = buildStarfield(this.w, this.h, this.dpr);
    this.needsDraw = true;
  }

  // ---------- hud / input ----------

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
      this.hud.setStats(this.graph.neurons.length, this.graph.synapses.length, this.grouping.groups.length);
    };
    this.hud.onFollow = (on) => {
      this.followExec = on;
    };
  }

  private resetToOverview(): void {
    this.focusId = null;
    this.searchSet = null;
    this.hoveredId = null;
    this.flowGraph = null;
    this.selectedNodeId = null;
    this.hud.hidePanel();
    this.build();
    this.frameOverview();
  }

  private wireInput(): void {
    const c = this.canvas;
    c.style.touchAction = 'none';

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.downAt = { x: e.clientX, y: e.clientY };
        this.dragged = false;
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      this.camGoal = null; // grabbing cancels any camera flight
    });

    c.addEventListener('pointermove', (e) => {
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.hasPointer = true;
      const prev = this.pointers.get(e.pointerId);
      if (!prev) {
        this.updateHover();
        return;
      }
      const cur = { x: e.clientX, y: e.clientY };
      this.pointers.set(e.pointerId, cur);

      if (this.pointers.size === 1) {
        const dx = cur.x - prev.x;
        const dy = cur.y - prev.y;
        if (Math.hypot(cur.x - this.downAt.x, cur.y - this.downAt.y) > 6) this.dragged = true;
        if (this.dragged) {
          this.cam.x -= dx / this.cam.s;
          this.cam.y -= dy / this.cam.s;
          this.needsDraw = true;
        }
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDist > 0 && d > 0) {
          this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / this.pinchDist);
        }
        this.pinchDist = d;
        this.dragged = true;
      }
    });

    const release = (e: PointerEvent) => {
      const was = this.pointers.delete(e.pointerId);
      if (was && this.pointers.size === 0 && !this.dragged) this.handleClick(e.clientX, e.clientY);
      if (this.pointers.size < 2) this.pinchDist = 0;
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
    c.addEventListener('pointerleave', () => {
      this.hasPointer = false;
      this.hud.hideTooltip();
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camGoal = null;
      this.zoomAt(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY));
    }, { passive: false });
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.s2w(sx, sy);
    const next = Math.min(160, Math.max(this.overviewScale * 0.25, this.cam.s * factor));
    this.cam.s = next;
    this.cam.x = wx - (sx - this.w / 2) / next;
    this.cam.y = wy - (sy - this.h / 2) / next;
    this.needsDraw = true;
  }

  // ---------- picking / selection ----------

  private pickStar(sx: number, sy: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (let i = 0; i < this.stars.length; i++) {
      const st = this.stars[i];
      if (this.starAlpha[i] <= 0.03) continue;
      const [x, y] = this.w2s(st.x, st.y);
      const d = Math.hypot(sx - x, sy - y);
      const rPick = Math.max(st.r * 1.15 * this.cam.s, 11);
      if (d <= rPick && d < bestD) {
        bestD = d;
        best = st.neuron.id;
      }
    }
    return best;
  }

  private handleClick(sx: number, sy: number): void {
    if (this.flowGraph) {
      const nodeId = this.flowGraph.pick(sx, sy, this.w2s, this.cam.s);
      if (nodeId) {
        this.selectNode(nodeId);
        return;
      }
    }
    const id = this.pickStar(sx, sy);
    if (id && id !== this.focusId) this.setFocus(id);
    else if (!id) this.clearFocus();
  }

  private focusedNeuron(): Neuron | null {
    return this.focusId ? this.graph.neurons.find((n) => n.id === this.focusId) ?? null : null;
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

    const neuron = this.graph.neurons.find((n) => n.id === id)!;
    const home = this.pos2.get(id) ?? { x: 0, y: 0 };
    this.flowGraph = new FlowGraph2D(neuron, this.graph.servers, home.x, home.y);

    // Fly in so the graph fills most of the viewport.
    const s = Math.min(
      160,
      (this.w * 0.7) / (this.flowGraph.halfWidth * 2),
      (this.h * 0.62) / (this.flowGraph.halfHeight * 2),
    );
    this.camGoal = { x: home.x, y: home.y + this.flowGraph.halfHeight * 0.12, s };

    this.hud.showPanel(neuron, this.relationsOf(id), this.graph.servers);
    this.dirty = true;
  }

  /** Select a node inside the focused behaviour (null returns to overview panel). */
  private selectNode(nodeId: string | null): void {
    const neuron = this.focusedNeuron();
    if (!neuron || !this.flowGraph) return;
    this.selectedNodeId = nodeId;
    this.flowGraph.setSelected(nodeId);
    this.needsDraw = true;
    if (!nodeId) {
      this.hud.showPanel(neuron, this.relationsOf(neuron.id), this.graph.servers);
      return;
    }
    const node = neuron.inner.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const target = node.subflowId ? this.graph.neurons.find((n) => n.id === node.subflowId) ?? null : null;
    this.hud.showNodePanel(neuron, node, this.graph.servers, target);
  }

  private clearFocus(): void {
    if (!this.focusId && !this.searchSet) {
      // Nothing to clear — but if the user has wandered off, a click on
      // empty space still brings the whole brain back into frame.
      const drifted =
        Math.abs(this.cam.s - this.overviewScale) / this.overviewScale > 0.3 ||
        Math.hypot(this.cam.x, this.cam.y) * this.overviewScale > Math.min(this.w, this.h) * 0.25;
      if (drifted) this.frameOverview();
      return;
    }
    this.focusId = null;
    this.searchSet = null;
    this.selectedNodeId = null;
    this.flowGraph = null;
    this.hud.hidePanel();
    this.frameOverview();
    (document.getElementById('search') as HTMLInputElement).value = '';
    this.dirty = true;
  }

  private applySearch(q: string): void {
    if (this.focusId) this.clearFocus();
    this.searchSet = q ? new Set(this.graph.neurons.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.id)) : null;
    this.dirty = true;
  }

  private updateHover(): void {
    if (!this.hasPointer || this.pointers.size > 0) return;
    const { x, y } = this.lastPointer;

    if (this.focusId && this.flowGraph) {
      const nodeId = this.flowGraph.pick(x, y, this.w2s, this.cam.s);
      if (nodeId !== this.hoveredNodeId) {
        this.hoveredNodeId = nodeId;
        this.flowGraph.setHover(nodeId);
        this.canvas.style.cursor = nodeId ? 'pointer' : 'default';
        this.needsDraw = true;
      }
      if (nodeId) {
        const node = this.focusedNeuron()?.inner.nodes.find((n) => n.id === nodeId);
        if (node) this.hud.showTooltip(`${node.label} · ${nodeTypeLabel(node.type)}`, x, y);
      } else {
        this.hud.hideTooltip();
      }
      return;
    }

    const id = this.pickStar(x, y);
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      this.canvas.style.cursor = id ? 'pointer' : 'default';
      this.dirty = true;
    }
    if (id) {
      const n = this.graph.neurons.find((nn) => nn.id === id)!;
      this.hud.showTooltip(`${n.name} · ${n.nodeTotal} nodes`, x, y);
    } else {
      this.hud.hideTooltip();
    }
  }

  // ---------- live execution ----------

  handleExecution(e: BrainActivityEvent): void {
    switch (e.kind) {
      case 'run-start':
        this.touchFlow(e.conversationId, e.flowId);
        this.hudActivity = { flowId: e.flowId };
        this.followTo(e.flowId);
        break;
      case 'subflow-start':
        if (e.flowId && e.subflowId) this.flash(e.flowId, e.subflowId);
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
        if (e.flowId && this.focusId === e.flowId && this.flowGraph?.setActive(e.node?.nodeId ?? null)) {
          this.needsDraw = true;
        }
        this.hudActivity = { flowId: e.flowId, detail: e.node?.nodeName ?? undefined };
        break;
      case 'node-exit':
        break; // keep the highlight until the next node lights up
      case 'tool-call':
        this.touchFlow(e.conversationId, e.flowId);
        this.hudActivity = { flowId: e.flowId, detail: e.toolName ? `tool ${e.toolName}` : undefined };
        break;
      case 'run-done':
        this.convFlows.delete(e.conversationId);
        if (this.flowGraph?.setActive(null)) this.needsDraw = true;
        if (!this.convFlows.size) this.hudActivity = null;
        break;
    }
    this.refreshActivityHud();
  }

  private touchFlow(conversationId: string, flowId: string | null): void {
    if (!flowId || !this.graph.neurons.some((n) => n.id === flowId)) return;
    if (!this.convFlows.has(conversationId)) this.convFlows.set(conversationId, new Set());
    this.convFlows.get(conversationId)!.add(flowId);
    this.glow.set(flowId, 1);
  }

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

  /** Flash the subflow axon source -> target (a live behaviour call). */
  private flash(sourceId: string, targetId: string): void {
    const i = this.edges.findIndex(
      (e) => e.synapse.kind === 'subflow' && e.synapse.source === sourceId && e.synapse.target === targetId,
    );
    if (i >= 0) this.edgeBoost[i] = 1;
  }

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
  }

  // ---------- spotlight ----------

  private activeEdgesFor(visible: Set<string>, anyEnd: boolean): Set<number> {
    const set = new Set<number>();
    this.edges.forEach((e, i) => {
      const a = visible.has(e.synapse.source);
      const b = visible.has(e.synapse.target);
      if (anyEnd ? a || b : a && b) set.add(i);
    });
    return set;
  }

  /** Mirror of the 3D spotlight rules, cached into flat alpha arrays. */
  private applySpotlight(): void {
    const focusOpen = this.focusId !== null;
    const focus = this.focusId ?? this.hoveredId;
    let visible: Set<string> | null = null;
    let active: Set<number> | null = null;

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

    this.starAlpha = this.stars.map((st) => {
      const id = st.neuron.id;
      if (id === focus) return focusOpen ? 0 : Math.min(st.base * 1.5, 1.4);
      if (!visible) return st.base;
      if (visible.has(id)) return focusOpen ? st.base * 0.3 : st.base;
      return focusOpen ? 0.02 : 0.08;
    });

    this.edgeM = this.edges.map((e, i) => {
      if (!this.kindsEnabled.has(e.synapse.kind)) return 0;
      let m = e.synapse.kind === 'subflow' ? 0.9 : e.synapse.kind === 'server' ? 0.38 : 0.2;
      if (active) m *= active.has(i) ? (focusOpen ? 0.45 : 1.8) : (focusOpen ? 0.012 : 0.05);
      return m;
    });
  }

  // ---------- frame loop ----------

  private frame(nowMs: number): void {
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const t = nowMs / 1000;
    const dt = Math.min(0.1, Math.max(0.0001, t - this.lastT));
    this.lastT = t;

    // Camera flight.
    if (this.camGoal) {
      const g = this.camGoal;
      const k = Math.min(1, dt * 4.5);
      this.cam.x += (g.x - this.cam.x) * k;
      this.cam.y += (g.y - this.cam.y) * k;
      this.cam.s += (g.s - this.cam.s) * k;
      this.needsDraw = true;
      if (Math.abs(g.s - this.cam.s) / g.s < 0.002 && Math.hypot(g.x - this.cam.x, g.y - this.cam.y) * this.cam.s < 0.5) {
        this.cam = { x: g.x, y: g.y, s: g.s };
        this.camGoal = null;
      }
    }

    // Eased dims.
    const focusTarget = this.focusId ? 1 : 0;
    if (Math.abs(this.focusEase - focusTarget) > 0.002) {
      this.focusEase += (focusTarget - this.focusEase) * Math.min(1, dt * 6);
      this.needsDraw = true;
    } else if (this.focusEase !== focusTarget) {
      this.focusEase = focusTarget;
      this.needsDraw = true;
    }
    const nebulaTarget = this.focusId ? 0.12 : 1;
    this.nebulaDim += (nebulaTarget - this.nebulaDim) * Math.min(1, dt * 6);

    this.updateGlow(dt, t);
    let flashing = false;
    for (let i = 0; i < this.edgeBoost.length; i++) {
      if (this.edgeBoost[i] <= 0.01) continue;
      this.edgeBoost[i] *= Math.exp(-dt * 1.6);
      if (this.edgeBoost[i] <= 0.01) this.edgeBoost[i] = 0;
      else flashing = true;
    }

    if (this.dirty) {
      this.applySpotlight();
      this.dirty = false;
      this.needsDraw = true;
    }

    // Render on demand: full rate while something moves, a slow ambient tick
    // (for pulse drift and twinkle) otherwise — near-zero idle cost.
    const animating = this.camGoal !== null || this.glow.size > 0 || flashing || this.pointers.size > 0;
    const ambientDue = t - this.lastDrawT >= 0.05;
    if (!this.needsDraw && !animating && !ambientDue) return;
    this.needsDraw = false;
    this.lastDrawT = t;
    this.draw(t);
  }

  // ---------- drawing ----------

  private draw(t: number): void {
    const { ctx, w, h, dpr, cam } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    // Background starfield with a slight parallax drift, wrap-tiled.
    const ox = ((-cam.x * cam.s * 0.05) % w + w) % w;
    const oy = ((-cam.y * cam.s * 0.05) % h + h) % h;
    ctx.drawImage(this.starLayer, ox, oy, w, h);
    ctx.drawImage(this.starLayer, ox - w, oy, w, h);
    ctx.drawImage(this.starLayer, ox, oy - h, w, h);
    ctx.drawImage(this.starLayer, ox - w, oy - h, w, h);

    // View bounds in world space (with margin) for cheap culling.
    const margin = 40 / cam.s + 10;
    const wx1 = cam.x - (w / 2) / cam.s - margin;
    const wx2 = cam.x + (w / 2) / cam.s + margin;
    const wy1 = cam.y - (h / 2) / cam.s - margin;
    const wy2 = cam.y + (h / 2) / cam.s + margin;
    const onScreen = (x: number, y: number, r = 0) => x + r > wx1 && x - r < wx2 && y + r > wy1 && y - r < wy2;

    ctx.globalCompositeOperation = 'lighter';

    // Galaxy nebulae — layered soft tinted clouds.
    for (const g of this.groupGeo) {
      const sprite = nebulaSprite(g.color);
      for (let k = 0; k < 4; k++) {
        const rnd = (n: number) => ((((g.gi * 31 + k * 17 + n * 7) * 2654435761) % 1000) / 1000) - 0.5;
        const spread = k === 0 ? 0 : g.radius * 0.6;
        const x = g.x + rnd(0) * spread * 2;
        const y = g.y - rnd(1) * spread * 1.4;
        const size = (k === 0 ? g.radius * 2.6 + 8 : g.radius * (1.1 + (rnd(4) + 0.5) * 0.9) + 4) * cam.s;
        if (size < 6 || !onScreen(x, y, size / cam.s / 2)) continue;
        const [sx, sy] = this.w2s(x, y);
        ctx.globalAlpha = (k === 0 ? 0.14 : 0.08) * this.nebulaDim;
        ctx.drawImage(sprite, sx - size / 2, sy - size / 2, size, size);
      }
    }

    // Synapses: quadratic filaments, alpha carrying the spotlight intensity.
    for (let i = 0; i < this.edges.length; i++) {
      const m = this.edgeM[i] + this.edgeBoost[i] * 1.2;
      if (m <= 0.012) continue;
      const e = this.edges[i];
      if (!onScreen((e.ax + e.bx) / 2, (e.ay + e.by) / 2, Math.hypot(e.bx - e.ax, e.by - e.ay))) continue;
      const [ax, ay] = this.w2s(e.ax, e.ay);
      const [bx, by] = this.w2s(e.bx, e.by);
      const [ex, ey] = this.w2s(e.cx, e.cy);
      ctx.globalAlpha = Math.min(1, m * 0.8 * (1 - e.fade * 0.55));
      ctx.strokeStyle = e.color;
      ctx.lineWidth = (e.synapse.kind === 'subflow' ? 1.5 : 1.05) + this.edgeBoost[i] * 1.6;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(ex, ey, bx, by);
      ctx.stroke();
    }

    // Travelling signal pulses along each visible synapse.
    const pulseSize = Math.min(16, Math.max(5, 1.7 * cam.s));
    for (let i = 0; i < this.edges.length; i++) {
      const m = this.edgeM[i] + this.edgeBoost[i] * 1.2;
      if (m <= 0.03) continue;
      const e = this.edges[i];
      let f = (t * e.speed + e.phase) % 1;
      if (!e.synapse.directed) f = f < 0.5 ? f * 2 : (1 - f) * 2;
      const u = 1 - f;
      const px = u * u * e.ax + 2 * u * f * e.cx + f * f * e.bx;
      const py = u * u * e.ay + 2 * u * f * e.cy + f * f * e.by;
      if (!onScreen(px, py)) continue;
      const [sx, sy] = this.w2s(px, py);
      ctx.globalAlpha = Math.min(1, m * 1.1);
      ctx.drawImage(glowSprite(e.color), sx - pulseSize / 2, sy - pulseSize / 2, pulseSize, pulseSize);
    }

    // Satellites: each behaviour's internal nodes, as faint dots.
    if (cam.s > 2.2) {
      for (let i = 0; i < this.stars.length; i++) {
        const a = this.starAlpha[i] * 0.62;
        if (a <= 0.03) continue;
        const st = this.stars[i];
        if (!onScreen(st.x, st.y, st.r * 3)) continue;
        for (const sat of st.sats) {
          const d = sat.size * 1.9 * cam.s;
          if (d < 1.4) continue;
          const [sx, sy] = this.w2s(sat.x, sat.y);
          ctx.globalAlpha = a;
          ctx.drawImage(glowSprite(sat.color), sx - d / 2, sy - d / 2, d, d);
        }
      }
    }

    // Neuron cores: glow sprites with twinkle + execution wake boost.
    for (let i = 0; i < this.stars.length; i++) {
      const st = this.stars[i];
      const boost = this.focusId === st.neuron.id ? 0 : this.glow.get(st.neuron.id) ?? 0;
      const alpha = (this.starAlpha[i] + boost * 0.9) * (0.82 + 0.18 * Math.sin(t * 1.3 + st.phase));
      if (alpha <= 0.015) continue;
      if (!onScreen(st.x, st.y, st.r * 3)) continue;
      const [sx, sy] = this.w2s(st.x, st.y);
      const d = st.r * 2.9 * cam.s * (1 + boost * 0.35);
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(glowSprite(st.color), sx - d / 2, sy - d / 2, d, d);
      if (boost > 0.02) {
        ctx.globalAlpha = Math.min(1, boost * 0.55);
        ctx.drawImage(glowSprite('#ffffff'), sx - d / 2, sy - d / 2, d, d);
      }
      if (st.neuron.id === this.hoveredId && !this.focusId) {
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = toward(st.color, '#ffffff', 0.5);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(sx, sy, d * 0.32 + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Crisp text goes on top, normal compositing.
    ctx.globalCompositeOperation = 'source-over';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    // Behaviour names, once stars are big enough to own one.
    if (cam.s > 3 && this.focusEase < 0.8) {
      ctx.font = '500 11px Inter, "Segoe UI", system-ui, sans-serif';
      for (let i = 0; i < this.stars.length; i++) {
        const st = this.stars[i];
        const d = st.r * 2.9 * cam.s;
        if (d < 30 || this.starAlpha[i] < 0.25) continue;
        if (!onScreen(st.x, st.y, st.r * 3)) continue;
        const [sx, sy] = this.w2s(st.x, st.y);
        const a = Math.min(0.9, (d - 30) / 40) * this.starAlpha[i] * (1 - this.focusEase);
        ctx.globalAlpha = a;
        ctx.fillStyle = '#dbe4ff';
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 6;
        ctx.fillText(st.neuron.name, sx, sy + d * 0.34 + 14);
        ctx.shadowBlur = 0;
      }
    }

    // Section labels above each galaxy.
    const labelAlpha = 1 - this.focusEase;
    if (labelAlpha > 0.02 && this.groupGeo.length > 1) {
      for (const g of this.groupGeo) {
        const y = g.y - g.radius - 3;
        if (!onScreen(g.x, y, 6)) continue;
        const [sx, sy] = this.w2s(g.x, y);
        ctx.globalAlpha = labelAlpha;
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 8;
        ctx.font = '600 13px Inter, "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = toward(g.color, '#ffffff', 0.35);
        ctx.fillText(g.label, sx, sy - 14);
        ctx.font = '400 10px Inter, "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = '#8a97bf';
        ctx.fillText(`${g.count} behaviour${g.count === 1 ? '' : 's'}`, sx, sy);
        ctx.shadowBlur = 0;
      }
    }

    // The focused behaviour's actual graph, on top of the dimmed web.
    this.flowGraph?.draw(ctx, this.w2s, cam.s, this.focusEase);
    ctx.globalAlpha = 1;
  }
}
