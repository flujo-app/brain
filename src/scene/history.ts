import {
  AdditiveBlending,
  BufferGeometry,
  Clock,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  FogExp2,
  Group,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Points,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import type { BrainGraph, NodeChatMessage } from '../types';
import type { BrainActivityEvent } from '../data/execution';
import { flujoBase } from '../data/loader';
import { listConversations, fetchTranscript, type StoredConversation, type TranscriptStep } from '../data/conversations';
import { BACKGROUND, providerColor } from '../theme';
import { glowTexture } from './textures';
import { createStarfield } from './starfield';
import { LabelLayer } from './labels';
import { ChatBubbleLayer } from '../ui/bubbles';
import type { Hud } from '../ui/hud';

const FOV = 55;
const EAGER_TRANSCRIPTS = 24; // newest conversations whose threads load up front
const MAX_STEPS_SHOWN = 48; // per-thread cap; the label carries the true count
const STEP_SPACING = 2.3;
const REPLAY_INTERVAL_MS = 1600;

/** The same twinkling additive point sprite the neuron view uses. */
const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aPhase;
  attribute vec3 aColor;
  uniform float uScale;
  uniform float uTime;
  uniform float uFogDensity;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFog;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha * (0.82 + 0.18 * sin(uTime * 1.3 + aPhase));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float fd = -mv.z * uFogDensity;
    vFog = exp(-fd * fd);
    gl_PointSize = aSize * uScale / -mv.z;
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

const ROLE_COLORS = {
  user: new Color(0xffd27d), // the outside voice — warm gold
  tool: new Color(0x4d8df6), // ability at work — FLUJO's mcp blue
} as const;
const FORGOTTEN = new Color(0x5a6480); // conversations of deleted behaviours

interface Thread {
  conv: StoredConversation;
  steps: TranscriptStep[];
  /** World position per rendered step (last MAX_STEPS_SHOWN of steps). */
  positions: Vector3[];
  /** The constellation core (thread head) — label + live-bubble anchor. */
  core: Vector3;
  flowName: string;
  color: Color;
  elided: number;
}

interface PointMeta {
  threadIdx: number;
  /** -1 = the conversation core, otherwise index into thread.positions. */
  stepIdx: number;
  base: number; // resting alpha
}

/** Clickable floating name tags, one per conversation constellation. */
class ConvLabels extends LabelLayer {
  constructor(threads: Thread[], onPick: (threadIdx: number) => void) {
    super(true);
    threads.forEach((t, i) => {
      const el = this.add(
        t.core.clone().add(new Vector3(0, 2.6, 0)),
        'conv-label',
        `<span class="t">${esc(shorten(t.conv.title, 38))}</span>` +
          `<span class="m">${esc(t.flowName)} · ${t.steps.length ? `${t.steps.length} steps` : t.conv.status || '…'} · ${relTime(t.conv.updatedAt)}</span>`,
      );
      el.style.setProperty('--c', '#' + t.color.getHexString());
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        onPick(i);
      });
    });
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function shorten(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function relTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (!Number.isFinite(s) || s < 0 || !ms) return '';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Deterministic tiny jitter so strands look organic but stable across builds. */
function jitter(seed: number): number {
  return (((seed * 2654435761) % 1000) / 1000 - 0.5) * 2;
}

/**
 * The brain's memory as a night sky: every stored conversation is a
 * constellation — a strand of twinkling steps (gold = the outside voice,
 * behaviour-coloured = the brain speaking, blue = abilities at work) flowing
 * outward from its core. Newest conversations sit at the centre of the
 * spiral; faint arcs chain consecutive conversations of the same behaviour
 * (the heartbeat's thread of life). Click a constellation to replay it as
 * floating chat bubbles.
 *
 * Same renderer contract as Brain/Brain2D so main.ts can swap it in:
 * setGraph / setConversation / handleExecution / dispose.
 */
export class HistoryView {
  private renderer: WebGLRenderer;
  private composer: EffectComposer;
  private scene = new Scene();
  private camera: PerspectiveCamera;
  private controls: OrbitControls;
  private clock = new Clock();
  private raycaster = new Raycaster();
  private pointer = new Vector2(-2, -2);
  private hasPointer = false;

  private content = new Group();
  private material: ShaderMaterial;
  private points: Points | null = null;
  private pointMeta: PointMeta[] = [];
  private alphaAttr: Float32BufferAttribute | null = null;
  private labels: ConvLabels | null = null;
  private bubbles = new ChatBubbleLayer();
  private v = new Vector3();

  private threads: Thread[] = [];
  private transcripts = new Map<string, TranscriptStep[]>();
  private focusIdx: number | null = null;
  private searchSet: Set<number> | null = null;
  private dirty = false;

  private replayTimer: number | null = null;
  private refreshTimer: number | null = null;
  private pollTimer: number | null = null;
  private disposed = false;
  private emptyNote: HTMLDivElement;

  private targetLookAt = new Vector3();
  private lookLerp = 1;

  private onWindowResize = () => this.resize();
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.clearFocus();
  };

  constructor(private canvas: HTMLCanvasElement, private graph: BrainGraph, private hud: Hud) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(BACKGROUND, 1);

    this.camera = new PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 4000);
    this.camera.position.set(0, 34, 92);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.rotateSpeed = 0.55;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.18;
    this.controls.screenSpacePanning = true;

    this.scene.fog = new FogExp2(BACKGROUND, 0.0022);
    this.scene.add(createStarfield(1600, 900));
    this.scene.add(this.content);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new Vector2(1, 1), 0.32, 0.4, 0.55));

    this.material = new ShaderMaterial({
      uniforms: {
        uTex: { value: glowTexture() },
        uScale: { value: 600 },
        uTime: { value: 0 },
        uFogDensity: { value: 0.0022 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.raycaster.params.Points = { threshold: 1.7 };

    this.emptyNote = document.createElement('div');
    this.emptyNote.className = 'hist-empty hidden';
    document.body.appendChild(this.emptyNote);

    this.wireHud();
    this.wireInput();
    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('keydown', this.onKeyDown);
    this.resize();

    void this.loadAll();
    // Catch conversations created outside execution events (other clients).
    this.pollTimer = window.setInterval(() => void this.loadAll(true), 30_000);

    this.renderer.setAnimationLoop(() => this.frame());
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.replayTimer !== null) window.clearTimeout(this.replayTimer);
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.clearContent();
    this.labels?.dispose();
    this.bubbles.dispose();
    this.emptyNote.remove();
    this.controls.dispose();
    this.composer.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.hud.hideTooltip();
  }

  // ---- renderer contract ----------------------------------------------------

  setGraph(graph: BrainGraph): void {
    this.graph = graph;
    this.build(); // behaviour names/colours may have changed
  }

  /** The chat dock's conversation targets flow nodes — nothing to pin here. */
  setConversation(_msgs: NodeChatMessage[]): void {}

  handleExecution(e: BrainActivityEvent): void {
    if (e.kind === 'message' && e.text) {
      const idx = this.threads.findIndex((t) => t.conv.id === e.conversationId);
      if (idx >= 0) {
        const t = this.threads[idx];
        this.bubbles.push(`${t.conv.id}:live`, t.flowName, e.text);
      }
    }
    if (e.kind === 'run-done' || e.kind === 'run-start') {
      // A conversation just appeared or grew — refresh soon (debounced).
      if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null;
        this.transcripts.delete(e.conversationId);
        void this.loadAll(true);
      }, 1500);
    }
  }

  // ---- data -----------------------------------------------------------------

  private async loadAll(silent = false): Promise<void> {
    const base = flujoBase();
    if (!base) {
      if (!silent) this.showEmpty('waiting for FLUJO…');
      return;
    }
    let list: StoredConversation[];
    try {
      list = await listConversations(base);
    } catch {
      if (!silent) this.showEmpty('could not read the stored conversations.');
      return;
    }
    if (this.disposed) return;

    // Newest first; eager transcripts for the front of the sky.
    const eager = list.slice(0, EAGER_TRANSCRIPTS).filter((c) => !this.transcripts.has(c.id));
    const queue = [...eager];
    const worker = async () => {
      for (let c = queue.shift(); c && !this.disposed; c = queue.shift()) {
        try {
          this.transcripts.set(c.id, await fetchTranscript(base, c.id));
        } catch {
          this.transcripts.set(c.id, []);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    if (this.disposed) return;

    this.threads = list.map((conv) => this.makeThread(conv));
    this.layoutThreads();
    this.build();
    if (!list.length) this.showEmpty('no stored conversations yet — talk to the brain, or let the heartbeat run.');
    else this.emptyNote.classList.add('hidden');
  }

  private flowInfo(flowId: string | null): { name: string; color: Color } {
    const n = flowId ? this.graph.neurons.find((x) => x.id === flowId) : undefined;
    if (!n) return { name: 'forgotten behaviour', color: FORGOTTEN.clone() };
    return { name: n.name, color: providerColor(n.providers) };
  }

  private makeThread(conv: StoredConversation): Thread {
    const { name, color } = this.flowInfo(conv.flowId);
    const steps = this.transcripts.get(conv.id) ?? [];
    return { conv, steps, positions: [], core: new Vector3(), flowName: name, color, elided: Math.max(0, steps.length - MAX_STEPS_SHOWN) };
  }

  // ---- layout ---------------------------------------------------------------

  /**
   * Golden-angle spiral of constellations, newest at the centre. Each thread
   * flows outward along the spiral's local tangent with a gentle sine sway,
   * so long conversations read as drifting strands rather than rows.
   */
  private layoutThreads(): void {
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    this.threads.forEach((t, i) => {
      const a = i * GOLDEN;
      const r = 14 + i * 3.1;
      const anchor = new Vector3(Math.cos(a) * r, Math.sin(i * 1.7) * 6.5, Math.sin(a) * r);
      const dir = new Vector3(-Math.sin(a), 0, Math.cos(a)); // spiral tangent
      const side = new Vector3(Math.cos(a), 0, Math.sin(a)); // outward
      t.core.copy(anchor);
      const shown = t.steps.slice(-MAX_STEPS_SHOWN);
      t.positions = shown.map((_, k) => {
        const sway = Math.sin(k * 0.55 + i) * 1.5;
        return anchor
          .clone()
          .addScaledVector(dir, (k + 1) * STEP_SPACING)
          .addScaledVector(side, sway)
          .add(new Vector3(0, jitter(i * 131 + k * 7) * 1.6, jitter(i * 17 + k * 29) * 1.2));
      });
    });
  }

  // ---- scene build ----------------------------------------------------------

  private clearContent(): void {
    for (const child of [...this.content.children]) {
      this.content.remove(child);
      const obj = child as Points | LineSegments;
      obj.geometry?.dispose();
      if (obj !== this.points && obj.material && obj.material !== this.material) {
        (obj.material as LineBasicMaterial).dispose();
      }
    }
    this.points = null;
    this.pointMeta = [];
    this.alphaAttr = null;
  }

  private build(): void {
    this.stopReplay();
    this.clearContent();
    this.labels?.dispose();

    const pos: number[] = [];
    const col: number[] = [];
    const size: number[] = [];
    const alpha: number[] = [];
    const phase: number[] = [];
    const linePos: number[] = [];
    const lineCol: number[] = [];
    const chainPos: number[] = [];

    const lastOfFlow = new Map<string, Vector3>(); // for the chrono chain, walking newest -> oldest

    this.threads.forEach((t, i) => {
      // The constellation core.
      this.pointMeta.push({ threadIdx: i, stepIdx: -1, base: 0.95 });
      pos.push(t.core.x, t.core.y, t.core.z);
      col.push(t.color.r, t.color.g, t.color.b);
      size.push(3.4);
      alpha.push(0.95);
      phase.push((i * 12.9898) % 6.28);

      let prev = t.core;
      t.positions.forEach((p, k) => {
        const step = t.steps[t.steps.length - Math.min(t.steps.length, MAX_STEPS_SHOWN) + k];
        const c = step.role === 'assistant' ? t.color : ROLE_COLORS[step.role];
        this.pointMeta.push({ threadIdx: i, stepIdx: k, base: step.role === 'tool' ? 0.55 : 0.85 });
        pos.push(p.x, p.y, p.z);
        col.push(c.r, c.g, c.b);
        size.push(step.role === 'user' ? 1.7 : step.role === 'tool' ? 1.05 : 2.0);
        alpha.push(step.role === 'tool' ? 0.55 : 0.85);
        phase.push(((i * 31 + k * 17) % 628) / 100);

        linePos.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        const lc = t.color;
        lineCol.push(lc.r, lc.g, lc.b, c.r, c.g, c.b);
        prev = p;
      });

      // Thread of life: chain this conversation to the NEXT-newer one of the
      // same behaviour (threads are sorted newest-first, so the map holds it).
      if (t.conv.flowId) {
        const newer = lastOfFlow.get(t.conv.flowId);
        const tail = t.positions[t.positions.length - 1] ?? t.core;
        if (newer) chainPos.push(tail.x, tail.y, tail.z, newer.x, newer.y, newer.z);
        lastOfFlow.set(t.conv.flowId, t.core);
      }
    });

    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new Float32BufferAttribute(col, 3));
    geo.setAttribute('aSize', new Float32BufferAttribute(size, 1));
    this.alphaAttr = new Float32BufferAttribute(alpha, 1);
    this.alphaAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setAttribute('aPhase', new Float32BufferAttribute(phase, 1));
    this.points = new Points(geo, this.material);
    this.content.add(this.points);

    const threadGeo = new BufferGeometry();
    threadGeo.setAttribute('position', new Float32BufferAttribute(linePos, 3));
    threadGeo.setAttribute('color', new Float32BufferAttribute(lineCol, 3));
    this.content.add(
      new LineSegments(
        threadGeo,
        new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, blending: AdditiveBlending, depthWrite: false }),
      ),
    );

    const chainGeo = new BufferGeometry();
    chainGeo.setAttribute('position', new Float32BufferAttribute(chainPos, 3));
    this.content.add(
      new LineSegments(
        chainGeo,
        new LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.1, blending: AdditiveBlending, depthWrite: false }),
      ),
    );

    this.labels = new ConvLabels(this.threads, (idx) => this.focusThread(idx, true));
    this.dirty = true;
  }

  private showEmpty(text: string): void {
    this.emptyNote.textContent = text;
    this.emptyNote.classList.remove('hidden');
  }

  // ---- focus / search / replay ----------------------------------------------

  private focusThread(idx: number, replay: boolean): void {
    this.focusIdx = idx;
    this.dirty = true;
    const t = this.threads[idx];
    const mid = t.positions[Math.floor(t.positions.length / 2)] ?? t.core;
    this.targetLookAt.copy(mid);
    this.lookLerp = 0;
    // Constellations beyond the eager window are lone cores until first
    // opened — fetch the transcript, grow the thread, then continue.
    if (!t.steps.length && !this.transcripts.has(t.conv.id)) {
      void this.loadThread(t.conv.id, replay);
      return;
    }
    if (replay) this.startReplay(idx);
  }

  private async loadThread(conversationId: string, replay: boolean): Promise<void> {
    const base = flujoBase();
    if (!base) return;
    try {
      this.transcripts.set(conversationId, await fetchTranscript(base, conversationId));
    } catch {
      this.transcripts.set(conversationId, []);
    }
    if (this.disposed) return;
    // Rebuild in place (conversation order is unchanged, so focusIdx holds).
    this.threads = this.threads.map((th) => this.makeThread(th.conv));
    this.layoutThreads();
    this.build();
    const idx = this.threads.findIndex((th) => th.conv.id === conversationId);
    if (idx >= 0 && this.focusIdx === idx && replay) this.startReplay(idx);
  }

  private clearFocus(): void {
    this.focusIdx = null;
    this.dirty = true;
    this.stopReplay();
    this.targetLookAt.set(0, 0, 0);
    this.lookLerp = 0;
  }

  private startReplay(idx: number): void {
    this.stopReplay();
    const t = this.threads[idx];
    const shown = t.steps.slice(-MAX_STEPS_SHOWN);
    let k = 0;
    const tick = () => {
      if (this.disposed || this.focusIdx !== idx) return;
      const step = shown[k];
      if (!step) {
        this.replayTimer = null;
        return;
      }
      const who = step.role === 'user' ? 'you' : step.role === 'tool' ? `${t.flowName} · ability` : t.flowName;
      this.bubbles.push(`${t.conv.id}:${k}`, who, step.text);
      k++;
      this.replayTimer = window.setTimeout(tick, REPLAY_INTERVAL_MS);
    };
    tick();
  }

  private stopReplay(): void {
    if (this.replayTimer !== null) {
      window.clearTimeout(this.replayTimer);
      this.replayTimer = null;
    }
  }

  private applySpotlight(): void {
    if (!this.alphaAttr) return;
    const arr = this.alphaAttr.array as Float32Array;
    this.pointMeta.forEach((m, i) => {
      const inSearch = !this.searchSet || this.searchSet.has(m.threadIdx);
      if (this.focusIdx !== null) arr[i] = m.threadIdx === this.focusIdx ? Math.min(m.base * 1.4, 1.3) : 0.05;
      else arr[i] = inSearch ? m.base : 0.05;
    });
    this.alphaAttr.needsUpdate = true;
    this.labels?.setHidden(false);
  }

  private applySearch(q: string): void {
    if (!q) {
      this.searchSet = null;
    } else {
      this.searchSet = new Set(
        this.threads
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => t.conv.title.toLowerCase().includes(q) || t.flowName.toLowerCase().includes(q))
          .map(({ i }) => i),
      );
    }
    this.dirty = true;
  }

  // ---- input / hud ------------------------------------------------------------

  private wireHud(): void {
    this.hud.onSearch = (q) => this.applySearch(q);
    this.hud.onCloseFocus = () => this.clearFocus();
    // Neuron-view controls that make no sense here become no-ops, so stale
    // closures of a disposed renderer can never fire.
    this.hud.onToggleKind = () => {};
    this.hud.onGroupMode = () => {};
    this.hud.onFollow = () => {};
    this.hud.onBackToBehaviour = () => {};
    this.hud.onFocusBehaviour = () => {};
  }

  private wireInput(): void {
    let downAt: { x: number; y: number } | null = null;
    this.canvas.addEventListener('pointermove', (e) => {
      this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
      this.hasPointer = true;
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      downAt = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 5) return; // a drag, not a click
      const hit = this.pick();
      if (hit === null) this.clearFocus();
      else this.focusThread(this.pointMeta[hit].threadIdx, this.pointMeta[hit].stepIdx === -1);
    });
  }

  private pick(): number | null {
    if (!this.points || !this.hasPointer) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.points, false);
    return hits.length ? hits[0].index ?? null : null;
  }

  private updateHover(): void {
    const hit = this.pick();
    if (hit === null) {
      this.hud.hideTooltip();
      return;
    }
    const m = this.pointMeta[hit];
    const t = this.threads[m.threadIdx];
    const x = (this.pointer.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this.pointer.y * 0.5 + 0.5) * window.innerHeight;
    if (m.stepIdx === -1) {
      this.hud.showTooltip(`${t.conv.title} · ${t.flowName} · ${relTime(t.conv.updatedAt)}`, x, y);
    } else {
      const step = t.steps[t.steps.length - Math.min(t.steps.length, MAX_STEPS_SHOWN) + m.stepIdx];
      const who = step.role === 'user' ? 'you' : step.role === 'tool' ? 'ability' : t.flowName;
      this.hud.showTooltip(`${who} · ${shorten(step.text.replace(/\s+/g, ' '), 90)}`, x, y);
    }
  }

  // ---- frame ------------------------------------------------------------------

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.material.uniforms.uScale.value = h / (2 * Math.tan((FOV * Math.PI) / 360));
  }

  private frame(): void {
    const dt = this.clock.getDelta();
    this.controls.update();
    this.material.uniforms.uTime.value = this.clock.elapsedTime;
    this.updateHover();

    if (this.dirty) {
      this.applySpotlight();
      this.dirty = false;
    }

    if (this.lookLerp < 1) {
      this.lookLerp = Math.min(1, this.lookLerp + dt * 1.2);
      this.controls.target.lerp(this.targetLookAt, 0.08);
    }

    this.labels?.update(this.camera, window.innerWidth, window.innerHeight);
    this.bubbles.update((key) => {
      const anchor = this.bubbleAnchor(key);
      if (!anchor) return null;
      this.v.copy(anchor).project(this.camera);
      if (this.v.z > 1) return null;
      return { x: (this.v.x * 0.5 + 0.5) * window.innerWidth, y: (-this.v.y * 0.5 + 0.5) * window.innerHeight };
    });
    this.composer.render();
  }

  /** Bubble keys are `<conversationId>:<stepIdx|live>` — resolve to world space. */
  private bubbleAnchor(key: string): Vector3 | null {
    const sep = key.lastIndexOf(':');
    if (sep < 0) return null;
    const t = this.threads.find((x) => x.conv.id === key.slice(0, sep));
    if (!t) return null;
    const tag = key.slice(sep + 1);
    if (tag === 'live') return t.core;
    return t.positions[Number(tag)] ?? t.core;
  }
}
