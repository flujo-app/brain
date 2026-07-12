import type { InnerNode, Neuron, ServerStatus, Synapse, SynapseKind } from '../types';
import type { GroupMode } from '../grouping';
import type { HeartbeatInfo } from '../data/heartbeat';
import { NODE_TYPE_COLORS, SYNAPSE_COLORS, nodeTypeLabel, providerLabel } from '../theme';

const STATUS_COLORS: Record<ServerStatus, string> = {
  connected: '#35e0d0',
  disconnected: '#ff5c8a',
  disabled: '#556080',
  unknown: '#9aa6c8',
};

function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** "12s ago" / "3m ago" / "2h ago" for the heartbeat header. */
function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** A little on/off switch row for boolean node settings. */
function toggleRow(label: string, on: boolean): string {
  return `<div class="setting"><span class="sw ${on ? 'on' : 'off'}"><i></i></span>${esc(label)}<em>${on ? 'on' : 'off'}</em></div>`;
}

interface PromptEntry {
  title: string;
  text?: string;
}

/** A big, always-open prompt block for the reader panel. */
function promptSection(p: PromptEntry): string {
  if (!p.text?.trim()) return '';
  return `<div class="pblock"><span class="ptitle">${esc(p.title)}</span><pre class="prompt">${esc(p.text.trim())}</pre></div>`;
}

const PANEL_W_KEY = 'brain-panel-w';
const PANEL_COLLAPSED_KEY = 'brain-panel-collapsed';

export interface RelationLine {
  synapse: Synapse;
  otherName: string;
  outgoing: boolean;
}

export type ViewMode = '3d' | '2d';

export class Hud {
  private $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  private panel = this.$('panel');
  private reader = this.$('reader');
  private tooltip = this.$('tooltip');
  /** True while a behaviour / node is selected (reader + panel visible). */
  private selectionOpen = false;
  private panelCollapsed = localStorage.getItem(PANEL_COLLAPSED_KEY) === '1';
  /** Last heartbeat data (shown top-right while nothing is selected). */
  private heartbeatInfo: HeartbeatInfo | null = null;

  onSearch: (q: string) => void = () => {};
  onToggleKind: (k: SynapseKind, on: boolean) => void = () => {};
  onCloseFocus: () => void = () => {};
  onGroupMode: (mode: GroupMode) => void = () => {};
  onViewMode: (mode: ViewMode) => void = () => {};
  /** Camera-follow toggle for live execution. */
  onFollow: (on: boolean) => void = () => {};
  /** Back from a node detail to the behaviour overview. */
  onBackToBehaviour: () => void = () => {};
  /** Jump focus to another behaviour (subflow node link). */
  onFocusBehaviour: (id: string) => void = () => {};

  constructor() {
    const search = this.$<HTMLInputElement>('search');
    search.addEventListener('input', () => this.onSearch(search.value.trim().toLowerCase()));

    document.querySelectorAll<HTMLElement>('#legend .syn').forEach((el) => {
      // Shared-model is off by default (see index.html) to keep the web clean.
      if (el.dataset.kind === 'model') el.classList.add('off');
      el.addEventListener('click', () => {
        const kind = el.dataset.kind as SynapseKind;
        const on = el.classList.toggle('off') === false;
        this.onToggleKind(kind, on);
      });
    });

    const group = this.$<HTMLSelectElement>('group-mode');
    group.addEventListener('change', () => this.onGroupMode(group.value as GroupMode));

    const view = this.$<HTMLSelectElement>('view-mode');
    view.addEventListener('change', () => this.onViewMode(view.value as ViewMode));

    const follow = this.$<HTMLInputElement>('follow-toggle');
    follow.addEventListener('change', () => this.onFollow(follow.checked));

    this.$('panel-close').addEventListener('click', () => this.onCloseFocus());
    this.$('reader-close').addEventListener('click', () => this.onCloseFocus());
    this.$('panel-collapse').addEventListener('click', () => this.setPanelCollapsed(true));
    this.$('panel-tab').addEventListener('click', () => this.setPanelCollapsed(false));

    const savedW = Number(localStorage.getItem(PANEL_W_KEY));
    if (savedW) this.panel.style.width = `${this.clampPanelWidth(savedW)}px`;
    this.initPanelResize();
  }

