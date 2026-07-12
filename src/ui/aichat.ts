import type { BrainGraph, Neuron } from '../types';
import { flujoBase } from '../data/loader';
import { PauseController } from '../data/pause';

/**
 * The pause button + AI input window.
 *
 * Pausing freezes the whole mind (scheduler + running flows, see
 * PauseController) and opens a chat dock wired straight to FLUJO's
 * OpenAI-compatible endpoint. The selected behaviour answers; every OTHER
 * behaviour can be offered to it as a client-side tool (all on by default),
 * so the model can delegate — brain executes each tool call as its own flow
 * run and feeds the result back, and every run animates in the viewer.
 * Messages typed while a turn is in flight queue up and dispatch in order.
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
}

interface CompletionResponse {
  conversation_id?: string;
  choices?: Array<{ finish_reason?: string; message?: ChatMessage }>;
  error?: { message?: string } | string;
}

const MAX_TOOL_ROUNDS = 8;

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
  private targetSel = this.$<HTMLSelectElement>('ai-target');

  private pause = new PauseController();
  private graph: BrainGraph | null = null;
  /** Behaviours the user switched OFF as tools (persist across graph polls). */
  private disabledTools = new Set<string>();

  private conversationId: string | null = null;
  private messages: ChatMessage[] = [];
  private queue: Array<{ text: string; el: HTMLElement }> = [];
  private busy = false;

  constructor() {
    this.pauseBtn.addEventListener('click', () => void this.togglePause());
    this.sendBtn.addEventListener('click', () => this.submit());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    this.targetSel.addEventListener('change', () => {
      // A new interlocutor means a new conversation.
      this.conversationId = null;
      this.messages = [];
      this.renderTools();
    });
    this.$('ai-close').addEventListener('click', () => void this.togglePause());
  }

  /** Called whenever the brain graph (re)builds. */
  setGraph(graph: BrainGraph): void {
    this.graph = graph;
    this.renderTargets();
    this.renderTools();
  }

  // ---- pause / resume -------------------------------------------------------

  private async togglePause(): Promise<void> {
    this.pauseBtn.disabled = true;
    try {
      if (!this.pause.paused) {
        this.pauseBtn.textContent = '… pausing';
        const notes = await this.pause.pause(this.graph);
        this.pauseBtn.textContent = '▶ resume';
        this.pauseBtn.classList.add('paused');
        this.dock.classList.remove('hidden');
        this.note('the brain is paused — heartbeat off, running flows frozen. Talk to it below.');
        for (const n of notes) this.note(`⚠ ${n}`, 'err');
        this.input.focus();
      } else {
        this.pauseBtn.textContent = '… resuming';
        await this.pause.resume();
        this.pauseBtn.textContent = '⏸ pause';
        this.pauseBtn.classList.remove('paused');
        this.dock.classList.add('hidden');
      }
    } catch (e) {
      this.note(`⚠ ${e instanceof Error ? e.message : 'failed'}`, 'err');
      this.pauseBtn.textContent = this.pause.paused ? '▶ resume' : '⏸ pause';
    } finally {
      this.pauseBtn.disabled = false;
    }
  }

  // ---- target & tools -------------------------------------------------------

  private renderTargets(): void {
    if (!this.graph) return;
    const prev = this.targetSel.value;
    const neurons = this.graph.neurons;
    this.targetSel.innerHTML = neurons
      .map((n) => `<option value="${esc(n.id)}">${esc(n.name)}</option>`)
      .join('');
    if (prev && neurons.some((n) => n.id === prev)) {
      this.targetSel.value = prev;
    } else {
      // The brain-stem is the natural interlocutor when this is a grown brain.
      const stem = neurons.find((n) => /brain.?stem/i.test(n.name));
      if (stem) this.targetSel.value = stem.id;
    }
  }

  private target(): Neuron | null {
    return this.graph?.neurons.find((n) => n.id === this.targetSel.value) ?? this.graph?.neurons[0] ?? null;
  }

  /** Every behaviour except the target, minus what the user switched off. */
  private enabledTools(): Neuron[] {
    const t = this.target();
    return (this.graph?.neurons ?? []).filter((n) => n.id !== t?.id && !this.disabledTools.has(n.id));
  }

  private renderTools(): void {
    const t = this.target();
    const box = this.$('ai-tools');
    const neurons = (this.graph?.neurons ?? []).filter((n) => n.id !== t?.id);
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
    if (!text) return;
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

  /** One user turn: completion + as many tool rounds as the model asks for. */
  private async turn(text: string): Promise<void> {
    const base = flujoBase();
    const target = this.target();
    if (!base || !target) throw new Error('FLUJO is not reachable');

    this.messages.push({ role: 'user', content: text });

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
