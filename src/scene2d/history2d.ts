import type { BrainGraph, NodeChatMessage } from '../types';
import type { BrainActivityEvent } from '../data/execution';
import { flujoBase } from '../data/loader';
import { listConversations, fetchTranscript, type StoredConversation, type TranscriptStep } from '../data/conversations';
import { splitToolName } from '../data/distill';
import { BACKGROUND, providerColor } from '../theme';
import { ChatBubbleLayer } from '../ui/bubbles';
import type { Hud } from '../ui/hud';
import { buildStarfield, glowSprite, toward } from './sprites';

const EAGER_TRANSCRIPTS = 24; // newest conversations whose threads load up front
const MAX_STEPS_SHOWN = 48; // per-thread cap; the label carries the true count
const STEP_SPACING = 2.3;
const REPLAY_INTERVAL_MS = 1600;

const BG = '#' + BACKGROUND.toString(16).padStart(6, '0');
const ROLE_COLORS = {
  user: '#ffd27d', // the outside voice — warm gold
  tool: '#4d8df6', // ability at work — FLUJO's mcp blue
} as const;
const FORGOTTEN = '#5a6480'; // conversations of deleted behaviours

interface P2 {
  x: number;
  y: number;
}

interface Thread {
  conv: StoredConversation;
  steps: TranscriptStep[];
  /** World position per rendered step (last MAX_STEPS_SHOWN of steps). */
  positions: P2[];
  /** The constellation core (thread head) — label + live-bubble anchor. */
  core: P2;
  flowName: string;
  color: string;
  elided: number;
}

interface Dot {
  threadIdx: number;
  /** -1 = the conversation core, otherwise index into thread.positions. */
  stepIdx: number;
  x: number;
  y: number;
  size: number; // world size (matches the 3D aSize values)
  color: string;
  base: number; // resting alpha
  phase: number;
}

interface CamGoal {
  x: number;
  y: number;
  s: number;
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
 * The brain's memory as a night sky, drawn with the Canvas 2D API: every
 * stored conversation is a constellation — a strand of twinkling steps
 * (gold = the outside voice, behaviour-coloured = the brain speaking,
 * blue = abilities at work) flowing outward from its core. Newest
 * conversations sit at the centre of the spiral; faint arcs chain
 * consecutive conversations of the same behaviour (the heartbeat's thread
 * of life). Click a constellation to replay it as floating chat bubbles.
 *
 * Same renderer contract as Brain/Brain2D so main.ts can swap it in:
 * setGraph / setConversation / handleExecution / dispose.
 */
export class History2D {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private starLayer!: HTMLCanvasElement;

  // Camera: world-space centre + scale (screen px per world unit).
  private cam = { x: 0, y: 0, s: 4 };
  private camGoal: CamGoal | null = null;
  private overviewScale = 4;

  private threads: Thread[] = [];
  private dots: Dot[] = [];
  /** Chrono chain segments (same-behaviour conversations), world space. */
  private chains: Array<{ a: P2; b: P2 }> = [];
  /** Screen-space label boxes from the last draw, for click/hover hit tests. */
  private labelRects: Array<{ x1: number; y1: number; x2: number; y2: number; idx: number }> = [];
  private transcripts = new Map<string, TranscriptStep[]>();
  private focusIdx: number | null = null;
  private searchSet: Set<number> | null = null;
  /** Spotlight only this behaviour's conversations (chat-dock history mode). */
  private flowFilter: string | null = null;
  private bubbles = new ChatBubbleLayer();
  /** "continue in chat" on the focused conversation. Wired by main.ts. */
  onContinue: (conversationId: string) => void = () => {};
  private continueBtn: HTMLButtonElement;

  private replayTimer: number | null = null;
  private refreshTimer: number | null = null;
  private pollTimer: number | null = null;
  private disposed = false;
  private emptyNote: HTMLDivElement;

  // Pointer state.
  private pointers = new Map<number, { x: number; y: number }>();
  private downAt = { x: 0, y: 0 };
  private dragged = false;
  private lastPointer = { x: 0, y: 0 };
  private hasPointer = false;
  private pinchDist = 0;

  private needsDraw = true;
  private raf = 0;
  private lastT = 0;
  private lastDrawT = 0;
  private onResize = () => this.resize();
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.clearFocus();
  };

