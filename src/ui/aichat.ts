import type { BrainGraph, Neuron, NodeChatMessage } from '../types';
import { flujoBase } from '../data/loader';
import { PauseController } from '../data/pause';

/**
 * The pause button + the always-on chat dock.
 *
 * The dock appears as soon as FLUJO is reachable and is wired straight to the
 * brain-stem flow (the root behaviour carrying the life goal) — there is no
 * flow picker. Every OTHER behaviour is offered to it as a client-side tool
 * (all on by default), so the model can delegate — brain executes each tool
 * call as its own flow run and feeds the result back, and every run animates
 * in the viewer. Messages typed while a turn is in flight queue up.
 *
 * The dock also watches the brain's vitals (/api/planned-executions): an
 * adopted instance with no brain-stem is offered one (grown via the
 * brain-manager into the running instance), a brain-stem without a heartbeat
 * is offered a heartbeat, and a mind without a heartbeat starts paused.
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
const STEM_RE = /brain.?stem/i;
const CHAT_HIDDEN_KEY = 'brain-chat-hidden';
const CHAT_EXPANDED_KEY = 'brain-chat-expanded';
const CHAT_CONV_KEY = 'brain-chat-conversation';

/**
 * Intent pills: the user picks what a message is for, and the turn is scoped
 * to the matching slice of the brain-stem's tool belt (list/perform/learn/
 * forget behaviours; list/use/learn/forget skills — hosted by the manager).
 *
 * The belt lives server-side (MCP nodes baked into the flow) and FLUJO has no
 * per-request tool filter for flow runs — client `tools` are ignored on the
 * flow path entirely. So scoping is done by instruction: a preamble names the
 * allowed verbs (and the concrete behaviours/skills in scope), which also
 * keeps the model from wandering through the whole belt.
 */
type Intent = 'use-behaviour' | 'learn-behaviour' | 'use-skill' | 'learn-skill';

interface IntentCtx {
  behaviours: string[];
  skills: string[];
}

const INTENTS: Record<Intent, (ctx: IntentCtx) => string> = {
  'use-behaviour': ({ behaviours }) =>
    'INTENT: perform an existing behaviour for the task below. Allowed tools: perform_behaviour (and ' +
    'list_behaviours to inspect). Do not learn, forget, or touch skills this turn.' +
    (behaviours.length ? ` Behaviours in scope: ${behaviours.join(', ')}.` : ''),
  'learn-behaviour': () =>
    'INTENT: learn a NEW behaviour for the task below. Allowed tools: list_behaviours and learn_behaviour. ' +
    'Do not perform existing behaviours and do not touch skills this turn.',
  'use-skill': ({ skills }) =>
    'INTENT: use an installed skill (MCP server) for the task below. Allowed tools: list_skills (pass name to ' +
    'see a skill\'s tools) and use_skill to call one. If use_skill is not in your belt, say so and name the ' +
    'behaviour that binds the skill instead. Do not learn or forget anything this turn.' +
    (skills.length ? ` Skills installed: ${skills.join(', ')}.` : ''),
  'learn-skill': () =>
    'INTENT: learn a NEW skill for the task below. Allowed tools: list_skills (its search reaches the MCP ' +
    'registry) and learn_skill to install it. Do not create behaviours this turn.',
};

/** Intents that still attach the behaviours as client-side tools. */
const INTENT_BEHAVIOUR_TOOLS: Record<Intent, boolean> = {
  'use-behaviour': true,
  'learn-behaviour': false,
  'use-skill': false,
  'learn-skill': false,
};

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

/** A conversation as FLUJO lists / returns it (persisted on its disk). */
interface StoredConvItem {
  id: string;
  title?: string;
  flowId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  status?: string;
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

/** Hide the intent preamble in displayed user bubbles (it stays on the wire). */
function stripIntentPreamble(s: string): string {
  if (!s.startsWith('INTENT:')) return s;
  const i = s.indexOf('\n\nTASK:\n');
  return i >= 0 ? s.slice(i + 8) : s;
}

/** "12s ago" / "3m ago" / "2h ago" / "5d ago" for the history list. */
function relTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
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
  private openBtn = this.$<HTMLButtonElement>('ai-open');
  private expandBtn = this.$<HTMLButtonElement>('ai-expand');
  private setup = this.$('ai-setup');
  private title = this.$('ai-title');

  private pause = new PauseController();
  private graph: BrainGraph | null = null;
  /** The brain-stem behaviour — the only interlocutor. */
  private stem: Neuron | null = null;
  /** Behaviours the user switched OFF as tools (persist across graph polls). */
  private disabledTools = new Set<string>();

