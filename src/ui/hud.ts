import type { BrainGraph, InnerNode, Neuron, ServerStatus, Synapse, SynapseKind } from '../types';
import type { GroupMode } from '../grouping';
import type { HeartbeatInfo, HeartbeatState } from '../data/heartbeat';
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

/** The tempo slider's stops: beat interval in seconds ↔ croner 6-field cron. */
const TEMPO_STOPS: Array<{ s: number; cron: string; label: string }> = [
  { s: 30, cron: '*/30 * * * * *', label: 'every 30s' },
  { s: 60, cron: '0 * * * * *', label: 'every minute' },
  { s: 180, cron: '0 */3 * * * *', label: 'every 3 min' },
  { s: 300, cron: '0 */5 * * * *', label: 'every 5 min' },
  { s: 600, cron: '0 */10 * * * *', label: 'every 10 min' },
  { s: 1800, cron: '0 */30 * * * *', label: 'every 30 min' },
  { s: 3600, cron: '0 0 * * * *', label: 'every hour' },
];

/** Best-effort: turn simple interval crons (5- or 6-field) into seconds. */
function cronSeconds(cron: string): number | null {
  const f = cron.trim().split(/\s+/);
  let m: RegExpMatchArray | null;
  if (f.length === 6) {
    const [sec, min, hour] = f;
    if ((m = sec.match(/^\*\/(\d+)$/))) return +m[1];
    if (sec !== '0' && sec !== '*') return null;
    if ((m = min.match(/^\*\/(\d+)$/))) return +m[1] * 60;
    if (min === '*') return 60;
    if (min !== '0') return null;
    if (hour === '*') return 3600;
    if ((m = hour.match(/^\*\/(\d+)$/))) return +m[1] * 3600;
    return null;
  }
  if (f.length === 5) {
    const [min, hour] = f;
    if ((m = min.match(/^\*\/(\d+)$/))) return +m[1] * 60;
    if (min === '*') return 60;
    if (/^\d+$/.test(min) && hour === '*') return 3600;
  }
  return null;
}