  constructor(private canvas: HTMLCanvasElement, private graph: BrainGraph, private hud: Hud) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;

    this.emptyNote = document.createElement('div');
    this.emptyNote.className = 'hist-empty hidden';
    document.body.appendChild(this.emptyNote);

    this.continueBtn = document.createElement('button');
    this.continueBtn.className = 'hist-continue hidden';
    this.continueBtn.addEventListener('click', () => {
      if (this.focusIdx !== null) this.onContinue(this.threads[this.focusIdx].conv.id);
    });
    document.body.appendChild(this.continueBtn);

    this.resize();
    this.wireHud();
    this.wireInput();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);

    void this.loadAll();
    // Catch conversations created outside execution events (other clients).
    this.pollTimer = window.setInterval(() => void this.loadAll(true), 30_000);

    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.replayTimer !== null) window.clearTimeout(this.replayTimer);
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.bubbles.dispose();
    this.emptyNote.remove();
    this.continueBtn.remove();
    this.hud.hideTooltip();
  }

  /**
   * Spotlight one behaviour's conversations (the chat dock's graphical
   * history). Cleared by clicking empty space, like a focus.
   */
  filterFlow(flowId: string | null): void {
    this.flowFilter = flowId;
    this.focusIdx = null;
    this.stopReplay();
    this.syncContinueBtn();
    this.frameFiltered();
    this.needsDraw = true;
  }

  /** Fly to frame the filtered constellations (all of them when no filter). */
  private frameFiltered(): void {
    if (!this.flowFilter) {
      this.frameOverview();
      return;
    }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const t of this.threads) {
      if (t.conv.flowId !== this.flowFilter) continue;
      for (const p of [t.core, ...t.positions]) {
        x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
        x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
      }
    }
    if (x1 > x2) return; // nothing stored for this behaviour (yet)
    const s = Math.min(
      60,
      Math.max(this.overviewScale * 0.5, Math.min((this.w * 0.8) / Math.max(x2 - x1, 6), (this.h * 0.7) / Math.max(y2 - y1, 6))),
    );
    this.camGoal = { x: (x1 + x2) / 2, y: (y1 + y2) / 2, s };
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
    if (e.kind === 'tool-call' && e.toolName) {
      const t = this.threads.find((x) => x.conv.id === e.conversationId);
      if (t) {
        const { server, tool } = splitToolName(e.toolName);
        this.bubbles.push(`${t.conv.id}:live`, '', `⚙ ${server ? `${server} · ` : ''}${tool}`, { pill: true });
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

    const firstBuild = !this.threads.length;
    this.threads = list.map((conv) => this.makeThread(conv));
    this.layoutThreads();
    this.build();
    if (firstBuild) this.frameOverview(true);
    if (!list.length) this.showEmpty('no stored conversations yet — talk to the brain, or let the heartbeat run.');
    else this.emptyNote.classList.add('hidden');
  }

  private flowInfo(flowId: string | null): { name: string; color: string } {
    const n = flowId ? this.graph.neurons.find((x) => x.id === flowId) : undefined;
    if (!n) return { name: 'forgotten behaviour', color: FORGOTTEN };
    return { name: n.name, color: '#' + providerColor(n.providers).getHexString() };
  }

  private makeThread(conv: StoredConversation): Thread {
    const { name, color } = this.flowInfo(conv.flowId);
    const steps = this.transcripts.get(conv.id) ?? [];
    return { conv, steps, positions: [], core: { x: 0, y: 0 }, flowName: name, color, elided: Math.max(0, steps.length - MAX_STEPS_SHOWN) };
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
      const anchor = { x: Math.cos(a) * r, y: Math.sin(a) * r };
      const dir = { x: -Math.sin(a), y: Math.cos(a) }; // spiral tangent
      const side = { x: Math.cos(a), y: Math.sin(a) }; // outward
      t.core = anchor;
      const shown = t.steps.slice(-MAX_STEPS_SHOWN);
      t.positions = shown.map((_, k) => {
        const sway = Math.sin(k * 0.55 + i) * 1.5;
        return {
          x: anchor.x + dir.x * (k + 1) * STEP_SPACING + side.x * sway + jitter(i * 131 + k * 7) * 1.2,
          y: anchor.y + dir.y * (k + 1) * STEP_SPACING + side.y * sway + jitter(i * 17 + k * 29) * 1.2,
        };
      });
    });
  }

  // ---- scene build ----------------------------------------------------------

  private build(): void {
    this.stopReplay();
    this.dots = [];
    this.chains = [];

    const lastOfFlow = new Map<string, P2>(); // for the chrono chain, walking newest -> oldest

    this.threads.forEach((t, i) => {
      // The constellation core.
      this.dots.push({ threadIdx: i, stepIdx: -1, x: t.core.x, y: t.core.y, size: 3.4, color: t.color, base: 0.95, phase: (i * 12.9898) % 6.28 });

      t.positions.forEach((p, k) => {
        const step = t.steps[t.steps.length - Math.min(t.steps.length, MAX_STEPS_SHOWN) + k];
        this.dots.push({
          threadIdx: i,
          stepIdx: k,
          x: p.x,
          y: p.y,
          size: step.role === 'user' ? 1.7 : step.role === 'tool' ? 1.05 : 2.0,
          color: step.role === 'assistant' ? t.color : ROLE_COLORS[step.role],
          base: step.role === 'tool' ? 0.55 : 0.85,
          phase: ((i * 31 + k * 17) % 628) / 100,
        });
      });

      // Thread of life: chain this conversation to the NEXT-newer one of the
      // same behaviour (threads are sorted newest-first, so the map holds it).
      if (t.conv.flowId) {
        const newer = lastOfFlow.get(t.conv.flowId);
        const tail = t.positions[t.positions.length - 1] ?? t.core;
        if (newer) this.chains.push({ a: tail, b: newer });
        lastOfFlow.set(t.conv.flowId, t.core);
      }
    });

    this.needsDraw = true;
  }

  private showEmpty(text: string): void {
    this.emptyNote.textContent = text;
    this.emptyNote.classList.remove('hidden');
  }

  // ---- focus / search / replay ----------------------------------------------

  /** Spotlight multiplier for a thread under the current focus / search / filter. */
  private spotFor(i: number): number {
    if (this.flowFilter && this.threads[i].conv.flowId !== this.flowFilter) return 0.04;
    if (this.focusIdx !== null) return i === this.focusIdx ? 1.3 : 0.06;
    if (this.searchSet) return this.searchSet.has(i) ? 1 : 0.06;
    return 1;
  }

  /** Show / hide the "continue in chat" chip for the focused conversation. */
  private syncContinueBtn(): void {
    const t = this.focusIdx !== null ? this.threads[this.focusIdx] : null;
    this.continueBtn.classList.toggle('hidden', !t);
    if (t) this.continueBtn.textContent = `💬 continue “${shorten(t.conv.title, 42)}”`;
  }

  private focusThread(idx: number, replay: boolean): void {
    this.focusIdx = idx;
    this.needsDraw = true;
    this.syncContinueBtn();
    this.flyToThread(idx);
    const t = this.threads[idx];
    // Constellations beyond the eager window are lone cores until first
    // opened — fetch the transcript, grow the thread, then continue.
    if (!t.steps.length && !this.transcripts.has(t.conv.id)) {
      void this.loadThread(t.conv.id, replay);
      return;
    }
    if (replay) this.startReplay(idx);
  }

  /** Fly the camera to frame the whole constellation. */
  private flyToThread(idx: number): void {
    const t = this.threads[idx];
    const pts = [t.core, ...t.positions];
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of pts) {
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
    }
    const s = Math.min(
      60,
      Math.max(this.overviewScale, Math.min((this.w * 0.7) / Math.max(x2 - x1, 4), (this.h * 0.6) / Math.max(y2 - y1, 4))),
    );
    this.camGoal = { x: (x1 + x2) / 2, y: (y1 + y2) / 2, s };
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
    if (idx >= 0 && this.focusIdx === idx) {
      this.flyToThread(idx);
      if (replay) this.startReplay(idx);
    }
  }

  private clearFocus(): void {
    if (this.focusIdx === null && !this.searchSet) {
      // No focus to clear: first Esc/click lifts the behaviour filter…
      if (this.flowFilter) {
        this.filterFlow(null);
        return;
      }
      // …otherwise a click on empty space still reframes the sky.
      const drifted =
        Math.abs(this.cam.s - this.overviewScale) / this.overviewScale > 0.3 ||
        Math.hypot(this.cam.x, this.cam.y) * this.overviewScale > Math.min(this.w, this.h) * 0.25;
      if (drifted) this.frameOverview();
      return;
    }
    this.focusIdx = null;
    this.stopReplay();
    this.syncContinueBtn();
    if (this.flowFilter) this.frameFiltered();
    else this.frameOverview();
    this.needsDraw = true;
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
    this.needsDraw = true;
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
    // A search hit here spotlights that behaviour's conversations in the sky.
    this.hud.onFocusBehaviour = (id) => this.filterFlow(id);
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

  // ---- picking ----------------------------------------------------------------

  private w2s = (wx: number, wy: number): [number, number] => [
    this.w / 2 + (wx - this.cam.x) * this.cam.s,
    this.h / 2 + (wy - this.cam.y) * this.cam.s,
  ];

  private s2w(sx: number, sy: number): [number, number] {
    return [this.cam.x + (sx - this.w / 2) / this.cam.s, this.cam.y + (sy - this.h / 2) / this.cam.s];
  }

  private pickLabel(sx: number, sy: number): number | null {
    for (const r of this.labelRects) {
      if (sx >= r.x1 && sx <= r.x2 && sy >= r.y1 && sy <= r.y2) return r.idx;
    }
    return null;
  }

  private pickDot(sx: number, sy: number): number | null {
    let best: number | null = null;
    let bestD = Infinity;
    for (let i = 0; i < this.dots.length; i++) {
      const dot = this.dots[i];
      if (this.spotFor(dot.threadIdx) <= 0.1) continue;
      const [x, y] = this.w2s(dot.x, dot.y);
      const d = Math.hypot(sx - x, sy - y);
      const rPick = Math.max(dot.size * 1.3 * this.cam.s, 10);
      if (d <= rPick && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private handleClick(sx: number, sy: number): void {
    const labelIdx = this.pickLabel(sx, sy);
    if (labelIdx !== null) {
      this.focusThread(labelIdx, true);
      return;
    }
    const hit = this.pickDot(sx, sy);
    if (hit === null) this.clearFocus();
    else this.focusThread(this.dots[hit].threadIdx, this.dots[hit].stepIdx === -1);
  }

  private updateHover(): void {
    if (!this.hasPointer || this.pointers.size > 0) return;
    const { x, y } = this.lastPointer;
    const labelIdx = this.pickLabel(x, y);
    const hit = labelIdx === null ? this.pickDot(x, y) : null;
    this.canvas.style.cursor = labelIdx !== null || hit !== null ? 'pointer' : 'default';
    if (labelIdx === null && hit === null) {
      this.hud.hideTooltip();
      return;
    }
    const m = hit !== null ? this.dots[hit] : null;
    const t = this.threads[m ? m.threadIdx : labelIdx!];
    if (!m || m.stepIdx === -1) {
      this.hud.showTooltip(`${t.conv.title} · ${t.flowName} · ${relTime(t.conv.updatedAt)}`, x, y);
    } else {
      const step = t.steps[t.steps.length - Math.min(t.steps.length, MAX_STEPS_SHOWN) + m.stepIdx];
      const who = step.role === 'user' ? 'you' : step.role === 'tool' ? 'ability' : t.flowName;
      this.hud.showTooltip(`${who} · ${shorten(step.text.replace(/\s+/g, ' '), 90)}`, x, y);
    }
  }

  // ---- frame ------------------------------------------------------------------

  private frameOverview(instant = false): void {
    let max = 10;
    for (const d of this.dots) max = Math.max(max, Math.hypot(d.x, d.y));
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

    // Bubbles are DOM, not canvas — they age and track their anchors every
    // frame even while the canvas itself skips redraws.
    this.bubbles.update((key) => {
      const anchor = this.bubbleAnchor(key);
      if (!anchor) return null;
      const [sx, sy] = this.w2s(anchor.x, anchor.y);
      return { x: sx, y: sy };
    });

    // Render on demand: full rate while something moves, a slow ambient tick
    // for the twinkle otherwise — near-zero idle cost.
    const animating = this.camGoal !== null || this.pointers.size > 0;
    const ambientDue = t - this.lastDrawT >= 0.05;
    if (!this.needsDraw && !animating && !ambientDue) return;
    this.needsDraw = false;
    this.lastDrawT = t;
    this.draw(t);
  }

  /** Bubble keys are `<conversationId>:<stepIdx|live>` — resolve to world space. */
  private bubbleAnchor(key: string): P2 | null {
    const sep = key.lastIndexOf(':');
    if (sep < 0) return null;
    const t = this.threads.find((x) => x.conv.id === key.slice(0, sep));
    if (!t) return null;
    const tag = key.slice(sep + 1);
    if (tag === 'live') return t.core;
    return t.positions[Number(tag)] ?? t.core;
  }

  // ---- drawing ----------------------------------------------------------------

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

    // Constellation strands: core -> step -> step, in the thread's colour.
    for (let i = 0; i < this.threads.length; i++) {
      const th = this.threads[i];
      if (!th.positions.length) continue;
      const spot = this.spotFor(i);
      if (spot <= 0.02) continue;
      const last = th.positions[th.positions.length - 1];
      const reach = Math.hypot(last.x - th.core.x, last.y - th.core.y);
      if (!onScreen(th.core.x, th.core.y, reach + 4)) continue;
      ctx.globalAlpha = Math.min(1, 0.3 * spot);
      ctx.strokeStyle = th.color;
      ctx.lineWidth = 1.05;
      ctx.beginPath();
      const [cx, cy] = this.w2s(th.core.x, th.core.y);
      ctx.moveTo(cx, cy);
      for (const p of th.positions) {
        const [px, py] = this.w2s(p.x, p.y);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Thread of life: faint amber arcs chaining a behaviour's conversations.
    if (this.chains.length && this.focusIdx === null) {
      ctx.globalAlpha = 0.1;
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const c of this.chains) {
        if (!onScreen((c.a.x + c.b.x) / 2, (c.a.y + c.b.y) / 2, Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y))) continue;
        const [ax, ay] = this.w2s(c.a.x, c.a.y);
        const [bx, by] = this.w2s(c.b.x, c.b.y);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }

    // The twinkling steps and cores.
    for (const dot of this.dots) {
      const alpha = Math.min(1, dot.base * this.spotFor(dot.threadIdx)) * (0.82 + 0.18 * Math.sin(t * 1.3 + dot.phase));
      if (alpha <= 0.015) continue;
      if (!onScreen(dot.x, dot.y, dot.size * 2)) continue;
      const [sx, sy] = this.w2s(dot.x, dot.y);
      const d = Math.max(3, dot.size * 2.6 * cam.s);
      ctx.globalAlpha = alpha;
      ctx.drawImage(glowSprite(dot.color), sx - d / 2, sy - d / 2, d, d);
    }

    // Crisp name tags on top, normal compositing, greedy overlap hiding.
    ctx.globalCompositeOperation = 'source-over';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    this.labelRects = [];
    const placed: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (let i = 0; i < this.threads.length; i++) {
      const th = this.threads[i];
      const spot = this.spotFor(i);
      if (spot <= 0.1) continue;
      if (!onScreen(th.core.x, th.core.y, 6)) continue;
      const [sx, syCore] = this.w2s(th.core.x, th.core.y);
      const sy = syCore - Math.max(6, 3.4 * 1.3 * cam.s);
      const title = shorten(th.conv.title, 38);
      const meta = `${th.flowName} · ${th.steps.length ? `${th.steps.length} steps` : th.conv.status || '…'} · ${relTime(th.conv.updatedAt)}`;
      ctx.font = '600 12.5px Inter, "Segoe UI", system-ui, sans-serif';
      const tw = ctx.measureText(title).width;
      ctx.font = '400 10px Inter, "Segoe UI", system-ui, sans-serif';
      const mw = ctx.measureText(meta).width;
      const bw = Math.max(tw, mw);
      const rect = { x1: sx - bw / 2 - 4, y1: sy - 30, x2: sx + bw / 2 + 4, y2: sy };
      if (placed.some((r) => rect.x1 < r.x2 && rect.x2 > r.x1 && rect.y1 < r.y2 && rect.y2 > r.y1)) continue;
      placed.push(rect);
      this.labelRects.push({ ...rect, idx: i });

      ctx.globalAlpha = Math.min(1, spot);
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 6;
      ctx.font = '600 12.5px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = toward(th.color, '#ffffff', 0.35);
      ctx.fillText(title, sx, sy - 15);
      ctx.font = '400 10px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#8a97bf';
      ctx.fillText(meta, sx, sy - 3);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }
}