  private conversationId: string | null = null;
  private messages: ChatMessage[] = [];
  private queue: Array<{ text: string; el: HTMLElement; intent: Intent | null }> = [];
  private busy = false;
  /** The armed intent pill; applies to the next message sent. */
  private intent: Intent | null = null;
  /** Stem id whose stored conversation was already restored (once per stem). */
  private restoredFor: string | null = null;
  private historyOpen = false;

  /** Fires whenever the current conversation's content changes — feeds the
   *  per-neuron overlay (message badges on the focused flow graph). */
  onConversation: (msgs: NodeChatMessage[]) => void = () => {};

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
    this.pauseBtn.addEventListener('click', () => void this.togglePause());
    this.sendBtn.addEventListener('click', () => this.submit());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    this.$('ai-close').addEventListener('click', () => this.setDockHidden(true));
    this.openBtn.addEventListener('click', () => {
      this.setDockHidden(false);
      this.input.focus();
    });
    this.expandBtn.addEventListener('click', () => {
      this.setExpanded(!this.dock.classList.contains('expanded'));
      this.input.focus();
    });
    this.setExpanded(localStorage.getItem(CHAT_EXPANDED_KEY) === '1');

    // Intent pills: click arms one and disables the rest; click again disarms.
    this.$('ai-intents')
      .querySelectorAll<HTMLButtonElement>('.ai-intent')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          this.setIntent(this.intent === btn.dataset.intent ? null : (btn.dataset.intent as Intent));
          this.input.focus();
        });
      });

    this.$('ai-history').addEventListener('click', () => void this.toggleHistory());
  }

  private setIntent(intent: Intent | null): void {
    this.intent = intent;
    this.$('ai-intents')
      .querySelectorAll<HTMLButtonElement>('.ai-intent')
      .forEach((btn) => {
        const mine = btn.dataset.intent === intent;
        btn.classList.toggle('active', mine);
        btn.disabled = intent !== null && !mine;
      });
  }

  private setExpanded(expanded: boolean): void {
    localStorage.setItem(CHAT_EXPANDED_KEY, expanded ? '1' : '0');
    this.dock.classList.toggle('expanded', expanded);
    this.expandBtn.textContent = expanded ? '⤡' : '⛶';
    this.expandBtn.title = expanded ? 'shrink' : 'expand';
    this.expandBtn.setAttribute('aria-label', expanded ? 'shrink chat' : 'expand chat');
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Called whenever the brain graph (re)builds. */
  setGraph(graph: BrainGraph): void {
    this.graph = graph;
    const stem = graph.neurons.find((n) => n.kind !== 'ability' && STEM_RE.test(n.name)) ?? null;
    if (stem?.id !== this.stem?.id) {
      // A new interlocutor means a new conversation.
      this.conversationId = null;
      this.messages = [];
    }
    this.stem = stem;
    // Conversations live in FLUJO (on disk) — pick the one this browser last
    // used back up after a reload.
    if (stem && this.restoredFor !== stem.id) {
      this.restoredFor = stem.id;
      void this.restoreConversation();
    }
    this.title.textContent = stem ? `talk to ${stem.name}` : 'talk to the brain';
    this.input.disabled = !stem;
    this.sendBtn.disabled = !stem;
    this.input.placeholder = stem ? 'say something… (queues while it thinks)' : 'no brain-stem yet — grow one above';
    this.renderTools();
    if (!this.started) {
      this.started = true;
      this.setDockHidden(localStorage.getItem(CHAT_HIDDEN_KEY) === '1');
      // Vitals (scheduler state, heartbeat) live outside the graph hash, so
      // they get their own slow poll.
      setInterval(() => void this.checkVitals(), 20_000);
    }
    void this.checkVitals();
  }

  private setDockHidden(hidden: boolean): void {
    localStorage.setItem(CHAT_HIDDEN_KEY, hidden ? '1' : '0');
    this.dock.classList.toggle('hidden', hidden);
    this.openBtn.classList.toggle('hidden', !hidden);
  }

  // ---- stored conversations (they live in FLUJO, on disk) -------------------

  private convKey(): string | null {
    return this.stem ? `${CHAT_CONV_KEY}:${this.stem.id}` : null;
  }

  /** Open a stored conversation in the dock (e.g. from the heartbeat bar). */
  openConversation(id: string): void {
    this.setDockHidden(false);
    void this.loadConversation(id).then((ok) => {
      if (!ok) this.note('⚠ could not load that conversation', 'err');
    });
  }

  /** The label of a brain-stem node, for per-time node tags. */
  private nodeLabel(nodeId: string | undefined): string | null {
    if (!nodeId) return null;
    return this.stem?.inner.nodes.find((n) => n.id === nodeId)?.label ?? null;
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

  /** Adopt a stored conversation: full transcript + context for follow-ups. */
  private async loadConversation(id: string, silent = false): Promise<boolean> {
    const base = flujoBase();
    if (!base || !this.stem) return false;
    try {
      const res = await fetch(`${base}/v1/chat/conversations/${encodeURIComponent(id)}`);
      if (!res.ok) return false;
      const conv = (await res.json()) as { flowId?: string | null; messages?: StoredConvMessage[] };
      if (conv.flowId && conv.flowId !== this.stem.id) return false;
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
        const names = (m.tool_calls ?? []).map((c) => c.function?.name).filter(Boolean);
        if (names.length) this.note(`→ used ${names.join(', ')}`, 'tool');
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

  private async toggleHistory(): Promise<void> {
    this.historyOpen = !this.historyOpen;
    const box = this.$('ai-convs');
    box.classList.toggle('hidden', !this.historyOpen);
    if (this.historyOpen) await this.renderHistoryList();
  }

  private async renderHistoryList(): Promise<void> {
    const box = this.$('ai-convs');
    box.innerHTML = '<div class="empty">loading…</div>';
    const base = flujoBase();
    if (!base || !this.stem) {
      box.innerHTML = '<div class="empty">FLUJO (or the brain-stem) is not reachable.</div>';
      return;
    }
    try {
      const res = await fetch(`${base}/v1/chat/conversations`);
      if (!res.ok) throw new Error(`${res.status}`);
      const list = (await res.json()) as StoredConvItem[];
      const mine = (Array.isArray(list) ? list : [])
        .filter((c) => c?.id && c.flowId === this.stem!.id)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const item = (c: StoredConvItem) => {
        // FLUJO stores no source marker; heartbeat runs are recognizable by
        // their wake-prompt-derived title.
        const heartbeat = /^wake up\b/i.test(c.title ?? '');
        const st = c.status ?? '';
        return (
          `<button class="conv${c.id === this.conversationId ? ' current' : ''}" data-id="${esc(c.id)}">` +
          `<span class="t">${heartbeat ? '💓 ' : ''}${esc(c.title || 'untitled')}</span>` +
          `<span class="st${st === 'running' ? ' running' : ''}">${esc(st)}</span>` +
          `<span class="when">${c.updatedAt ? relTime(c.updatedAt) : ''}</span></button>`
        );
      };
      box.innerHTML =
        '<button class="conv new" data-id="">＋ new conversation</button>' +
        (mine.length ? mine.map(item).join('') : '<div class="empty">no stored conversations for this brain yet.</div>');
      box.querySelectorAll<HTMLButtonElement>('.conv').forEach((el) => {
        el.addEventListener('click', () => {
          this.historyOpen = false;
          box.classList.add('hidden');
          const id = el.dataset.id;
          if (!id) this.newConversation();
          else {
            void this.loadConversation(id).then((ok) => {
              if (!ok) this.note('⚠ could not load that conversation', 'err');
            });
          }
        });
      });
    } catch {
      box.innerHTML = '<div class="empty">could not list conversations.</div>';
    }
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
        this.setDockHidden(false);
        this.input.focus();
      } else {
        this.pauseBtn.textContent = '… resuming';
        await this.pause.resume();
        this.note('resumed — the mind runs on its own again.');
      }
      this.setPauseUi();
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

  /** Every behaviour except the brain-stem, minus what the user switched off.
   *  Ability neurons (MCP servers) are viz-only — they cannot run as flows. */
  private enabledTools(): Neuron[] {
    return (this.graph?.neurons ?? []).filter(
      (n) => n.kind !== 'ability' && n.id !== this.stem?.id && !this.disabledTools.has(n.id),
    );
  }

  private renderTools(): void {
    const box = this.$('ai-tools');
    const neurons = (this.graph?.neurons ?? []).filter((n) => n.kind !== 'ability' && n.id !== this.stem?.id);
    box.innerHTML = neurons
      .map(
        (n) =>
          `<button class="ai-tool${this.disabledTools.has(n.id) ? ' off' : ''}" data-id="${esc(n.id)}" title="${esc(n.description || n.name)}">${esc(n.name)}</button>`,
      )
      .join('');
    box.querySelectorAll<HTMLElement>('.ai-tool').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id!;
        if (this.disabledTools.has(id)) this.disabledTools.delete(id);
        else this.disabledTools.add(id);
        el.classList.toggle('off');
        this.updateToolCount();
      });
    });
    this.updateToolCount();
  }

  private updateToolCount(): void {
    this.$('ai-tool-count').textContent = String(this.enabledTools().length);
  }

  // ---- transcript -----------------------------------------------------------

  private bubble(cls: string, html: string): HTMLElement {
    const div = document.createElement('div');
    div.className = `msg ${cls}`;
    div.innerHTML = html;
    this.log.appendChild(div);
    this.log.scrollTop = this.log.scrollHeight;
    return div;
  }

  private note(text: string, cls = ''): void {
    this.bubble(`note ${cls}`, esc(text));
  }

  // ---- sending & the queue --------------------------------------------------

  private submit(): void {
    const text = this.input.value.trim();
    if (!text || !this.stem) return;
    this.input.value = '';
    const intent = this.intent;
    this.setIntent(null); // one-shot: a pill arms exactly one message
    const tag = intent ? `<span class="itag">${intent.replace('-', ' ')}</span>` : '';
    const el = this.bubble(this.busy ? 'user queued' : 'user', tag + esc(text));
    if (this.busy) {
      this.queue.push({ text, el, intent });
      return;
    }
    void this.run(text, intent);
  }

  private async run(text: string, intent: Intent | null): Promise<void> {
    this.busy = true;
    this.sendBtn.classList.add('busy');
    try {
      await this.turn(text, intent);
    } catch (e) {
      this.note(`⚠ ${e instanceof Error ? e.message : 'request failed'}`, 'err');
    } finally {
      this.emitConversation();
      this.busy = false;
      this.sendBtn.classList.remove('busy');
      const next = this.queue.shift();
      if (next) {
        next.el.classList.remove('queued');
        void this.run(next.text, next.intent);
      }
    }
  }

  /** Where a follow-up turn resumes: the node that answered last, falling
   *  back to the brain-stem's (first) process node. */
  private resumeNodeId(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'assistant' && m.processNodeId) return m.processNodeId;
    }
    return this.stem?.inner.nodes.find((n) => n.type === 'process')?.id;
  }

  /** One user turn: completion + as many tool rounds as the model asks for. */
  private async turn(text: string, intent: Intent | null = null): Promise<void> {
    const base = flujoBase();
    const target = this.stem;
    if (!base || !target) throw new Error('FLUJO is not reachable');

    // An armed intent travels inside the user message (FLUJO strips client
    // system messages in flow mode, and has no per-request tool scoping —
    // the belt is narrowed by instruction).
    const ctx: IntentCtx = {
      behaviours: this.enabledTools().map((n) => n.name),
      skills: Object.entries(this.graph?.servers ?? {})
        .filter(([, s]) => s !== 'disabled')
        .map(([name]) => name),
    };
    const content = intent ? `${INTENTS[intent](ctx)}\n\nTASK:\n${text}` : text;

    // FLUJO parks a finished conversation on its Finish node; a follow-up
    // user message must point execution back at a thinking node or the
    // resumed run completes instantly with a bare "Processing complete."
    // (Mirrors FLUJO's own chat UI, which tags every follow-up this way.)
    this.messages.push({
      role: 'user',
      content,
      ...(this.conversationId ? { processNodeId: this.resumeNodeId() } : {}),
    });

    // Reduced context: behaviours are only offered as client-side tools when
    // the intent calls for performing behaviours (or no intent is armed).
    // (FLUJO's flow path currently ignores client tools — kept as a harmless
    // fallback; the intent preamble does the real scoping.)
    const tools = !intent || INTENT_BEHAVIOUR_TOOLS[intent] ? this.enabledTools() : [];
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
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const res = await this.complete({
          model: `flow-${target.name}`,
          messages: this.messages,
          stream: false,
          ...(toolDefs.length ? { tools: toolDefs } : {}),
          ...(this.conversationId ? { metadata: { conversationId: this.conversationId } } : {}),
        });
        this.conversationId = res.conversation_id ?? this.conversationId;
        // Remember where this browser talks, so a reload lands back here
        // (the conversation itself is persisted by FLUJO).
        const key = this.convKey();
        if (key && this.conversationId) localStorage.setItem(key, this.conversationId);
        const choice = res.choices?.[0];
        const msg = choice?.message;
        if (!msg) throw new Error(typeof res.error === 'string' ? res.error : res.error?.message ?? 'empty response');
        this.messages.push(msg);

        if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
          for (const call of msg.tool_calls) {
            const flow = nameToFlow.get(call.function.name);
            let input = call.function.arguments;
            try {
              input = (JSON.parse(call.function.arguments) as { input?: string }).input ?? input;
            } catch {
              // Non-JSON arguments — pass them through raw.
            }
            const line = this.bubble('note tool', `→ performing <b>${esc(flow?.name ?? call.function.name)}</b>…`);
            const result = flow
              ? await this.performBehaviour(flow, input)
              : `Unknown behaviour "${call.function.name}".`;
            line.innerHTML = `→ performed <b>${esc(flow?.name ?? call.function.name)}</b>`;
            this.messages.push({ role: 'tool', content: result, tool_call_id: call.id });
          }
          continue;
        }

        if (msg.content?.trim()) {
          const at = this.nodeLabel(msg.processNodeId);
          this.bubble('ai', (at ? `<span class="ntag">at ${esc(at)}</span>` : '') + esc(msg.content.trim()));
        }
        return;
      }
      this.note('⚠ stopped after too many tool rounds', 'err');
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