/** Nearest slider stop for a cron (default: the 3-minute stop). */
function tempoIndexOf(cron: string | null): number {
  const s = cron ? cronSeconds(cron) : null;
  if (s == null) return 2;
  let best = 0;
  for (let i = 1; i < TEMPO_STOPS.length; i++) {
    if (Math.abs(TEMPO_STOPS[i].s - s) < Math.abs(TEMPO_STOPS[best].s - s)) best = i;
  }
  return best;
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

/** "1m 05s" countdown formatting for the next-beat timer. */
function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * ECG amplitude at `dt` seconds from the nearest beat: a P–QRS–T complex
 * about two seconds wide, drawn in real time so the R spike lands exactly on
 * each scheduled wake-up.
 */
function ecgAt(dt: number): number {
  const g = (c: number, w: number, a: number) => a * Math.exp(-((dt - c) * (dt - c)) / (2 * w * w));
  return g(-0.9, 0.16, 0.18) + g(-0.12, 0.045, -0.22) + g(0, 0.055, 1) + g(0.13, 0.05, -0.28) + g(0.55, 0.22, 0.3);
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

export type ViewMode = '3d' | '2d' | 'history';

export class Hud {
  private $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  private panel = this.$('panel');
  private reader = this.$('reader');
  private tooltip = this.$('tooltip');
  /** True while a behaviour / node is selected (reader + panel visible). */
  private selectionOpen = false;
  private panelCollapsed = localStorage.getItem(PANEL_COLLAPSED_KEY) === '1';
  /** Last heartbeat data (the life cluster in the top bar, always visible). */
  private hbState: HeartbeatState | null = null;
  /** The beats dropdown (all planned executions) is open. */
  private hbPanelOpen = false;
  /** True while the user holds a tempo slider — polls must not snap it back. */
  private tempoDragging = false;
  /** Last whole second the beat rows' countdowns were refreshed at. */
  private hbRowTick = 0;
  /** Every neuron in the current graph, for the search results dropdown. */
  private neurons: Neuron[] = [];
  /** Behaviours currently matching the search box, in display order. */
  private results: Neuron[] = [];
  /** Highlighted result for keyboard nav (index into `results`, -1 = none). */
  private activeResult = -1;
  /** FLUJO editor base URL, once the loader resolves it (null = no link). */
  private editorBase: string | null = null;

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
  /** Tempo slider: re-arm a heartbeat with a new cron. */
  onTempo: (executionId: string, cron: string) => void | Promise<void> = () => {};
  /** ⚡ beat now: fire a planned execution immediately. */
  onBeatNow: (executionId: string) => void | Promise<void> = () => {};
  /** 💬 on a heartbeat row: open its conversation in the chat dock. */
  onOpenHeartbeat: (conversationId: string) => void = () => {};
  /**
   * The selected behaviour changed (null = overview, or an ability selected).
   * Fired from the selection panels so every renderer reports the same way;
   * the chat dock retargets its conversation to the selection.
   */
  onSelect: (behaviourId: string | null) => void = () => {};

  /** ECG animation state. */
  private ecgRaf = 0;

  constructor() {
    const search = this.$<HTMLInputElement>('search');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      this.onSearch(q);
      this.renderResults(q);
    });
    search.addEventListener('keydown', (e) => this.onSearchKey(e));
    search.addEventListener('focus', () => this.renderResults(search.value.trim().toLowerCase()));
    // Blur hides the dropdown, but only after a pending result click resolves.
    search.addEventListener('blur', () => setTimeout(() => this.hideResults(), 120));

    const results = this.$('search-results');
    // Keep focus in the input so blur/keyboard state survives a result click.
    results.addEventListener('mousedown', (e) => e.preventDefault());
    results.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest('li[data-id]') as HTMLElement | null;
      if (li) this.chooseResult(this.results.findIndex((n) => n.id === li.dataset.id));
    });

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

    // The life cluster: ♥ toggles the all-beats dropdown, ⚡ fires the primary
    // beat now; every dropdown row has its own tempo slider / ⚡ / 💬.
    this.$('heartbeat').addEventListener('click', () => this.setHbPanelOpen(!this.hbPanelOpen));
    this.$('hb-beat-now').addEventListener('click', () => {
      const p = this.hbPrimary();
      if (p) this.fireBeat(p.executionId, this.$('hb-beat-now'));
    });

    const hbPanel = this.$('hb-panel');
    // Tempo sliders: label follows the thumb live; releasing re-arms the beat.
    // While a thumb is held, polls must not rebuild the panel under the hand.
    hbPanel.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('input[type="range"]')) this.tempoDragging = true;
    });
    hbPanel.addEventListener('pointerup', () => (this.tempoDragging = false));
    hbPanel.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      const row = input.closest<HTMLElement>('.hb-row');
      if (!row || input.type !== 'range') return;
      const label = row.querySelector<HTMLElement>('.hb-tempo-label');
      if (label) label.textContent = TEMPO_STOPS[Number(input.value)]?.label ?? '';
    });
    hbPanel.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const row = input.closest<HTMLElement>('.hb-row');
      if (!row?.dataset.id || input.type !== 'range') return;
      this.tempoDragging = false;
      const stop = TEMPO_STOPS[Number(input.value)];
      if (!stop) return;
      void Promise.resolve(this.onTempo(row.dataset.id, stop.cron)).catch(() => {
        const label = row.querySelector<HTMLElement>('.hb-tempo-label');
        if (label) label.textContent = '⚠ change failed';
      });
    });
    hbPanel.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      const row = (e.target as HTMLElement).closest<HTMLElement>('.hb-row');
      if (!btn || !row?.dataset.id) return;
      if (btn.classList.contains('hb-run')) this.fireBeat(row.dataset.id, btn);
      else if (btn.classList.contains('hb-chat') && btn.dataset.conv) this.onOpenHeartbeat(btn.dataset.conv);
    });
    // Click-away closes the dropdown.
    document.addEventListener('pointerdown', (e) => {
      if (!this.hbPanelOpen) return;
      const t = e.target as HTMLElement;
      if (!t.closest('#hb-panel') && !t.closest('#heartbeat')) this.setHbPanelOpen(false);
    });
  }

  // ---- search results --------------------------------------------------------

  /** Rebuild the results dropdown for the current query (behaviours first). */
  private renderResults(q: string): void {
    if (!q) return this.hideResults();
    const matches = this.neurons.filter((n) => n.name.toLowerCase().includes(q));
    // Behaviours are what the user is looking for — list them above
    // abilities/memories.
    matches.sort((a, b) => {
      const ka = a.kind ? 1 : 0;
      const kb = b.kind ? 1 : 0;
      return ka - kb || a.name.localeCompare(b.name);
    });
    this.results = matches.slice(0, 12);
    this.activeResult = -1;

    const box = this.$('search-results');
    if (!this.results.length) {
      box.innerHTML = '<li class="empty" aria-disabled="true">no matches</li>';
    } else {
      box.innerHTML = this.results
        .map((n, i) => {
          const ability = n.kind === 'ability';
          const memory = n.kind === 'resource';
          const color = hex(NODE_TYPE_COLORS[ability ? 'mcp' : memory ? 'resource' : 'subflow']);
          const tag = ability ? 'ability' : memory ? 'memory' : `${n.nodeTotal} nodes`;
          return `<li data-id="${esc(n.id)}" role="option" id="search-opt-${i}" aria-selected="false">
            <span class="dot" style="color:${color};background:${color}"></span>
            <span class="nm">${esc(n.name)}</span>
            <em class="tag">${esc(tag)}</em>
          </li>`;
        })
        .join('');
    }
    box.classList.remove('hidden');
    this.$('search').setAttribute('aria-expanded', 'true');
  }

  private hideResults(): void {
    this.results = [];
    this.activeResult = -1;
    this.$('search-results').classList.add('hidden');
    const input = this.$('search');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  /** Move the keyboard highlight and sync the DOM + aria state. */
  private setActiveResult(i: number): void {
    const n = this.results.length;
    if (!n) return;
    this.activeResult = ((i % n) + n) % n;
    const input = this.$('search');
    this.$('search-results')
      .querySelectorAll<HTMLElement>('li[data-id]')
      .forEach((li, idx) => {
        const on = idx === this.activeResult;
        li.classList.toggle('active', on);
        li.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
          li.scrollIntoView({ block: 'nearest' });
          input.setAttribute('aria-activedescendant', li.id);
        }
      });
  }

  /** Enter / arrows / Escape while the search box has focus. */
  private onSearchKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.results.length) this.setActiveResult(this.activeResult + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.results.length) this.setActiveResult(this.activeResult - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.chooseResult(this.activeResult >= 0 ? this.activeResult : 0);
    } else if (e.key === 'Escape') {
      const input = this.$<HTMLInputElement>('search');
      if (input.value) {
        input.value = '';
        this.onSearch('');
      }
      this.hideResults();
      input.blur();
    }
  }

  /** Focus the chosen behaviour in the scene and close the dropdown. */
  private chooseResult(i: number): void {
    const n = this.results[i];
    if (!n) return;
    const input = this.$<HTMLInputElement>('search');
    input.value = n.name;
    this.onSearch(n.name.toLowerCase());
    this.onFocusBehaviour(n.id);
    this.hideResults();
    input.blur();
  }

  // ---- heartbeat (life cluster + beats dropdown) -------------------------------

  /** The beat the top-bar ECG follows (the watcher sorts: running, then soonest). */
  private hbPrimary(): HeartbeatInfo | null {
    return this.hbState?.beats[0] ?? null;
  }

  private setHbPanelOpen(open: boolean): void {
    this.hbPanelOpen = open;
    this.$('hb-panel').classList.toggle('hidden', !open);
    this.$('heartbeat').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) this.renderHbPanel();
  }

  /** Fire one beat with instant visual feedback; the poller confirms the run. */
  private fireBeat(executionId: string, btn: HTMLElement): void {
    btn.classList.add('firing');
    setTimeout(() => btn.classList.remove('firing'), 1600);
    void Promise.resolve(this.onBeatNow(executionId)).catch(() => {
      btn.classList.remove('firing');
      btn.title = '⚠ beat failed — is FLUJO reachable?';
    });
  }

  /** One beat's status line: beating… / next in… / last… / off. */
  private hbWhen(b: HeartbeatInfo): string {
    if (b.running) return 'beating…';
    if (this.hbState?.paused) return b.firedAt ? `paused · last ${relTime(b.firedAt)}` : 'paused';
    if (!b.enabled) return b.firedAt ? `off · last ${relTime(b.firedAt)}` : 'off';
    if (b.nextRun) {
      const ms = Date.parse(b.nextRun) - Date.now();
      if (Number.isFinite(ms)) return ms <= 0 ? 'due…' : `next in ${fmtCountdown(ms)}`;
    }
    if (b.firedAt) return `last ${relTime(b.firedAt)}`;
    return 'never fired';
  }

  /** The dropdown: EVERY planned execution rendered as a heartbeat row. */
  private renderHbPanel(): void {
    const state = this.hbState;
    const box = this.$('hb-panel');
    if (!state?.beats.length) {
      box.innerHTML = `<p class="hb-empty">${
        state?.paused ? 'paused — no heartbeat is armed.' : 'no heartbeats yet — ask the brain for one below.'
      }</p>`;
      return;
    }
    box.innerHTML = state.beats
      .map((b) => {
        const i = tempoIndexOf(b.cron);
        const exact = b.cron != null && cronSeconds(b.cron) === TEMPO_STOPS[i].s;
        const tempo = b.cron
          ? `<div class="hb-tempo">
              <span class="t">tempo</span>
              <input type="range" min="0" max="${TEMPO_STOPS.length - 1}" step="1" value="${i}" aria-label="tempo of ${esc(b.name)}" />
              <span class="hb-tempo-label">${esc(exact ? TEMPO_STOPS[i].label : b.cron!)}</span>
            </div>`
          : '';
        return `<div class="hb-row${b.running ? ' running' : ''}${b.enabled ? '' : ' off'}" data-id="${esc(b.executionId)}">
          <div class="hb-row-head">
            <span class="beat">♥</span>
            <b class="hb-name" title="${esc(b.name)}">${esc(b.name)}</b>
            <span class="hb-when">${esc(this.hbWhen(b))}</span>
            <button class="hb-run" title="beat now">⚡</button>
            <button class="hb-chat" title="open the last beat's conversation" ${
              b.conversationId ? `data-conv="${esc(b.conversationId)}"` : 'disabled'
            }>💬</button>
          </div>
          ${tempo}
        </div>`;
      })
      .join('');
  }

  /** Run the ECG only while the cluster is actually on screen. */
  private syncEcg(): void {
    const visible = this.hbState && !this.$('heartbeat').classList.contains('hidden');
    if (visible && !this.ecgRaf) {
      const loop = () => {
        this.drawEcg();
        this.refreshHbRows();
        this.ecgRaf = requestAnimationFrame(loop);
      };
      this.ecgRaf = requestAnimationFrame(loop);
    } else if (!visible && this.ecgRaf) {
      cancelAnimationFrame(this.ecgRaf);
      this.ecgRaf = 0;
    }
  }

  /** Once a second, refresh the dropdown rows' countdowns in place. */
  private refreshHbRows(): void {
    const sec = Math.floor(Date.now() / 1000);
    if (!this.hbPanelOpen || this.tempoDragging || sec === this.hbRowTick) return;
    this.hbRowTick = sec;
    this.$('hb-panel')
      .querySelectorAll<HTMLElement>('.hb-row')
      .forEach((row) => {
        const b = this.hbState?.beats.find((x) => x.executionId === row.dataset.id);
        const el = row.querySelector<HTMLElement>('.hb-when');
        if (b && el) el.textContent = this.hbWhen(b);
      });
  }

  private drawEcg(): void {
    const state = this.hbState;
    const p = this.hbPrimary();
    const canvas = this.$('hb-ecg') as unknown as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!state || !ctx) return;

    const w = canvas.width;
    const ht = canvas.height;
    const now = Date.now();
    const mid = ht * 0.62;
    const amp = ht * 0.5;
    ctx.clearRect(0, 0, w, ht);

    // Paused, disarmed or beatless — a flatline, never an absence: the life
    // cluster stays on screen so the state is always visible.
    const alive = p && (p.running || (p.enabled && !state.paused));
    if (!alive) {
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(255,92,138,0.35)';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
      this.$('hb-next').textContent = state.paused ? 'paused' : p ? 'off' : 'no heartbeat';
      return;
    }

    const fired = p.firedAt ? Date.parse(p.firedAt) : now;
    const next = p.nextRun ? Date.parse(p.nextRun) : NaN;
    const intervalS = p.cron ? cronSeconds(p.cron) : null;
    const running = p.running;

    ctx.lineWidth = 1.4;
    ctx.strokeStyle = running ? 'rgba(255,92,138,1)' : 'rgba(255,92,138,0.75)';
    ctx.shadowColor = 'rgba(255,92,138,0.55)';
    ctx.shadowBlur = running ? 7 : 4;
    ctx.beginPath();

    if (intervalS) {
      // Window = one full interval: the last spike drifts left, the next one
      // lands on the right edge exactly when the countdown hits zero.
      const windowMs = Math.min(intervalS, 3600) * 1000 * 1.04;
      const intervalMs = intervalS * 1000;
      // Spikes are anchored on FLUJO's own next-fire prediction when known,
      // else on the last fire (beats at anchor + k*interval).
      const anchor = Number.isFinite(next) ? next : fired;
      // Slow hearts get a proportionally wider complex so the spike stays
      // visible on a window that spans the whole interval.
      const stretch = Math.min(1, 90 / intervalS);
      for (let x = 0; x <= w; x++) {
        const t = now - (w - x) * (windowMs / w);
        let dt = ((t - anchor) % intervalMs) / 1000;
        if (dt > intervalS / 2) dt -= intervalS;
        if (dt < -intervalS / 2) dt += intervalS;
        const y = mid - ecgAt(dt * stretch) * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const nextIn = Number.isFinite(next)
        ? next - now
        : intervalMs - (((now - fired) % intervalMs) + intervalMs) % intervalMs;
      this.$('hb-next').textContent = running ? 'beating…' : nextIn <= 0 ? 'due…' : `next in ${fmtCountdown(nextIn)}`;
    } else {
      // No readable schedule — a calm idle ripple.
      for (let x = 0; x <= w; x++) {
        const y = mid - Math.sin(now / 700 + x * 0.08) * ht * 0.06;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const nextIn = Number.isFinite(next) ? next - now : null;
      this.$('hb-next').textContent = running ? 'beating…' : nextIn != null && nextIn > 0 ? `next in ${fmtCountdown(nextIn)}` : '';
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
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
    // The heartbeat lives in the top bar next to pause/resume — always visible,
    // whatever is selected. Its visibility is handled by setHeartbeat alone.
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

  /** FLUJO editor base (per-instance), for the reader's "open in editor" link. */
  setEditorBase(url: string): void {
    this.editorBase = url.replace(/\/+$/, '');
  }

  /** The deep link that opens a given flow in this instance's FLUJO editor.
   *  FLUJO's /flows page reads ?flow=<id>; older builds ignore it and land on
   *  the dashboard, so the link degrades gracefully. */
  private editorLink(flowId: string): string {
    return `${this.editorBase}/flows?flow=${encodeURIComponent(flowId)}`;
  }

  /** The big-type reader on the left: name, description, prompts. */
  private showReader(
    kicker: string,
    kickerColor: string,
    name: string,
    desc: string,
    prompts: PromptEntry[],
    emptyNote = '',
    editorFlowId: string | null = null,
  ): void {
    this.$('r-kicker').innerHTML =
      `<span class="k"${kickerColor ? ` style="color:${kickerColor}"` : ''}>${esc(kicker)}</span>`;
    this.$('r-name').textContent = name;
    const d = this.$('r-desc');
    d.textContent = desc;
    d.style.display = desc ? '' : 'none';
    // "Open in editor" — only for behaviours (flows), and only once we know
    // where this instance's editor lives.
    const actions = this.$('r-actions');
    if (editorFlowId && this.editorBase) {
      actions.innerHTML =
        `<a class="edit-link" href="${this.editorLink(editorFlowId)}" target="_blank" rel="noopener">` +
        `<span class="ic">✎</span> Open in Editor</a>`;
      actions.style.display = '';
    } else {
      actions.innerHTML = '';
      actions.style.display = 'none';
    }
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

  /** Update the life cluster (top bar, always visible) + the beats dropdown. */
  setHeartbeat(state: HeartbeatState | null): void {
    this.hbState = state;
    const cluster = this.$('heartbeat');
    const p = this.hbPrimary();
    // The cluster shows whenever we know ANY vitals — beats or a paused
    // scheduler. Only a brain with no data at all hides it.
    const show = Boolean(state && (state.beats.length || state.paused));
    cluster.classList.toggle('hidden', !show);
    cluster.classList.toggle('running', Boolean(p?.running));
    cluster.classList.toggle('paused', Boolean(state?.paused));
    // The count chip: how many beats live behind the dropdown.
    const n = state?.beats.length ?? 0;
    const count = this.$('hb-count');
    count.classList.toggle('hidden', n < 2);
    count.textContent = n >= 2 ? String(n) : '';
    // ⚡ needs a target beat.
    this.$('hb-beat-now').classList.toggle('hidden', !p);
    if (!show && this.hbPanelOpen) this.setHbPanelOpen(false);
    else if (this.hbPanelOpen && !this.tempoDragging) this.renderHbPanel();
    this.syncEcg();
  }

  setGroupMode(mode: GroupMode): void {
    this.$<HTMLSelectElement>('group-mode').value = mode;
  }

  setViewMode(mode: ViewMode): void {
    this.$<HTMLSelectElement>('view-mode').value = mode;
  }

  /** The searchable set of neurons — kept current from the graph loader so
   *  the results dropdown works in every view, including history. */
  setSearchIndex(neurons: Neuron[]): void {
    this.neurons = neurons;
    // Drop any results that referred to a since-removed behaviour.
    const input = this.$<HTMLInputElement>('search');
    if (!this.$('search-results').classList.contains('hidden')) {
      this.renderResults(input.value.trim().toLowerCase());
    }
  }

  setStats(graph: BrainGraph, sections: number): void {
    const abilities = graph.neurons.filter((n) => n.kind === 'ability').length;
    this.$('stat-flows').textContent = String(graph.neurons.length - abilities);
    this.$('stat-abilities').textContent = String(abilities);
    this.$('stat-syn').textContent = String(graph.synapses.length);
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
    if (n.kind === 'ability') {
      this.onSelect(null); // abilities can't chat — the dock falls back
      this.showAbilityPanel(n, relations, servers);
      return;
    }
    if (n.kind === 'resource') {
      this.onSelect(null); // memories can't chat either
      this.showResourcePanel(n, relations);
      return;
    }
    this.onSelect(n.id);
    this.showReader(
      'behaviour',
      '',
      n.name,
      n.description || (n.broken ? 'No connections — a dormant behaviour.' : ''),
      [{ title: 'behaviour prompt', text: n.prompt }],
      '',
      n.id,
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

  /** Overview panel for an ability (MCP server) neuron. */
  private showAbilityPanel(n: Neuron, relations: RelationLine[], servers: Record<string, ServerStatus>): void {
    const color = hex(NODE_TYPE_COLORS.mcp);
    const status = servers[n.name] ?? 'unknown';
    this.showReader(
      'ability',
      color,
      n.name,
      n.description || 'An MCP server — a skill this brain can use.',
      [],
    );

    this.$('p-kicker').innerHTML = `<span class="k" style="color:${color}">ability</span>`;

    const users = relations.filter((r) => r.synapse.kind === 'server');
    const chips = [
      `<span class="chip"><span class="dot" style="color:${STATUS_COLORS[status]};background:${STATUS_COLORS[status]}"></span>${status}</span>`,
      `<span class="chip"><b>${users.length}</b> behaviour${users.length === 1 ? '' : 's'}</span>`,
    ];
    this.$('p-stats').innerHTML = chips.join('');

    const dot = hex(SYNAPSE_COLORS.server);
    const items = users
      .map((r) => `<li><span class="dot" style="color:${dot};background:${dot}"></span><b>${esc(r.otherName)}</b></li>`)
      .join('');
    this.$('p-rels').innerHTML = items
      ? `<details open><summary>used by <b>${users.length}</b></summary><ul>${items}</ul></details>`
      : '<details open><summary>used by <b>0</b></summary><ul><li>No behaviour uses this ability yet.</li></ul></details>';
    this.$('p-hint').textContent = 'Esc or click empty space for overview';
    this.selectionOpen = true;
    this.syncPanels();
  }

  /** Overview panel for a memory (data artifact) neuron (Tier 3). */
  private showResourcePanel(n: Neuron, relations: RelationLine[]): void {
    const color = hex(NODE_TYPE_COLORS.resource);
    this.showReader(
      'memory',
      color,
      n.name,
      n.description || 'A data artifact behaviours read or write.',
      [],
    );

    this.$('p-kicker').innerHTML = `<span class="k" style="color:${color}">memory</span>`;

    const touching = relations.filter((r) => r.synapse.kind === 'resource');
    const writers = touching.filter((r) => r.synapse.directed);
    const chips = [
      ...(n.uri ? [`<span class="chip">${esc(n.uri)}</span>`] : []),
      `<span class="chip"><b>${touching.length}</b> behaviour${touching.length === 1 ? '' : 's'}</span>`,
    ];
    this.$('p-stats').innerHTML = chips.join('');

    const dot = hex(SYNAPSE_COLORS.resource);
    const items = touching
      .map((r) => `<li><span class="dot" style="color:${dot};background:${dot}"></span><b>${esc(r.otherName)}</b>${r.synapse.directed ? ' <em class="tag">writes</em>' : ''}</li>`)
      .join('');
    this.$('p-rels').innerHTML = items
      ? `<details open><summary>touched by <b>${touching.length}</b>${writers.length ? ` · ${writers.length} writer${writers.length === 1 ? '' : 's'}` : ''}</summary><ul>${items}</ul></details>`
      : '<details open><summary>touched by <b>0</b></summary><ul><li>No behaviour references this memory yet.</li></ul></details>';
    this.$('p-hint').textContent = 'Esc or click empty space for overview';
    this.selectionOpen = true;
    this.syncPanels();
  }

  /** Detail panel for one node inside the focused behaviour. */
  showNodePanel(
    behaviour: Neuron,
    node: InnerNode,
    servers: Record<string, ServerStatus>,
    subflowTarget: Neuron | null,
    nodeMessages: Array<{ role: string; text: string }> = [],
  ): void {
    this.onSelect(behaviour.id);
    const color = hex(NODE_TYPE_COLORS[node.type]);

    const prompts: PromptEntry[] = [];
    let emptyNote = '';
    if (node.type === 'process') {
      prompts.push({ title: 'prompt', text: node.prompt });
      if (!node.prompt?.trim()) emptyNote = 'No prompt set on this node.';
    } else if (node.type === 'subflow' && subflowTarget) {
      prompts.push({ title: `prompt of "${subflowTarget.name}"`, text: subflowTarget.prompt });
    }
    this.showReader(`${nodeTypeLabel(node.type)} node`, color, node.label, node.description ?? '', prompts, emptyNote, behaviour.id);

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

    // Per-neuron conversation view: what was said AT this node in the chat
    // dock's current conversation.
    if (nodeMessages.length) {
      const items = nodeMessages
        .map((m) => `<li class="nmsg ${m.role === 'user' ? 'user' : 'ai'}">${esc(m.text.length > 400 ? `${m.text.slice(0, 400)}…` : m.text)}</li>`)
        .join('');
      body += `<details open><summary>conversation here <b>${nodeMessages.length}</b></summary><ul class="nmsgs">${items}</ul></details>`;
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
      { kind: 'server', title: 'abilities used', open: false },
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
              : kind === 'server'
                ? `uses <b>${name}</b>`
                : `<b>${name}</b><em class="detail">${esc(r.synapse.detail)}</em>`;
          return `<li><span class="dot" style="color:${color};background:${color}"></span>${label}</li>`;
        })
        .join('');
      return `<details${open ? ' open' : ''}><summary>${title} <b>${group.length}</b></summary><ul>${items}</ul></details>`;
    }).join('');
  }

  /** `keepSelection` (renderer teardown): hide the panels without telling
   *  the chat dock to retarget — the user didn't deselect anything. */
  hidePanel(keepSelection = false): void {
    if (this.selectionOpen && !keepSelection) this.onSelect(null);
    this.selectionOpen = false;
    this.syncPanels();
  }
}