  private setPanelCollapsed(collapsed: boolean): void {
    this.panelCollapsed = collapsed;
    localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
    this.syncPanels();
  }

  /** One place decides which selection surfaces are on screen. */
  private syncPanels(): void {
    this.panel.classList.toggle('hidden', !this.selectionOpen || this.panelCollapsed);
    this.$('panel-tab').classList.toggle('hidden', !this.selectionOpen || !this.panelCollapsed);
    this.reader.classList.toggle('hidden', !this.selectionOpen);
    // The legend yields its corner to the reader while something is selected.
    document.body.classList.toggle('reading', this.selectionOpen);
    // The heartbeat transcript owns the top-right corner in overview only —
    // a focused behaviour's panel takes that spot.
    this.$('heartbeat').classList.toggle('hidden', this.selectionOpen || !this.heartbeatInfo?.messages.length);
  }

  private clampPanelWidth(w: number): number {
    const max = Math.max(320, Math.round(window.innerWidth * 0.55));
    return Math.round(Math.min(Math.max(w, 260), max));
  }

  /** Drag the panel's left edge to resize it; the width survives reloads. */
  private initPanelResize(): void {
    const handle = this.$('panel-resize');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        // 22px = the panel's `right` offset in CSS.
        this.panel.style.width = `${this.clampPanelWidth(window.innerWidth - ev.clientX - 22)}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        localStorage.setItem(PANEL_W_KEY, String(parseInt(this.panel.style.width, 10) || 340));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
    });
  }

  /** The big-type reader on the left: name, description, prompts. */
  private showReader(
    kicker: string,
    kickerColor: string,
    name: string,
    desc: string,
    prompts: PromptEntry[],
    emptyNote = '',
  ): void {
    this.$('r-kicker').innerHTML =
      `<span class="k"${kickerColor ? ` style="color:${kickerColor}"` : ''}>${esc(kicker)}</span>`;
    this.$('r-name').textContent = name;
    const d = this.$('r-desc');
    d.textContent = desc;
    d.style.display = desc ? '' : 'none';
    const html = prompts.map(promptSection).join('');
    this.$('r-prompts').innerHTML = html || (emptyNote ? `<p class="empty">${esc(emptyNote)}</p>` : '');
  }

  followEnabled(): boolean {
    return this.$<HTMLInputElement>('follow-toggle').checked;
  }

  /** Synapse kinds currently enabled in the legend (source of truth: the DOM). */
  enabledKinds(): Set<SynapseKind> {
    const set = new Set<SynapseKind>();
    document.querySelectorAll<HTMLElement>('#legend .syn:not(.off)').forEach((el) => {
      if (el.dataset.kind) set.add(el.dataset.kind as SynapseKind);
    });
    return set;
  }

  currentGroupMode(): GroupMode {
    return this.$<HTMLSelectElement>('group-mode').value as GroupMode;
  }

  /** Show / update / hide the "now thinking" strip. */
  setActivity(a: { flow: string; detail?: string; runs?: number } | null): void {
    const el = this.$('activity');
    if (!a) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    this.$('activity-text').innerHTML =
      `<b>${esc(a.flow)}</b>` +
      (a.detail ? ` <em>· ${esc(a.detail)}</em>` : '') +
      (a.runs && a.runs > 1 ? ` <em>· ${a.runs} runs</em>` : '');
  }

  /** Show / update the last-heartbeat transcript (top-right, overview only). */
  setHeartbeat(h: HeartbeatInfo | null): void {
    this.heartbeatInfo = h;
    if (h?.messages.length) {
      this.$('hb-title').textContent = h.name;
      this.$('hb-time').textContent = h.status === 'running' ? 'beating…' : relTime(h.firedAt);
      this.$('heartbeat').classList.toggle('running', h.status === 'running');
      const msgs = this.$('hb-msgs');
      msgs.innerHTML = h.messages
        .map((m) => `<div class="hb-msg ${m.role === 'user' ? 'user' : 'assistant'}">${esc(m.text)}</div>`)
        .join('');
      msgs.scrollTop = msgs.scrollHeight;
    }
    this.syncPanels();
  }

  setGroupMode(mode: GroupMode): void {
    this.$<HTMLSelectElement>('group-mode').value = mode;
  }

  setViewMode(mode: ViewMode): void {
    this.$<HTMLSelectElement>('view-mode').value = mode;
  }

  setStats(neurons: number, synapses: number, sections: number): void {
    this.$('stat-flows').textContent = String(neurons);
    this.$('stat-syn').textContent = String(synapses);
    this.$('stat-sec').textContent = String(sections);
  }

  showTooltip(text: string, x: number, y: number): void {
    this.tooltip.textContent = text;
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;
    this.tooltip.classList.remove('hidden');
  }

  hideTooltip(): void {
    this.tooltip.classList.add('hidden');
  }

  /** The behaviour overview panel. */
  showPanel(n: Neuron, relations: RelationLine[], servers: Record<string, ServerStatus> = {}): void {
    this.showReader(
      'behaviour',
      '',
      n.name,
      n.description || (n.broken ? 'No connections — a dormant behaviour.' : ''),
      [{ title: 'behaviour prompt', text: n.prompt }],
    );

    this.$('p-kicker').innerHTML = '<span class="k">behaviour</span>';

    const chips: string[] = [];
    const c = n.counts;
    const parts = [
      c.process && `${c.process} process`,
      c.mcp && `${c.mcp} abilit${c.mcp > 1 ? 'ies' : 'y'}`,
      c.subflow && `${c.subflow} behaviour call${c.subflow > 1 ? 's' : ''}`,
    ].filter(Boolean);
    chips.push(`<span class="chip"><b>${n.nodeTotal}</b> nodes</span>`);
    for (const p of parts) chips.push(`<span class="chip">${p}</span>`);
    for (const prov of n.providers) chips.push(`<span class="chip">${esc(providerLabel(prov))}</span>`);
    this.$('p-stats').innerHTML = chips.join('');

    this.$('p-rels').innerHTML = this.renderServers(n, servers) + this.renderRelations(n, relations);
    this.$('p-hint').textContent = 'Click a node in the graph for its prompt & settings';
    this.selectionOpen = true;
    this.syncPanels();
  }

  /** Detail panel for one node inside the focused behaviour. */
  showNodePanel(
    behaviour: Neuron,
    node: InnerNode,
    servers: Record<string, ServerStatus>,
    subflowTarget: Neuron | null,
  ): void {
    const color = hex(NODE_TYPE_COLORS[node.type]);

    const prompts: PromptEntry[] = [];
    let emptyNote = '';
    if (node.type === 'process') {
      prompts.push({ title: 'prompt', text: node.prompt });
      if (!node.prompt?.trim()) emptyNote = 'No prompt set on this node.';
    } else if (node.type === 'subflow' && subflowTarget) {
      prompts.push({ title: `prompt of "${subflowTarget.name}"`, text: subflowTarget.prompt });
    }
    this.showReader(`${nodeTypeLabel(node.type)} node`, color, node.label, node.description ?? '', prompts, emptyNote);

    this.$('p-kicker').innerHTML =
      `<button class="back" id="p-back">← ${esc(behaviour.name)}</button>` +
      `<span class="k" style="color:${color}">${nodeTypeLabel(node.type)} node</span>`;

    const chips: string[] = [];
    if (node.modelName) chips.push(`<span class="chip">model <b>${esc(node.modelName)}</b></span>`);
    if (node.type === 'mcp' && node.server) {
      const s = servers[node.server] ?? 'unknown';
      chips.push(
        `<span class="chip"><span class="dot" style="color:${STATUS_COLORS[s]};background:${STATUS_COLORS[s]}"></span>${esc(node.server)} · ${s}</span>`,
      );
    }
    this.$('p-stats').innerHTML = chips.join('');

    let body = '';
    if (node.type === 'process') {
      body += `<div class="settings">
        ${toggleRow('include model prompt', node.excludeModelPrompt !== true)}
        ${toggleRow('include behaviour prompt', node.excludeStartNodePrompt !== true)}
      </div>`;
      if (node.abilities?.length) {
        const items = node.abilities
          .map((a) => {
            const s = servers[a.server] ?? 'unknown';
            const tools = a.tools.length
              ? `<div class="tools">${a.tools.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`
              : '';
            return `<li><span class="dot" style="color:${STATUS_COLORS[s]};background:${STATUS_COLORS[s]}"></span><b>${esc(a.server)}</b> <em class="status">${a.tools.length} tools</em>${tools}</li>`;
          })
          .join('');
        body += `<details><summary>abilities <b>${node.abilities.length}</b></summary><ul>${items}</ul></details>`;
      }
    } else if (node.type === 'mcp') {
      const tools = node.enabledTools ?? [];
      body += tools.length
        ? `<details open><summary>enabled tools <b>${tools.length}</b></summary><div class="tools pad">${tools.map((t) => `<span>${esc(t)}</span>`).join('')}</div></details>`
        : '<p class="empty">No tools enabled.</p>';
    } else if (node.type === 'subflow') {
      body += `<div class="settings">
        ${node.inputMode ? `<div class="setting"><span class="mode">in</span>${esc(node.inputMode)}</div>` : ''}
        ${node.outputMode ? `<div class="setting"><span class="mode">out</span>${esc(node.outputMode)}</div>` : ''}
      </div>`;
      body += subflowTarget
        ? `<p class="jump">calls <a href="#" id="p-jump">${esc(subflowTarget.name)}</a></p>`
        : '<p class="empty">Target behaviour not found.</p>';
    } else if (node.type === 'finish') {
      body += '<p class="empty">End of the behaviour — the reply is returned here.</p>';
    }

    this.$('p-rels').innerHTML = body;
    this.$('p-hint').textContent = 'Esc or ← to go back · click empty space for overview';
    this.selectionOpen = true;
    this.syncPanels();

    document.getElementById('p-back')?.addEventListener('click', () => this.onBackToBehaviour());
    const jump = document.getElementById('p-jump');
    if (jump && subflowTarget) {
      jump.addEventListener('click', (e) => {
        e.preventDefault();
        this.onFocusBehaviour(subflowTarget.id);
      });
    }
  }

  /** Abilities this behaviour binds, with live status dots. */
  private renderServers(n: Neuron, servers: Record<string, ServerStatus>): string {
    if (!n.servers.length) return '';
    const items = n.servers
      .map((name) => {
        const s = servers[name] ?? 'unknown';
        return `<li><span class="dot" style="color:${STATUS_COLORS[s]};background:${STATUS_COLORS[s]}"></span>${esc(name)} <em class="status">${s}</em></li>`;
      })
      .join('');
    return `<details open><summary>abilities <b>${n.servers.length}</b></summary><ul>${items}</ul></details>`;
  }

  /** Connections grouped by kind into collapsible sections. */
  private renderRelations(n: Neuron, relations: RelationLine[]): string {
    if (!relations.length) {
      return n.broken ? '' : '<details open><summary>connections <b>0</b></summary><ul><li>Standalone — no shared resources.</li></ul></details>';
    }

    const KINDS: Array<{ kind: SynapseKind; title: string; open: boolean }> = [
      { kind: 'subflow', title: 'behaviour calls', open: true },
      { kind: 'server', title: 'shared abilities', open: false },
      { kind: 'model', title: 'shared models', open: false },
    ];

    return KINDS.map(({ kind, title, open }) => {
      const group = relations.filter((r) => r.synapse.kind === kind);
      if (!group.length) return '';
      const color = hex(SYNAPSE_COLORS[kind]);
      const items = group
        .map((r) => {
          const name = esc(r.otherName);
          const label =
            kind === 'subflow'
              ? r.outgoing
                ? `→ calls <b>${name}</b>`
                : `← called by <b>${name}</b>`
              : `<b>${name}</b><em class="detail">${esc(r.synapse.detail)}</em>`;
          return `<li><span class="dot" style="color:${color};background:${color}"></span>${label}</li>`;
        })
        .join('');
      return `<details${open ? ' open' : ''}><summary>${title} <b>${group.length}</b></summary><ul>${items}</ul></details>`;
    }).join('');
  }

  hidePanel(): void {
    this.selectionOpen = false;
    this.syncPanels();
  }
}
