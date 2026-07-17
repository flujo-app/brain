import type { BrainGraph, Neuron, NodeChatMessage } from '../types';
import type { BrainActivityEvent } from '../data/execution';
import type { HeartbeatState } from '../data/heartbeat';
import { splitToolName, isStem, rankWiring, type Wiring } from '../data/distill';
import { flujoBase } from '../data/loader';
import { PauseController } from '../data/pause';
import { PresenceOrb } from './presenceOrb';

/**
 * The pause button + the always-on presence dock.
 *
 * The dock is the brain-stem's face: a living neural orb that breathes, pulses
 * on every heartbeat and reply, and blooms into a conversation when you reach
 * for it. It talks to the brain-stem (the root behaviour carrying the life
 * goal) by default; selecting a behaviour in the scene retargets the chat to
 * that behaviour, each target keeping its own last conversation. When talking
 * to the stem, every other behaviour is a client-side tool it may delegate to.
 *
 * The redesign shifts weight away from chat: the stem shows its LIVE WIRING —
 * the abilities (MCP servers) used by the most behaviours and the behaviours
 * that fan out to the most subflows — so it's visibly "always connected to
 * what matters" (derived from the graph, never rewriting FLUJO). A mode rail
 * opens the vision surfaces: voice, an in-app canvas, and MCP apps.
 *
 * The 🕘 button hands off to the graphical history view; the dock also watches
 * vitals (/api/planned-executions) to offer a brain-stem / heartbeat when one
 * is missing, and starts a heartbeat-less mind paused.
 */

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** FLUJO routing: the node a user turn should resume execution at. */
  processNodeId?: string;
}

interface CompletionResponse {
  conversation_id?: string;
  choices?: Array<{ finish_reason?: string; message?: ChatMessage }>;
  error?: { message?: string } | string;
}

interface PlannedExecutions {
  paused?: boolean;
  executions?: Array<{ execution?: { flowId?: string; enabled?: boolean } }>;
}

const MAX_TOOL_ROUNDS = 8;
const CHAT_CONV_KEY = 'brain-chat-conversation';

/** Vision surfaces reachable from the mode rail. */
type Stage = 'voice' | 'canvas' | 'apps';

/** Wake prompt for the heartbeat (mirrors manager/src/brainstem.ts). */
const WAKE_PROMPT =
  'Wake up. Review your life goal and your current behaviours and skills. ' +
  'Decide the single most useful action or improvement, carry it out with your tools, ' +
  'then summarize what changed.';

const CRONS: Array<{ cron: string; label: string }> = [
  // First entry = the default. Short beats are safe (FLUJO's scheduler skips
  // a fire while a run is in flight) — 3 minutes just keeps token spend sane.
  { cron: '0 */3 * * * *', label: 'every 3 minutes' },
  { cron: '*/30 * * * * *', label: 'every 30 seconds' },
  { cron: '*/15 * * * *', label: 'every 15 minutes' },
  { cron: '0 * * * *', label: 'every hour' },
  { cron: '0 8 * * *', label: 'every morning' },
];

type SetupKind = 'none' | 'heartbeat' | 'grow' | 'no-manager' | 'no-models';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

interface StoredConvMessage {
  role?: string;
  content?: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  processNodeId?: string;
}

/** Flatten OpenAI-style content (string or text-part array) to plain text. */
function flattenContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content
      .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? (p as { text?: string }).text ?? '' : ''))
      .join('');
    return t || null;
  }
  return null;
}

/** Older conversations may carry a legacy intent preamble — hide it on display. */
function stripIntentPreamble(s: string): string {
  if (!s.startsWith('INTENT:')) return s;
  const i = s.indexOf('\n\nTASK:\n');
  return i >= 0 ? s.slice(i + 8) : s;
}

/** OpenAI tool names must be [a-zA-Z0-9_-]{1,64}. */
function toolName(flowName: string): string {
  return flowName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'behaviour';
}

export class AiDock {
  private $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  private dock = this.$('ai-dock');
  private log = this.$('ai-log');
  private input = this.$<HTMLInputElement>('ai-input');
  private sendBtn = this.$<HTMLButtonElement>('ai-send');
  private pauseBtn = this.$<HTMLButtonElement>('pause-btn');
  private setup = this.$('ai-setup');
  private title = this.$('ai-title');
  private sub = this.$('ai-sub');
  private presence = this.dock.querySelector('.ai-presence') as HTMLElement;

  private pause = new PauseController();
  private graph: BrainGraph | null = null;
  /** The brain-stem behaviour — the default interlocutor. */
  private stem: Neuron | null = null;
  /** A behaviour the user selected in the scene — overrides the stem. */
  private selectedId: string | null = null;

  private conversationId: string | null = null;
  private messages: ChatMessage[] = [];
  private queue: Array<{ text: string; el: HTMLElement }> = [];
  private busy = false;
  /** Target id whose conversation currently fills the dock. */
  private targetFor: string | null = null;
  /** Bumped on every target switch — stale async loads check it and bail. */
  private epoch = 0;

  /** The stem's living face; re-seeded when the stem changes. */
  private orb: PresenceOrb;
  private orbSeed = 'brain-stem';
  /** Fingerprint of the last heartbeat fire, so a new beat pulses the orb once. */
  private lastBeatSig = '';

  // ---- vision surfaces (scaffold) ----
  private stage = this.$('ai-stage');
  private activeStage: Stage | null = null;
  private voiceOrb: PresenceOrb | null = null;
  private voiceListening = false;
  private waveRaf = 0;
  private canvasSeeded = false;

