import type { Neuron, ServerStatus, Synapse, SynapseKind } from '../types';
import type { GroupMode } from '../grouping';
import { SYNAPSE_COLORS, providerLabel } from '../theme';

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

export interface RelationLine {
  synapse: Synapse;
  otherName: string;
  outgoing: boolean;
}

export class Hud {
  private $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  private panel = this.$('panel');
  private tooltip = this.$('tooltip');

  onSearch: (q: string) => void = () => {};
  onToggleKind: (k: SynapseKind, on: boolean) => void = () => {};
  onCloseFocus: () => void = () => {};
  onGroupMode: (mode: GroupMode) => void = () => {};

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

    this.$('panel-close').addEventListener('click', () => this.onCloseFocus());
  }

  setGroupMode(mode: GroupMode): void {
    this.$<HTMLSelectElement>('group-mode').value = mode;
  }

  setSource(source: 'live' | 'snapshot'): void {
    const badge = this.$('source-badge');
    badge.textContent = source === 'live' ? '● live from FLUJO' : '○ bundled snapshot';
    badge.classList.toggle('snapshot', source === 'snapshot');
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

  showPanel(n: Neuron, relations: RelationLine[], servers: Record<string, ServerStatus> = {}): void {
    this.$('p-name').textContent = n.name;
    const desc = this.$('p-desc');
    desc.textContent = n.description || (n.broken ? 'No connections — a dormant flow.' : '');
    desc.style.display = desc.textContent ? '' : 'none';

    const chips: string[] = [];
    const c = n.counts;
    const parts = [
      c.process && `${c.process} process`,
      c.mcp && `${c.mcp} mcp`,
      c.subflow && `${c.subflow} subflow`,
    ].filter(Boolean);
    chips.push(`<span class="chip"><b>${n.nodeTotal}</b> nodes</span>`);
    for (const p of parts) chips.push(`<span class="chip">${p}</span>`);
    for (const prov of n.providers) chips.push(`<span class="chip">${esc(providerLabel(prov))}</span>`);
    this.$('p-stats').innerHTML = chips.join('');

    this.$('p-rels').innerHTML = this.renderServers(n, servers) + this.renderRelations(n, relations);
    this.panel.classList.remove('hidden');
  }

  /** MCP servers this flow binds, with live status dots. */
  private renderServers(n: Neuron, servers: Record<string, ServerStatus>): string {
    if (!n.servers.length) return '';
    const items = n.servers
      .map((name) => {
        const s = servers[name] ?? 'unknown';
        return `<li><span class="dot" style="color:${STATUS_COLORS[s]};background:${STATUS_COLORS[s]}"></span>${esc(name)} <em class="status">${s}</em></li>`;
      })
      .join('');
    return `<details open><summary>mcp servers <b>${n.servers.length}</b></summary><ul>${items}</ul></details>`;
  }

  /** Connections grouped by kind into collapsible sections. */
  private renderRelations(n: Neuron, relations: RelationLine[]): string {
    if (!relations.length) {
      return n.broken ? '' : '<details open><summary>connections <b>0</b></summary><ul><li>Standalone — no shared resources.</li></ul></details>';
    }

    const KINDS: Array<{ kind: SynapseKind; title: string; open: boolean }> = [
      { kind: 'subflow', title: 'subflow calls', open: true },
      { kind: 'server', title: 'shared mcp servers', open: false },
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
    this.panel.classList.add('hidden');
  }
}
