import type { BrainGraph, Neuron } from '../types';
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
  private queue: Array<{ text: string; el: HTMLElement }> = [];
  private busy = false;

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
  }

  /** Called whenever the brain graph (re)builds. */
  setGraph(graph: BrainGraph): void {
    this.graph = graph;
    const stem = graph.neurons.find((n) => STEM_RE.test(n.name)) ?? null;
    if (stem?.id !== this.stem?.id) {
      // A new interlocutor means a new conversation.
      this.conversationId = null;
      this.messages = [];
    }
    this.stem = stem;
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
      // The manager adopts by URL; the same-origin /flujo proxy maps to its
      // default instance.
      const adoptUrl = base.startsWith('http') ? base : 'default';
      const res = await fetch('/api/brains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No name — the manager generates a friendly one.
          lifeGoal,
          model: { mode: 'existing', id: modelId },
          adoptUrl,
          heartbeat,
          heartbeatCron: cron,
          wake: false,
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

  /** Every behaviour except the brain-stem, minus what the user switched off. */
  private enabledTools(): Neuron[] {
    return (this.graph?.neurons ?? []).filter((n) => n.id !== this.stem?.id && !this.disabledTools.has(n.id));
  }

  private renderTools(): void {
    const box = this.$('ai-tools');
    const neurons = (this.graph?.neurons ?? []).filter((n) => n.id !== this.stem?.id);
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
    try {
      await this.turn(text);
    } catch (e) {
      this.note(`⚠ ${e instanceof Error ? e.message : 'request failed'}`, 'err');
    } finally {
      this.busy = false;
      this.sendBtn.classList.remove('busy');
      const next = this.queue.shift();
      if (next) {
        next.el.classList.remove('queued');
        void this.run(next.text);
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
  private async turn(text: string): Promise<void> {
    const base = flujoBase();
    const target = this.stem;
    if (!base || !target) throw new Error('FLUJO is not reachable');

    // FLUJO parks a finished conversation on its Finish node; a follow-up
    // user message must point execution back at a thinking node or the
    // resumed run completes instantly with a bare "Processing complete."
    // (Mirrors FLUJO's own chat UI, which tags every follow-up this way.)
    this.messages.push({
      role: 'user',
      content: text,
      ...(this.conversationId ? { processNodeId: this.resumeNodeId() } : {}),
    });

    const tools = this.enabledTools();
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

        if (msg.content?.trim()) this.bubble('ai', esc(msg.content.trim()));
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