  /** Fires whenever the current conversation's content changes — feeds the
   *  per-neuron overlay (message badges on the focused flow graph). */
  onConversation: (msgs: NodeChatMessage[]) => void = () => {};
  /** 🕘: hand off to the graphical history view, filtered to this flow. */
  onShowHistory: (flowId: string | null) => void = () => {};
  /** A wiring chip / app tile asks the scene to focus a neuron. */
  onFocus: (neuronId: string) => void = () => {};

  /** Dock revealed once FLUJO first answered. */
  private started = false;
  /** The one-time "adopted minds start paused" has run. */
  private bootPauseDone = false;
  private vitalsBusy = false;
  private setupKind: SetupKind = 'none';
  /** A grow request is in flight — keep its progress UI alive. */
  private growing = false;
  private managerOk: boolean | null = null;

  constructor() {
    this.orb = new PresenceOrb(this.$<HTMLCanvasElement>('stem-orb'), this.orbSeed);

    this.pauseBtn.addEventListener('click', () => void this.togglePause());
    this.sendBtn.addEventListener('click', () => this.submit());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Escape') {
        this.collapseChat();
        this.input.blur();
      }
    });

    // Reveal on hover / focus of the pill; collapse on click-away or hover-out
    // (unless the input is focused). Either way the conversation keeps running.
    const inputrow = this.dock.querySelector('.ai-inputrow') as HTMLElement;
    inputrow.addEventListener('pointerenter', () => this.revealChat());
    this.input.addEventListener('focus', () => this.revealChat());
    this.dock.addEventListener('pointerleave', () => {
      if (document.activeElement !== this.input && !this.activeStage) this.collapseChat();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.dock.contains(e.target as Node)) {
        this.collapseChat();
        this.closeStage();
        this.input.blur();
      }
    });

    // The mode rail opens the vision surfaces.
    this.$('mode-voice').addEventListener('click', () => this.toggleStage('voice'));
    this.$('mode-canvas').addEventListener('click', () => this.toggleStage('canvas'));
    this.$('mode-apps').addEventListener('click', () => this.toggleStage('apps'));
    this.$('stage-close').addEventListener('click', () => this.closeStage());
    this.$('voice-toggle').addEventListener('click', () => this.toggleVoice());

    this.$('ai-history').addEventListener('click', () => {
      this.collapseChat(); // the history sky lives behind the chat
      this.onShowHistory(this.target()?.id ?? null);
    });
    this.$('ai-new').addEventListener('click', () => this.newConversation());
  }

  /** Bloom the conversation panel open (optionally focusing the input). */
  private revealChat(focus = false): void {
    this.dock.classList.add('open');
    this.dock.classList.remove('unread');
    if (focus) this.input.focus();
    this.log.scrollTop = this.log.scrollHeight;
    this.updateOrb();
  }

  /** Collapse to just the command pill — the conversation stays alive. */
  private collapseChat(): void {
    this.dock.classList.remove('open');
    this.updateOrb();
  }

  /** Who the dock talks to: the selected behaviour, else the brain-stem. */
  private target(): Neuron | null {
    if (this.selectedId) {
      const n = this.graph?.neurons.find((x) => x.id === this.selectedId && x.kind !== 'ability');
      if (n) return n;
    }
    return this.stem;
  }

  /** Scene selection changed — retarget the chat (null = back to the stem). */
  setSelected(flowId: string | null): void {
    const valid =
      flowId && this.graph?.neurons.some((n) => n.id === flowId && n.kind !== 'ability') ? flowId : null;
    if (valid === this.selectedId) return;
    this.selectedId = valid;
    this.syncTarget();
  }

  /**
   * Point the dock at the current target: identity (name + description), the
   * wiring cluster (stem-only), and — when the target changed — swap to that
   * target's conversation.
   */
  private syncTarget(restore = true): void {
    const t = this.target();
    const stemTalk = !!t && t.id === this.stem?.id;
    this.title.textContent = t ? t.name : 'no brain-stem';
    this.sub.textContent = t ? (stemTalk ? t.prompt?.trim() || t.description || "the mind's core" : t.description || 'a behaviour') : 'grow one above to begin';
    this.input.disabled = !t;
    this.sendBtn.disabled = !t;
    this.input.placeholder = t ? `say something to ${t.name}…` : 'no brain-stem yet — grow one above';

    // The wiring cluster only makes sense for the brain-stem.
    this.$('ai-wiring').classList.toggle('hidden', !stemTalk);
    if (stemTalk) this.renderWiring();

    // The orb re-seeds to whatever mind we're now facing.
    const seed = t?.id ?? 'brain-stem';
    if (seed !== this.orbSeed) {
      this.orbSeed = seed;
      this.orb.reseed(seed);
    }
    this.updateOrb();

    const id = t?.id ?? null;
    if (id === this.targetFor) return;
    this.targetFor = id;
    this.epoch++;
    this.conversationId = null;
    this.messages = [];
    this.log.innerHTML = '';
    this.emitConversation();
    if (t && restore) void this.restoreConversation();
  }

  /** Called whenever the brain graph (re)builds. */
  setGraph(graph: BrainGraph): void {
    this.graph = graph;
    this.stem = graph.neurons.find(isStem) ?? null;
    // A selected behaviour that no longer exists falls back to the stem.
    if (this.selectedId && !graph.neurons.some((n) => n.id === this.selectedId && n.kind !== 'ability')) {
      this.selectedId = null;
    }
    // Conversations live in FLUJO (on disk) — syncTarget picks the one this
    // browser last used with the target back up (e.g. after a reload).
    this.syncTarget();
    if (this.activeStage === 'apps') this.renderApps();
    if (!this.started) {
      this.started = true;
      this.dock.classList.remove('hidden'); // the command pill is now live
      // Vitals (scheduler state, heartbeat) live outside the graph hash, so
      // they get their own slow poll.
      setInterval(() => void this.checkVitals(), 20_000);
    }
    void this.checkVitals();
  }

  // ---- the stem's live wiring ----------------------------------------------

  /** Render the "always connected to" cluster: top abilities + top behaviours,
   *  derived from the graph. These double as the delegation targets. */
  private renderWiring(): void {
    const box = this.$('ai-wire-chips');
    if (!this.graph) {
      box.innerHTML = '';
      return;
    }
    const wiring: Wiring = rankWiring(this.graph, { topAbilities: 5, topBehaviours: 5, excludeId: this.stem?.id ?? null });
    if (!wiring.abilities.length && !wiring.behaviours.length) {
      box.innerHTML = '<span class="wire-empty">this stem has no wiring yet — give it behaviours and abilities</span>';
      return;
    }
    const abil = wiring.abilities
      .map(
        (a) =>
          `<button class="wire-chip ability ${esc(a.status)}" data-server="${esc(a.server)}" title="${esc(a.server)} — used by ${a.count} behaviour${a.count === 1 ? '' : 's'}">` +
          `<i>⬡</i>${esc(a.server)}<b>${a.count}</b></button>`,
      )
      .join('');
    const beh = wiring.behaviours
      .map(
        (b) =>
          `<button class="wire-chip behaviour" data-id="${esc(b.id)}" title="${esc(b.name)} — fans out to ${b.count} subflow${b.count === 1 ? '' : 's'}">` +
          `<i>◇</i>${esc(b.name)}<b>${b.count}</b></button>`,
      )
      .join('');
    box.innerHTML = abil + beh;
    box.querySelectorAll<HTMLElement>('.wire-chip.behaviour').forEach((el) =>
      el.addEventListener('click', () => {
        const id = el.dataset.id!;
        this.onFocus(id);
        this.setSelected(id);
      }),
    );
    box.querySelectorAll<HTMLElement>('.wire-chip.ability').forEach((el) =>
      el.addEventListener('click', () => this.openStage('apps')),
    );
  }

  // ---- the orb -------------------------------------------------------------

  /** Keep the orb's mood in step with the dock's state. */
  private updateOrb(): void {
    const state = this.pause.paused ? 'paused' : this.busy ? 'thinking' : this.dock.classList.contains('open') ? 'active' : 'idle';
    this.orb.setState(state);
    this.voiceOrb?.setState(this.voiceListening ? 'thinking' : state === 'paused' ? 'paused' : 'active');
  }

  /** Heartbeat state (from main): a fresh beat makes the whole dock pulse. */
  setHeartbeat(state: HeartbeatState): void {
    const running = state.beats.find((b) => b.running);
    const latest = state.beats.reduce<string | null>((a, b) => (b.firedAt && (!a || b.firedAt > a) ? b.firedAt : a), null);
    const sig = `${running?.executionId ?? ''}:${latest ?? ''}`;
    if (sig && sig !== this.lastBeatSig) {
      this.lastBeatSig = sig;
      this.orb.pulse();
      this.voiceOrb?.pulse();
      // A brief flash on the collapsed presence dot.
      this.presence.classList.remove('beat');
      void this.presence.offsetWidth; // restart the animation
      this.presence.classList.add('beat');
    }
    if (typeof state.paused === 'boolean' && state.paused !== this.pause.paused) {
      this.pause.paused = state.paused;
      this.setPauseUi();
      this.updateOrb();
    }
  }

  // ---- vision surfaces (scaffold) ------------------------------------------

  private toggleStage(s: Stage): void {
    if (this.activeStage === s) this.closeStage();
    else this.openStage(s);
  }

  private openStage(s: Stage): void {
    this.activeStage = s;
    this.stage.dataset.stage = s;
    this.stage.classList.remove('hidden');
    this.dock.classList.add('staged');
    for (const id of ['mode-voice', 'mode-canvas', 'mode-apps']) {
      this.$(id).classList.toggle('active', id === `mode-${s}`);
    }
    if (s === 'voice') this.openVoice();
    else if (s === 'canvas') this.seedCanvas();
    else if (s === 'apps') this.renderApps();
  }

  private closeStage(): void {
    if (!this.activeStage) return;
    if (this.activeStage === 'voice') this.stopVoice();
    this.activeStage = null;
    this.stage.classList.add('hidden');
    this.dock.classList.remove('staged');
    for (const id of ['mode-voice', 'mode-canvas', 'mode-apps']) this.$(id).classList.remove('active');
  }

  // voice ---------------------------------------------------------------------

  private openVoice(): void {
    if (!this.voiceOrb) {
      this.voiceOrb = new PresenceOrb(this.$<HTMLCanvasElement>('voice-orb'), `${this.orbSeed}:voice`);
    }
    this.voiceOrb.setState('active');
    this.drawWave();
  }

  private toggleVoice(): void {
    this.voiceListening = !this.voiceListening;
    const btn = this.$<HTMLButtonElement>('voice-toggle');
    const t = this.$('voice-transcript');
    btn.classList.toggle('listening', this.voiceListening);
    btn.textContent = this.voiceListening ? 'listening…' : 'tap to speak';
    t.textContent = this.voiceListening
      ? 'listening… (voice capture is coming — this previews the experience)'
      : 'tap the orb and just talk to your brain';
    this.voiceOrb?.setState(this.voiceListening ? 'thinking' : 'active');
    if (this.voiceListening) this.voiceOrb?.pulse();
  }

  /** A gently rippling waveform; louder while "listening". Scaffold only. */
  private drawWave(): void {
    cancelAnimationFrame(this.waveRaf);
    const cv = this.$<HTMLCanvasElement>('voice-wave');
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const tick = () => {
      if (this.activeStage !== 'voice') return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth || 640;
      const h = cv.clientHeight || 120;
      if (cv.width !== Math.round(w * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const t = performance.now() / 1000;
      const amp = (this.voiceListening ? 0.34 : 0.08) * h;
      ctx.lineWidth = 2;
      ctx.strokeStyle = this.voiceListening ? 'rgba(88,196,255,0.9)' : 'rgba(140,165,255,0.45)';
      ctx.shadowColor = 'rgba(88,196,255,0.6)';
      ctx.shadowBlur = this.voiceListening ? 12 : 4;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const p = x / w;
        const env = Math.sin(p * Math.PI); // taper at the edges
        const y =
          h / 2 +
          Math.sin(p * 22 + t * 6) * amp * env * (0.6 + 0.4 * Math.sin(t * 3 + p * 8)) +
          Math.sin(p * 9 - t * 4) * amp * 0.3 * env;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      this.waveRaf = requestAnimationFrame(tick);
    };
    this.waveRaf = requestAnimationFrame(tick);
  }

  private stopVoice(): void {
    cancelAnimationFrame(this.waveRaf);
    this.voiceListening = false;
    const btn = this.$<HTMLButtonElement>('voice-toggle');
    btn.classList.remove('listening');
    btn.textContent = 'tap to speak';
  }

  // canvas --------------------------------------------------------------------

  private seedCanvas(): void {
    if (this.canvasSeeded) return;
    this.canvasSeeded = true;
    // A sample artifact so the surface reads as alive — the real thing will host
    // artifacts the brain produces and MCP Apps that render their own UI here.
    const bars = [42, 58, 35, 71, 49, 63, 80, 55];
    const max = Math.max(...bars);
    const w = 460;
    const h = 150;
    const bw = w / bars.length;
    const rects = bars
      .map((v, i) => {
        const bh = (v / max) * (h - 30);
        const x = i * bw + 8;
        return `<rect x="${x}" y="${h - bh - 6}" width="${bw - 16}" height="${bh}" rx="5" fill="url(#g)"><title>${v}</title></rect>`;
      })
      .join('');
    this.$('canvas-surface').innerHTML =
      '<div class="artifact">' +
      '<div class="artifact-head"><span class="artifact-kind">artifact · chart</span><span class="artifact-name">weekly activity</span></div>' +
      `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" class="artifact-svg">` +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#9b7dff"/><stop offset="1" stop-color="#58c4ff"/></linearGradient></defs>' +
      rects +
      '</svg>' +
      '<p class="artifact-note">rendered on the canvas — the brain and its MCP&nbsp;Apps will draw here in real time.</p>' +
      '</div>';
  }

  // apps ----------------------------------------------------------------------

  private renderApps(): void {
    const grid = this.$('apps-grid');
    const wiring = this.graph ? rankWiring(this.graph, { topAbilities: 8 }) : { abilities: [], behaviours: [] };
    if (!wiring.abilities.length) {
      grid.innerHTML = '<p class="apps-empty">no abilities wired yet — the brain learns skills to gain apps.</p>';
      return;
    }
    grid.innerHTML = wiring.abilities
      .map(
        (a) =>
          `<div class="app-tile ${esc(a.status)}" title="${esc(a.server)}">` +
          '<span class="app-icon">⬡</span>' +
          `<span class="app-name">${esc(a.server)}</span>` +
          `<span class="app-meta">${a.count} behaviour${a.count === 1 ? '' : 's'} · ${esc(a.status)}</span>` +
          '<span class="app-open">open ▸</span>' +
          '</div>',
      )
      .join('');
    grid.querySelectorAll<HTMLElement>('.app-tile').forEach((el) =>
      el.addEventListener('click', () => {
        el.classList.add('poked');
        window.setTimeout(() => el.classList.remove('poked'), 600);
      }),
    );
  }

  /**
   * Live SSE activity (via the ExecutionWatcher): surface server-side tool
   * calls of the open conversation as they happen. The completion endpoint is
   * non-streaming, so without this the dock shows nothing between the user's
   * message and the final answer.
   */
  handleExecution(e: BrainActivityEvent): void {
    if (e.kind !== 'tool-call' || !e.toolName) return;
    const mine =
      e.conversationId === this.conversationId ||
      (!this.conversationId && this.busy && !!e.flowId && e.flowId === this.target()?.id);
    if (!mine) return;
    this.toolPill(e.toolName, true);
  }

  // ---- stored conversations (they live in FLUJO, on disk) -------------------

  private convKey(): string | null {
    const t = this.target();
    return t ? `${CHAT_CONV_KEY}:${t.id}` : null;
  }

  /** Open a stored conversation in the dock (e.g. from the heartbeat bar). */
  openConversation(id: string): void {
    this.revealChat(true);
    void this.loadConversation(id).then((ok) => {
      if (!ok) this.note('⚠ could not load that conversation', 'err');
    });
  }

  /** The label of a target-flow node, for per-turn node tags. */
  private nodeLabel(nodeId: string | undefined): string | null {
    if (!nodeId) return null;
    return this.target()?.inner.nodes.find((n) => n.id === nodeId)?.label ?? null;
  }

  /** Current conversation as node-pinned messages (per-neuron overlay). */
  private emitConversation(): void {
    const msgs: NodeChatMessage[] = [];
    for (const m of this.messages) {
      if ((m.role !== 'user' && m.role !== 'assistant') || !m.processNodeId) continue;
      const text = m.content?.trim();
      if (!text) continue;
      msgs.push({ role: m.role, text: m.role === 'user' ? stripIntentPreamble(text) : text, nodeId: m.processNodeId });
    }
    this.onConversation(msgs);
  }

  /** Reload the conversation this browser last talked in (after a reload). */
  private async restoreConversation(): Promise<void> {
    const key = this.convKey();
    const id = key ? localStorage.getItem(key) : null;
    if (!id) return;
    const ok = await this.loadConversation(id, true);
    if (!ok && key) localStorage.removeItem(key);
  }

  /** Adopt a stored conversation: full transcript + context for follow-ups.
   *  A conversation belonging to another (known) behaviour retargets the
   *  chat to that behaviour — this is how "continue from history" works. */
  private async loadConversation(id: string, silent = false): Promise<boolean> {
    const base = flujoBase();
    if (!base) return false;
    const epoch = this.epoch;
    try {
      const res = await fetch(`${base}/v1/chat/conversations/${encodeURIComponent(id)}`);
      if (!res.ok) return false;
      const conv = (await res.json()) as { flowId?: string | null; messages?: StoredConvMessage[] };
      // The target switched while we fetched — drop this load quietly.
      if (this.epoch !== epoch) return true;
      if (conv.flowId) {
        const owner = this.graph?.neurons.find((n) => n.id === conv.flowId && n.kind !== 'ability');
        if (!owner) return false; // a forgotten behaviour — nothing to talk to
        if (owner.id !== this.target()?.id) {
          this.selectedId = owner.id === this.stem?.id ? null : owner.id;
          this.syncTarget(false); // clears the log; no competing restore
        }
      } else if (!this.target()) {
        return false;
      }
      this.conversationId = id;
      this.messages = (Array.isArray(conv.messages) ? conv.messages : [])
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
        .map((m) => ({
          role: m.role as ChatMessage['role'],
          content: flattenContent(m.content),
          ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.processNodeId ? { processNodeId: m.processNodeId } : {}),
        }));
      const key = this.convKey();
      if (key) localStorage.setItem(key, id);
      this.renderTranscript();
      this.emitConversation();
      if (!silent) this.note('conversation restored from FLUJO.');
      return true;
    } catch {
      return false;
    }
  }

  /** Redraw the whole log from this.messages (restore / conversation switch). */
  private renderTranscript(): void {
    this.log.innerHTML = '';
    for (const m of this.messages) {
      if (m.role === 'user' && m.content) {
        this.bubble('user', esc(stripIntentPreamble(m.content)));
      } else if (m.role === 'assistant') {
        for (const c of m.tool_calls ?? []) {
          if (c.function?.name) this.toolPill(c.function.name);
        }
        if (m.content?.trim()) {
          const at = this.nodeLabel(m.processNodeId);
          this.bubble('ai', (at ? `<span class="ntag">at ${esc(at)}</span>` : '') + esc(m.content.trim()));
        }
      }
    }
    this.log.scrollTop = this.log.scrollHeight;
  }

  private newConversation(): void {
    this.conversationId = null;
    this.messages = [];
    this.log.innerHTML = '';
    const key = this.convKey();
    if (key) localStorage.removeItem(key);
    this.emitConversation();
    this.note('new conversation — nothing said yet.');
  }

  // ---- pause / resume -------------------------------------------------------

  private setPauseUi(): void {
    this.pauseBtn.textContent = this.pause.paused ? '▶ resume' : '⏸ pause';
    this.pauseBtn.classList.toggle('paused', this.pause.paused);
  }

  private async togglePause(): Promise<void> {
    this.pauseBtn.disabled = true;
    try {
      if (!this.pause.paused) {
        this.pauseBtn.textContent = '… pausing';
        const notes = await this.pause.pause(this.graph);
        this.note('the brain is paused — heartbeat off, running flows frozen.');
        for (const n of notes) this.note(`⚠ ${n}`, 'err');
        this.revealChat(true);
      } else {
        this.pauseBtn.textContent = '… resuming';
        await this.pause.resume();
        this.note('resumed — the mind runs on its own again.');
      }
      this.setPauseUi();
      this.updateOrb();
    } catch (e) {
      this.note(`⚠ ${e instanceof Error ? e.message : 'failed'}`, 'err');
      this.setPauseUi();
    } finally {
      this.pauseBtn.disabled = false;
    }
  }

  // ---- vitals: scheduler state, heartbeat, brain-stem -----------------------

  private async checkVitals(): Promise<void> {
    const base = flujoBase();
    if (!base || this.vitalsBusy) return;
    this.vitalsBusy = true;
    try {
      const res = await fetch(`${base}/api/planned-executions`);
      if (!res.ok) return;
      const data = (await res.json()) as PlannedExecutions;
      const executions = Array.isArray(data.executions) ? data.executions : [];
      const heartbeat =
        !!this.stem && executions.some((x) => x.execution?.flowId === this.stem!.id && x.execution?.enabled);

      // The pause button mirrors FLUJO's real scheduler state.
      if (typeof data.paused === 'boolean' && data.paused !== this.pause.paused) {
        this.pause.paused = data.paused;
        this.setPauseUi();
        this.updateOrb();
      }

      // A mind without a heartbeat starts paused: nothing scheduled fires
      // until the user consciously presses resume.
      if (!heartbeat && !this.bootPauseDone) {
        this.bootPauseDone = true;
        if (!data.paused) {
          await fetch(`${base}/api/planned-executions`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paused: true }),
          }).catch(() => undefined);
          this.pause.paused = true;
          this.setPauseUi();
          this.updateOrb();
          this.note('started paused — this brain has no heartbeat yet. Press resume when it should run on its own.');
        }
      }

      await this.renderSetup(heartbeat);
    } catch {
      // Vitals are best-effort — old FLUJO versions may lack the endpoint.
    } finally {
      this.vitalsBusy = false;
    }
  }

  /** The ask-card at the top of the dock (grow a brain-stem / start a heartbeat). */
  private async renderSetup(heartbeat: boolean): Promise<void> {
    if (this.growing) return; // keep the in-flight progress UI
    let kind: SetupKind = 'none';
    if (!this.stem) {
      if (this.managerOk === null) {
        this.managerOk = await fetch('/api/health')
          .then((r) => r.ok)
          .catch(() => false);
      }
      kind = this.managerOk ? 'grow' : 'no-manager';
    } else if (!heartbeat) {
      kind = 'heartbeat';
    }
    if (kind === this.setupKind) return; // don't clobber a form the user is filling in
    this.setupKind = kind;

    if (kind === 'none') {
      this.setup.classList.add('hidden');
      this.setup.innerHTML = '';
      return;
    }
    this.setup.classList.remove('hidden');
    if (kind === 'heartbeat') this.renderHeartbeatCard();
    else if (kind === 'no-manager') {
      this.setup.innerHTML =
        '<p class="ask">🧠 This brain has no <b>brain-stem</b> — behaviours, but no self and no life goal.</p>' +
        '<p class="sub">This page is running without the <b>brain-manager</b>, which hosts the brain-stem\'s tool belt. ' +
        'Open this instance through a running manager instead — the Docker bundle at <code>http://127.0.0.1:8080</code>, ' +
        'or <code>npm run standalone</code> from the brain repo — and this card will offer to grow one.</p>';
    } else {
      await this.renderGrowCard();
    }
  }

  private renderHeartbeatCard(): void {
    const options = CRONS.map((c, i) => `<option value="${c.cron}"${i === 0 ? ' selected' : ''}>${c.label}</option>`);
    this.setup.innerHTML =
      '<p class="ask">💓 No heartbeat — this brain never wakes on its own. Start one?</p>' +
      `<div class="row"><select id="hb-cron">${options.join('')}</select>` +
      '<button id="hb-create" class="go">start the heartbeat</button></div>';
    const btn = this.setup.querySelector<HTMLButtonElement>('#hb-create')!;
    btn.addEventListener('click', () => void this.createHeartbeat(btn));
  }

  private async createHeartbeat(btn: HTMLButtonElement): Promise<void> {
    const base = flujoBase();
    if (!base || !this.stem) return;
    const cron = this.setup.querySelector<HTMLSelectElement>('#hb-cron')?.value ?? '0 */3 * * * *';
    btn.disabled = true;
    btn.textContent = '… creating';
    try {
      const res = await fetch(`${base}/api/planned-executions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${this.stem.name} heartbeat`,
          enabled: true,
          flowId: this.stem.id,
          prompt: WAKE_PROMPT,
          saveConversations: true,
          trigger: { type: 'schedule', cron, catchUp: false },
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      this.note('the heartbeat is set — press resume to let it beat.');
      this.setupKind = 'none';
      this.setup.classList.add('hidden');
      this.setup.innerHTML = '';
    } catch (e) {
      this.note(`⚠ heartbeat failed: ${e instanceof Error ? e.message : 'unknown error'}`, 'err');
      btn.disabled = false;
      btn.textContent = 'start the heartbeat';
    }
  }

  private async renderGrowCard(): Promise<void> {
    const base = flujoBase()!;
    const models = await this.listModels(base);
    if (!models.length) {
      this.setupKind = 'no-models';
      this.setup.innerHTML =
        '<p class="ask">🧠 This brain has no <b>brain-stem</b>.</p>' +
        '<p class="sub">It also has no models to think with — add a model in FLUJO (or use the lobby), then come back.</p>';
      return;
    }
    const options = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`);
    const crons = CRONS.map((c, i) => `<option value="${c.cron}"${i === 0 ? ' selected' : ''}>${c.label}</option>`);
    this.setup.innerHTML =
      '<p class="ask">🧠 This brain has no <b>brain-stem</b> — behaviours, but no self and no life goal. Grow one in this running instance?</p>' +
      '<textarea id="grow-goal" rows="3" placeholder="its life goal — what should this mind live for?"></textarea>' +
      `<select id="grow-model">${options.join('')}</select>` +
      `<div class="row"><label class="hb"><input type="checkbox" id="grow-hb" checked /> heartbeat</label>` +
      `<select id="grow-cron">${crons.join('')}</select></div>` +
      '<button id="grow-btn" class="go">grow the brain-stem</button>' +
      '<p class="sub" id="grow-status"></p>';
    const btn = this.setup.querySelector<HTMLButtonElement>('#grow-btn')!;
    btn.addEventListener('click', () => void this.growBrainstem(btn));
  }

  private async listModels(base: string): Promise<Array<{ id: string; label: string }>> {
    try {
      const raw = (await (await fetch(`${base}/api/model`)).json()) as unknown;
      const list = (Array.isArray(raw) ? raw : ((raw as { models?: unknown[] })?.models ?? [])) as Array<{
        id?: string;
        name?: string;
        displayName?: string;
      }>;
      return list.filter((m) => m?.id).map((m) => ({ id: m.id!, label: m.displayName ?? m.name ?? m.id! }));
    } catch {
      return [];
    }
  }

  /** Grow a brain-stem into the running instance via the brain-manager. */
  private async growBrainstem(btn: HTMLButtonElement): Promise<void> {
    const base = flujoBase()!;
    const lifeGoal = this.setup.querySelector<HTMLTextAreaElement>('#grow-goal')?.value.trim() ?? '';
    const modelId = this.setup.querySelector<HTMLSelectElement>('#grow-model')?.value ?? '';
    const heartbeat = this.setup.querySelector<HTMLInputElement>('#grow-hb')?.checked ?? true;
    const cron = this.setup.querySelector<HTMLSelectElement>('#grow-cron')?.value ?? '0 */3 * * * *';
    const status = this.setup.querySelector<HTMLElement>('#grow-status')!;
    if (!lifeGoal) {
      status.textContent = 'give it a life goal first.';
      return;
    }

    this.growing = true;
    btn.disabled = true;
    btn.textContent = '… growing';
    try {
      // Viewed through a per-brain proxy, the instance is already registered —
      // grow into that record. Otherwise the manager adopts by URL (the
      // same-origin /flujo proxy maps to its default instance).
      const proxied = base.match(/^\/brains\/([^/]+)\/flujo\/?$/);
      const res = await fetch(proxied ? `/api/brains/${proxied[1]}/grow` : '/api/brains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No name — the manager generates (or already has) a friendly one.
          lifeGoal,
          model: { mode: 'existing', id: modelId },
          ...(proxied ? {} : { adoptUrl: base.startsWith('http') ? base : 'default', wake: false }),
          heartbeat,
          heartbeatCron: cron,
        }),
      });
      const created = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !created.id) throw new Error(created.error ?? `${res.status} ${res.statusText}`);

      // Provisioning runs in the manager's background — poll until it lands.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const b = (await (await fetch(`/api/brains/${created.id}`)).json()) as {
          status?: string;
          statusDetail?: string;
        };
        status.textContent = b.statusDetail ?? b.status ?? '';
        if (b.status === 'ready') {
          this.note('the brain-stem is grown — it appears in the web in a few seconds.');
          this.growing = false;
          this.setupKind = 'none';
          this.setup.classList.add('hidden');
          this.setup.innerHTML = '';
          return;
        }
        if (b.status === 'error') throw new Error(b.statusDetail ?? 'provisioning failed');
      }
      throw new Error('timed out waiting for provisioning');
    } catch (e) {
      status.textContent = `⚠ ${e instanceof Error ? e.message : 'failed'}`;
      this.growing = false;
      btn.disabled = false;
      btn.textContent = 'grow the brain-stem';
    }
  }

  // ---- tools ----------------------------------------------------------------

  /** Every behaviour except the brain-stem — the stem's delegation targets.
   *  Ability neurons (MCP servers) are viz-only — they cannot run as flows. */
  private enabledTools(): Neuron[] {
    return (this.graph?.neurons ?? []).filter((n) => n.kind !== 'ability' && n.id !== this.stem?.id);
  }

  // ---- transcript -----------------------------------------------------------

  private bubble(cls: string, html: string): HTMLElement {
    const div = document.createElement('div');
    div.className = `msg ${cls}`;
    div.innerHTML = html;
    this.log.appendChild(div);
    this.log.scrollTop = this.log.scrollHeight;
    // A reply that lands while the panel is collapsed pulses the pill.
    if (cls.includes('ai') && !this.dock.classList.contains('open')) {
      this.dock.classList.add('unread');
    }
    return div;
  }

  private note(text: string, cls = ''): void {
    this.bubble(`note ${cls}`, esc(text));
  }

  /** Consecutive pills share one wrapping row, so tool bursts read as one. */
  private pillRow(): HTMLElement {
    const last = this.log.lastElementChild;
    if (last instanceof HTMLElement && last.classList.contains('tools-row')) return last;
    const row = document.createElement('div');
    row.className = 'tools-row';
    this.log.appendChild(row);
    return row;
  }

  /** A glowing ability pill: ⚙ server · tool. `live` pulses while it runs. */
  private toolPill(name: string, live = false): HTMLElement {
    const { server, tool } = splitToolName(name);
    const pill = document.createElement('span');
    pill.className = live ? 'tpill live' : 'tpill';
    pill.innerHTML = `<i>⚙</i>${server ? `<em>${esc(server)}</em>` : ''}${esc(tool)}`;
    this.pillRow().appendChild(pill);
    if (live) window.setTimeout(() => pill.classList.remove('live'), 5000);
    this.log.scrollTop = this.log.scrollHeight;
    return pill;
  }

  /** A delegation pill: ◇ behaviour (the dock running a flow as a tool). */
  private behaviourPill(name: string): HTMLElement {
    const pill = document.createElement('span');
    pill.className = 'tpill beh live';
    pill.innerHTML = `<i>◇</i>${esc(name)}`;
    this.pillRow().appendChild(pill);
    this.log.scrollTop = this.log.scrollHeight;
    return pill;
  }

  // ---- sending & the queue --------------------------------------------------

  private submit(): void {
    const text = this.input.value.trim();
    if (!text || !this.target()) return;
    this.input.value = '';
    const el = this.bubble(this.busy ? 'user queued' : 'user', esc(text));
    if (this.busy) {
      this.queue.push({ text, el });
      return;
    }
    void this.run(text);
  }

  private async run(text: string): Promise<void> {
    this.busy = true;
    this.sendBtn.classList.add('busy');
    this.updateOrb();
    try {
      await this.turn(text);
    } catch (e) {
      this.note(`⚠ ${e instanceof Error ? e.message : 'request failed'}`, 'err');
    } finally {
      this.emitConversation();
      this.busy = false;
      this.sendBtn.classList.remove('busy');
      this.updateOrb();
      const next = this.queue.shift();
      if (next) {
        next.el.classList.remove('queued');
        void this.run(next.text);
      }
    }
  }

  /** Where a follow-up turn resumes: the node that answered last, falling
   *  back to the target's (first) process node. */
  private resumeNodeId(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'assistant' && m.processNodeId) return m.processNodeId;
    }
    return this.target()?.inner.nodes.find((n) => n.type === 'process')?.id;
  }

  /** One user turn: completion + as many tool rounds as the model asks for. */
  private async turn(text: string): Promise<void> {
    const base = flujoBase();
    const target = this.target();
    if (!base || !target) throw new Error('FLUJO is not reachable');
    const stemTalk = target.id === this.stem?.id;
    // Snapshot the transcript: if the user retargets the chat mid-turn, this
    // run keeps writing into ITS conversation and stops touching the dock.
    const msgs = this.messages;
    const current = () => this.messages === msgs;

    // FLUJO parks a finished conversation on its Finish node; a follow-up
    // user message must point execution back at a thinking node or the
    // resumed run completes instantly with a bare "Processing complete."
    msgs.push({
      role: 'user',
      content: text,
      ...(this.conversationId ? { processNodeId: this.resumeNodeId() } : {}),
    });

    // Talking to the stem offers every other behaviour as a delegation tool.
    // (FLUJO's flow path currently ignores client tools — kept as a harmless
    // fallback; the stem's own MCP belt does the real work.)
    const tools = stemTalk ? this.enabledTools() : [];
    const nameToFlow = new Map<string, Neuron>();
    const toolDefs = tools.map((n) => {
      let name = toolName(n.name);
      while (nameToFlow.has(name)) name = `${name.slice(0, 60)}_${nameToFlow.size}`;
      nameToFlow.set(name, n);
      return {
        type: 'function' as const,
        function: {
          name,
          description: n.description || `Run the behaviour "${n.name}" and return its answer.`,
          parameters: {
            type: 'object',
            properties: {
              input: { type: 'string', description: 'What to ask this behaviour to do.' },
            },
            required: ['input'],
          },
        },
      };
    });

    const thinking = this.bubble('note thinking', '…');
    try {
      let conversationId = this.conversationId;
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await this.complete({
          model: `flow-${target.name}`,
          messages: msgs,
          stream: false,
          ...(toolDefs.length ? { tools: toolDefs } : {}),
          ...(conversationId ? { metadata: { conversationId } } : {}),
        });
        conversationId = res.conversation_id ?? conversationId;
        if (current()) {
          this.conversationId = conversationId;
          const key = this.convKey();
          if (key && conversationId) localStorage.setItem(key, conversationId);
        }
        const choice = res.choices?.[0];
        const msg = choice?.message;
        if (!msg) throw new Error(typeof res.error === 'string' ? res.error : res.error?.message ?? 'empty response');
        msgs.push(msg);

        if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
          for (const call of msg.tool_calls) {
            const flow = nameToFlow.get(call.function.name);
            let input = call.function.arguments;
            try {
              input = (JSON.parse(call.function.arguments) as { input?: string }).input ?? input;
            } catch {
              // Non-JSON arguments — pass them through raw.
            }
            const pill = current() ? this.behaviourPill(flow?.name ?? call.function.name) : null;
            const result = flow
              ? await this.performBehaviour(flow, input)
              : `Unknown behaviour "${call.function.name}".`;
            pill?.classList.remove('live');
            msgs.push({ role: 'tool', content: result, tool_call_id: call.id });
          }
          continue;
        }

        if (msg.content?.trim() && current()) {
          this.orb.pulse(); // a fresh thought lights up the face
          const at = this.nodeLabel(msg.processNodeId);
          this.bubble('ai', (at ? `<span class="ntag">at ${esc(at)}</span>` : '') + esc(msg.content.trim()));
        }
        return;
      }
      if (current()) this.note('⚠ stopped after too many tool rounds', 'err');
    } finally {
      thinking.remove();
    }
  }

  /** A tool call = one ephemeral run of that behaviour (it animates live). */
  private async performBehaviour(flow: Neuron, input: string): Promise<string> {
    try {
      const res = await this.complete({
        model: `flow-${flow.name}`,
        messages: [{ role: 'user', content: input }],
        stream: false,
      });
      return res.choices?.[0]?.message?.content ?? '(no answer)';
    } catch (e) {
      return `The behaviour failed: ${e instanceof Error ? e.message : 'unknown error'}`;
    }
  }

  private async complete(body: unknown): Promise<CompletionResponse> {
    const base = flujoBase();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as CompletionResponse;
    if (!res.ok) {
      throw new Error(typeof data.error === 'string' ? data.error : data.error?.message ?? `${res.status} ${res.statusText}`);
    }
    return data;
  }
}
