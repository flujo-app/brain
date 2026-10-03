import './swarm.css';
import './observatory.css';
import { activities, nodeKey, parseSwarm, SwarmIndex, type Node, type Selection, type Source, type Swarm } from './model';
import { SwarmRenderer } from './renderer';
import { swarmPreview } from './preview';

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const element = <T extends keyof HTMLElementTagNameMap>(tag: T, text?: string, className?: string): HTMLElementTagNameMap[T] => {
  const result = document.createElement(tag); if (text !== undefined) result.textContent = text; if (className) result.className = className; return result;
};
const button = (text: string, action: () => void, pressed = false): HTMLButtonElement => { const result = element('button', text); result.type = 'button'; result.setAttribute('aria-pressed', String(pressed)); result.onclick = action; return result; };
const timestamp = (value: string): string => new Intl.DateTimeFormat(undefined, { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
const taskLabel = (status: string) => status === 'completed' ? 'operation completed' : status;
const empty = (): Swarm => ({ schemaVersion: 1, scope: 'operator-source-registry', observedAt: new Date().toISOString(), commands: false, sources: [] });
const query = new URLSearchParams(location.search), embedded = query.get('embed') === '1', channel = query.get('channel') ?? '';
const preview = !embedded && query.get('preview') === '1';
let swarm = empty(), index = new SwarmIndex(swarm), selection: Selection | null = null, page = 0, frameSequence = 0, lastStats = 0;
let renderer: SwarmRenderer;
let mode: '3d' | '2d' = query.get('view') === '2d' || ((navigator.hardwareConcurrency ?? 8) <= 4) ? '2d' : '3d';
let lastActivity = '', follow = false, firstObservation = true;
const selectionHash = (): Selection | null => {
  const hash = new URLSearchParams(location.hash.slice(1)), sourceId = hash.get('source'), kind = hash.get('kind'), id = hash.get('id');
  return sourceId && id && ['source', 'cell', 'task', 'effect'].includes(kind ?? '') ? { sourceId, kind: kind as Selection['kind'], id } : null;
};

function validSelection(value: Selection): boolean {
  const source = index.sources.get(value.sourceId); if (!source) return false;
  return value.kind === 'source' ? value.id === source.id : value.kind === 'cell' ? source.snapshot?.snapshot.cells.some(cell => cell.id === value.id) === true : value.kind === 'task' ? source.snapshot?.snapshot.tasks.some(task => task.id === value.id) === true : source.snapshot?.snapshot.effects.some(effect => effect.key === value.id) === true;
}
function select(next: Selection | null, move = true): void {
  if (next && !validSelection(next)) return;
  selection = next; page = 0;
  document.body.classList.toggle('has-selection', !!next);
  const hash = next ? new URLSearchParams({ source: next.sourceId, kind: next.kind, id: next.id }).toString() : '';
  history.replaceState(null, '', `${location.pathname}${location.search}${hash ? `#${hash}` : ''}`);
  redraw(); if (move) frameSelection();
  if (embedded) window.parent.postMessage({ protocol: 'brain-swarm/1', type: 'select', channel, selection: next }, location.origin);
}
function sourceStatus(source: Source): string {
  const age = source.snapshot ? Date.now() - Date.parse(source.snapshot.observedAt) : Infinity;
  return source.status === 'observed' && !swarm.sample && age > 15000 ? 'stale' : source.status;
}
function focusNode(): Node | undefined { return selection ? index.nodeFor(selection) : undefined; }
function frameSelection(): void {
  const node = focusNode();
  if (node && (!node.cell || node.cell.role === 'coordinator')) renderer.frame(undefined, node.source.id);
  else renderer.frame(node?.point);
}

function createRenderer(): void {
  renderer?.dispose();
  const canvas = element('canvas'); canvas.id = 'swarm-canvas'; canvas.tabIndex = 0; canvas.setAttribute('aria-label', 'Spatial swarm. Use navigation buttons to select cells; Home fits the whole swarm.');
  $('swarm-canvas').replaceWith(canvas);
  renderer = new SwarmRenderer(canvas, $('swarm-labels'), mode); mode = renderer.mode;
  (document.getElementById('swarm-mode') as HTMLSelectElement).value = mode;
  renderer.onPick = node => select(node.selection);
  renderer.onStats = stats => {
    const diagnostics = $('swarm-diagnostics');
    Object.assign(diagnostics.dataset, { mode: stats.mode, visible: String(stats.visible), indexed: String(index.nodes.size), labels: String(stats.labels), draws: String(stats.draws), frames: String(stats.submissions), cpuMs: stats.cpuMs.toFixed(3) });
    if (performance.now() - lastStats < 500) return; lastStats = performance.now();
    diagnostics.textContent = `${stats.mode.toUpperCase()} · ${stats.visible} drawn / ${index.nodes.size} indexed nodes · ${stats.labels} labels · ${stats.draws} GL draw calls · ${stats.cpuMs.toFixed(2)} ms CPU submission · ${stats.submissions} frames`;
  };
  redraw(); frameSelection();
}

function paintNavigation(): void {
  const sourceList = $('source-list'); sourceList.replaceChildren();
  for (const source of index.sources.values()) {
    const item = button(source.label, () => select({ sourceId: source.id, kind: 'source', id: source.id }), selection?.sourceId === source.id);
    item.className = `source-record source-${sourceStatus(source)}`;
    item.append(element('small', `${sourceStatus(source)} · ${source.snapshot?.snapshot.cells.length ?? 0} cells`)); item.title = source.factoryId; sourceList.append(item);
  }
  const focus = focusNode(), children = focus ? index.children.get(focus.key) ?? [] : [];
  $('branch-heading').textContent = focus ? `${focus.label} · ${children.length} children` : 'Select a source to explore its delegation';
  $('branch-list').replaceChildren(); $('branch-pages').replaceChildren();
  for (const key of children.slice(page * 128, (page + 1) * 128)) {
    const node = index.nodes.get(key)!;
    const item = button(node.label, () => select(node.selection), key === focus?.key);
    item.append(element('small', `${node.cell?.role ?? 'source'} · ${node.cell?.status ?? sourceStatus(node.source)} · ${index.children.get(key)?.length ?? 0} children`));
    $('branch-list').append(item);
  }
  if (children.length > 128) {
    const previous = button('Previous children', () => { page--; redraw(); }); previous.disabled = page === 0;
    const next = button('Next children', () => { page++; redraw(); }); next.disabled = (page + 1) * 128 >= children.length;
    $('branch-pages').append(previous, element('p', `Children ${page * 128 + 1}–${Math.min(children.length, (page + 1) * 128)} of ${children.length}`), next);
  }
  const path = $('swarm-path'); path.replaceChildren(button('Swarm', () => select(null)));
  if (focus) {
    const ancestors = index.ancestors(focus.key), shown = ancestors.length > 6 ? [ancestors[0]!, ...ancestors.slice(-4)] : ancestors;
    if (ancestors.length > 6) path.append(element('span', `${ancestors.length - 5} intermediate levels`));
    for (const node of shown) path.append(element('span', '/'), button(node.label, () => select(node.selection), node.key === focus.key));
  }
  paintSearch();
}
function paintSearch(): void {
  const query = (document.getElementById('swarm-search') as HTMLInputElement).value, results = $('search-results'); results.replaceChildren();
  const matches = index.search(query); if (!query.trim()) return;
  results.append(element('p', `${matches.length} matches across all indexed sources. Refine the search to reach a specific identity.`));
  for (const match of matches.slice(0, 60)) {
    const source = index.sources.get(match.sourceId)!;
    const item = button(`${match.id} · ${source.label} · ${match.kind}`, () => select(match)); item.title = `${source.factoryId} / ${match.id}`; results.append(item);
  }
}
function evidenceList(container: HTMLElement, pairs: Array<[string, string]>): void {
  const list = element('dl'); for (const [key, value] of pairs) list.append(element('dt', key), element('dd', value)); container.append(list);
}
function paintInspector(): void {
  const container = $('swarm-inspect'); container.replaceChildren();
  if (!selection) { container.append(element('h2', 'A constellation of work.'), element('p', 'Move from registered authorities to their coordinators and delegated cells. Search reaches every recorded cell, task and external effect.'), element('p', 'This view follows observations. It cannot start, stop or resume workers.'), element('p', 'Select a source to inspect its provenance and recorded work.')); return; }
  const source = index.sources.get(selection.sourceId)!;
  container.append(element('div', `${sourceStatus(source)} · ${source.label}`, 'source-state'), element('h2', selection.kind === 'source' ? source.label : selection.id));
  evidenceList(container, [['Factory identity', source.factoryId], ['Registry source', source.id]]);
  const envelope = source.snapshot;
  if (!envelope) { container.append(element('p', 'This registered source has no available observation. No cells or execution state are inferred.', 'evidence-note')); return; }
  const state = envelope.snapshot;
  if (sourceStatus(source) !== 'observed') container.append(element('p', 'Retained observation. Activity is unconfirmed until this authority is read successfully again.', 'evidence-note'));
  if (selection.kind === 'source') {
    container.append(element('p', state.control.mission));
    evidenceList(container, [['Scope', envelope.scope], ['Observed build', envelope.buildRevision], ['Controller revision', String(envelope.revision)], ['Snapshot read', timestamp(envelope.observedAt)], ['Controller admission', `${state.control.status} · epoch ${state.control.epoch}`], ['Recorded work', `${state.tasks.length} tasks · ${state.effects.length} effects`], ['Worker quiescence', 'unverified']]);
    container.append(element('h3', 'Recorded tasks'));
    appendTasks(container, source, state.tasks);
    container.append(element('p', 'Provider host identity, worker health and final paid billing are not established by this contract.', 'evidence-note'));
  } else if (selection.kind === 'cell') {
    const cell = state.cells.find(cell => cell.id === selection!.id)!;
    container.append(element('p', cell.purpose));
    evidenceList(container, [['Role / lifecycle', `${cell.role} / ${cell.status}`], ['Recorded parent', cell.parentId ?? 'Local root'], ['Heartbeat', timestamp(cell.heartbeat)], ['Activity evidence', activities(source, Date.now(), swarm.sample).get(cell.id) ?? 'idle'], ['Logical allocation', `$${(cell.allocationCents / 100).toFixed(2)} · logical-allocation`], ['Worker quiescence', 'unverified']]);
    container.append(element('h3', 'Owned tasks')); appendTasks(container, source, state.tasks.filter(task => task.owner === cell.id));
    container.append(element('h3', 'Owned external effects')); appendEffects(container, source, state.effects.filter(effect => effect.owner === cell.id));
    if (cell.parentId && !state.cells.some(parent => parent.id === cell.parentId)) container.append(element('p', 'The parent is absent from this observation. Its position does not prove a delegation link.', 'evidence-note'));
  } else if (selection.kind === 'task') {
    const task = state.tasks.find(task => task.id === selection!.id)!;
    if (task.status === 'completed') container.append(element('p', 'Operation completed. Software review and delivery are not established by this status.', 'evidence-note'));
    if (task.status === 'cancelled') container.append(element('p', 'Cancelled: abandoned work or unmet acceptance. Candidate and review hashes remain historical evidence.', 'evidence-note'));
    evidenceList(container, [['Task status', taskLabel(task.status)], ['Project / branch', `${task.projectId} / ${task.branch}`], ['Attempt', String(task.attempt)], ['Lease expiry', task.leaseExpiry ? timestamp(task.leaseExpiry) : 'None recorded'], ['Specification SHA256', task.specDigest], ['Candidate SHA256', task.candidate?.sha256 ?? 'None recorded'], ['Review verdict', task.review ? task.review.accepted ? 'Recorded accepted review' : 'Recorded rejected review' : 'None recorded'], ['Review evidence SHA256', task.review?.evidenceDigest ?? 'None recorded'], ['Reviewed candidate SHA256', task.review?.candidateDigest ?? 'None recorded'], ['Reviewed spec SHA256', task.review?.specDigest ?? 'None recorded'], ['Review attempt', task.review ? String(task.review.attempt) : 'None recorded']]);
    if (task.owner) container.append(button(`Inspect owner · ${task.owner}`, () => select({ sourceId: source.id, kind: 'cell', id: task.owner! })));
    appendEffects(container, source, state.effects.filter(effect => effect.taskId === task.id));
  } else {
    const effect = state.effects.find(effect => effect.key === selection!.id)!;
    evidenceList(container, [['Kind / outcome', `${effect.kind} / ${effect.state}`], ['Scope', `${effect.scope} / ${effect.scopeId}`], ['Owner epochs', `${effect.ownerEpoch} / controller ${effect.controlEpoch}`], ['Created', timestamp(effect.createdAt)], ['Updated', timestamp(effect.updatedAt)], ['Request SHA256', effect.requestDigest]]);
    container.append(button(`Inspect owner · ${effect.owner}`, () => select({ sourceId: source.id, kind: 'cell', id: effect.owner })));
    if (effect.taskId) container.append(button(`Inspect task · ${effect.taskId}`, () => select({ sourceId: source.id, kind: 'task', id: effect.taskId! })));
    if (effect.state === 'unknown') container.append(element('p', 'The external outcome is unknown. Do not infer success, retry eligibility or stopped workers.', 'evidence-note'));
  }
  if (index.issues.length) container.append(element('p', index.issues.slice(0, 3).join('. '), 'evidence-note'));
}
function appendTasks(container: HTMLElement, source: Source, tasks: NonNullable<Source['snapshot']>['snapshot']['tasks']): void {
  if (!tasks.length) container.append(element('p', 'No tasks recorded.'));
  for (const task of tasks.slice(0, 50)) container.append(button(`${task.id} · ${taskLabel(task.status)}`, () => select({ sourceId: source.id, kind: 'task', id: task.id })));
  if (tasks.length > 50) container.append(element('p', `${tasks.length} tasks indexed. Search reaches each full identity.`));
}
function appendEffects(container: HTMLElement, source: Source, effects: NonNullable<Source['snapshot']>['snapshot']['effects']): void {
  for (const effect of effects.slice(0, 50)) container.append(button(`${effect.key} · ${effect.state}`, () => select({ sourceId: source.id, kind: 'effect', id: effect.key })));
  if (effects.length > 50) container.append(element('p', `${effects.length} effects indexed. Search reaches each full identity.`));
}
function paintTracking(): void {
  const source = selection ? index.sources.get(selection.sourceId) : null;
  $('tracking-scope').textContent = source ? `${source.label} · recorded controller events` : 'Choose a source';
  const container = $('tracking-list'); container.replaceChildren();
  if (!source?.events.length) { container.append(element('p', 'No event metadata has been collected in this view. Current topology comes from snapshots; events do not reconstruct missing history.')); return; }
  for (const event of source.events.slice(-30).reverse()) {
    const row = element('div', undefined, 'tracking-row'); const time = element('time', timestamp(event.observedAt)); time.dateTime = event.observedAt;
    row.append(time, element('span', `${event.seq} · ${event.type}`), element('span', event.subject)); container.append(row);
  }
}
function redraw(): void {
  const focus = focusNode(), visible = index.visible(focus?.key ?? null, page);
  renderer?.setNodes(visible, focus?.key ?? null);
  document.body.classList.toggle('has-selection', !!selection);
  paintNavigation(); paintInspector(); paintTracking();
  const cells = swarm.sources.reduce((sum, source) => sum + (source.snapshot?.snapshot.cells.length ?? 0), 0), tasks = swarm.sources.reduce((sum, source) => sum + (source.snapshot?.snapshot.tasks.length ?? 0), 0);
  $('swarm-counts').textContent = `${swarm.sources.length} registered sources · ${cells.toLocaleString()} recorded cells · ${tasks.toLocaleString()} tasks`;
  const stale = swarm.sources.filter(source => sourceStatus(source) !== 'observed').length;
  $('swarm-status').textContent = swarm.sample ? `Design preview · sample data · ${cells.toLocaleString()} cells` : swarm.sources.length ? `Live tracking · five-second observations · ${stale} stale/unavailable sources` : 'Observation unavailable · no registered facts';
  $('swarm-status').classList.toggle('sample-notice', !!swarm.sample);
}
function observe(value: unknown): void {
  const wasFirst = firstObservation;
  const next = parseSwarm(value), previous = new Map(swarm.sources.map(source => [source.id, source]));
  // Standalone and embedded readers both preserve each authority's own floor.
  next.sources = next.sources.map(source => {
    const old = previous.get(source.id);
    if (!old || old.factoryId !== source.factoryId) return source;
    if (!source.snapshot || (old.snapshot && source.snapshot.revision < old.snapshot.revision)) return { ...source, snapshot: old.snapshot, status: old.snapshot ? 'stale' : 'unavailable', events: old.events };
    return source;
  });
  swarm = next; index = new SwarmIndex(next);
  if (selection && !validSelection(selection)) selection = null;
  if (firstObservation) { const wanted = selectionHash(); if (wanted && validSelection(wanted)) selection = wanted; firstObservation = false; }
  const active = [...index.nodes.values()].filter(node => node.activity === 'recent').map(node => node.key).sort().join('|');
  const changedActivity = active && active !== lastActivity; lastActivity = active;
  redraw();
  if (follow && changedActivity) { const node = [...index.nodes.values()].find(node => node.activity === 'recent'); if (node) select(node.selection); }
  else if (wasFirst) frameSelection();
}

createRenderer();
($('swarm-search') as HTMLInputElement).oninput = paintSearch;
($('swarm-mode') as HTMLSelectElement).onchange = event => { mode = (event.target as HTMLSelectElement).value as '3d' | '2d'; createRenderer(); };
($('swarm-follow') as HTMLInputElement).onchange = event => { follow = (event.target as HTMLInputElement).checked; };
$('swarm-home').onclick = () => select(null);
$('swarm-close').onclick = () => select(null, false);
$('swarm-explore').onclick = () => { const hidden = document.body.classList.toggle('navigation-hidden'); $('swarm-explore').setAttribute('aria-expanded', String(!hidden)); };
$('swarm-find').onclick = () => { document.body.classList.remove('navigation-hidden'); document.body.classList.add('search-open'); $('swarm-search').focus(); };
window.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) { event.preventDefault(); document.body.classList.remove('navigation-hidden'); document.body.classList.add('search-open'); $('swarm-search').focus(); }
  if (event.key === 'Escape' || event.key === 'Backspace') { const node = focusNode(), parent = node?.parent && index.nodes.get(node.parent); event.preventDefault(); select(parent ? parent.selection : null); }
  if ((event.key === '[' || event.key === ']') && swarm.sources.length) {
    const position = Math.max(0, swarm.sources.findIndex(source => source.id === selection?.sourceId)), source = swarm.sources[(position + (event.key === '[' ? -1 : 1) + swarm.sources.length) % swarm.sources.length]!;
    event.preventDefault(); select({ sourceId: source.id, kind: 'source', id: source.id });
  }
  if (event.target === $('swarm-canvas') && selection) {
    const node = focusNode();
    if (event.key === 'ArrowUp') { const parent = node?.parent && index.nodes.get(node.parent); if (parent) { event.preventDefault(); select(parent.selection); } }
    if (event.key === 'ArrowDown') { const child = node && index.nodes.get(index.children.get(node.key)?.[0] ?? ''); if (child) { event.preventDefault(); select(child.selection); } }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && node?.parent) {
      const siblings = index.children.get(node.parent) ?? [], current = siblings.indexOf(node.key), next = siblings[(current + (event.key === 'ArrowLeft' ? -1 : 1) + siblings.length) % siblings.length], sibling = next && index.nodes.get(next);
      if (sibling) { event.preventDefault(); select(sibling.selection); }
    }
  }
});
window.addEventListener('hashchange', () => { const wanted = selectionHash(); if (!wanted || validSelection(wanted)) select(wanted); });
$('swarm-stage').addEventListener('swarm-renderer-lost', () => { mode = '2d'; createRenderer(); $('swarm-status').textContent += ' · WebGL unavailable; 2D map active'; });
const expiryTimer = setInterval(() => {
  // Reclassify evidence in linear time; no force-layout/rebuild on every frame.
  let changed = false;
  for (const source of index.sources.values()) {
    if (source.status === 'observed' && sourceStatus(source) === 'stale') { source.status = 'stale'; changed = true; }
    const activity = activities(source, Date.now(), swarm.sample);
    for (const cell of source.snapshot?.snapshot.cells ?? []) { const node = index.nodes.get(nodeKey(source, 'cell', cell.id)); if (node && node.activity !== (activity.get(cell.id) ?? 'idle')) { node.activity = activity.get(cell.id) ?? 'idle'; changed = true; } }
  }
  if (changed) redraw();
}, 2000);

if (embedded) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(channel) || window.parent === window) $('swarm-status').textContent = 'Invalid viewer host channel';
  else {
    window.addEventListener('message', event => {
      if (event.source !== window.parent || event.origin !== location.origin || event.data?.protocol !== 'brain-swarm/1' || event.data.channel !== channel) return;
      if (event.data.type === 'ping') { window.parent.postMessage({ protocol: 'brain-swarm/1', type: 'ready', channel }, location.origin); return; }
      if (event.data.type !== 'observe' || !Number.isSafeInteger(event.data.sequence) || event.data.sequence <= frameSequence) return;
      try { observe(event.data.model); frameSequence = event.data.sequence; }
      catch { $('swarm-status').textContent = 'Host observation rejected · existing facts retained'; }
    });
    window.parent.postMessage({ protocol: 'brain-swarm/1', type: 'ready', channel }, location.origin);
  }
} else if (preview) {
  const count = Number(query.get('cells') ?? 54);
  observe(swarmPreview(Number.isSafeInteger(count) && count >= 3 && count <= 10000 ? count : 54));
} else {
  // Same-origin registered bridge only; never accept a remote destination/token.
  const sourcePath = query.get('source') ?? '/api/factory/swarm';
  let stopped = false, timer: ReturnType<typeof setTimeout>, controller: AbortController | null = null;
  const path = new URL(sourcePath, location.origin);
  if (!sourcePath.startsWith('/') || sourcePath.startsWith('//') || path.origin !== location.origin || path.search || path.hash) $('swarm-status').textContent = 'A same-origin read bridge is required';
  else {
    const poll = async () => {
      if (document.hidden) { timer = setTimeout(() => void poll(), 5000); return; }
      controller = new AbortController(); const deadline = setTimeout(() => controller?.abort(), 12000);
      try {
        const response = await fetch(path.pathname, { cache: 'no-store', signal: controller.signal, credentials: 'same-origin' });
        if ([401, 403, 404].includes(response.status)) { observe(empty()); throw new Error('Observation access unavailable'); }
        if (!response.ok) throw new Error('Swarm bridge unavailable');
        const body = await response.text(); if (body.length > 32 * 1024 * 1024) throw new Error('Swarm observation exceeds its bound');
        if (!stopped) observe(JSON.parse(body));
      } catch {
        if (!stopped) { swarm.sources = swarm.sources.map(source => ({ ...source, status: source.snapshot ? 'stale' : 'unavailable' })); index = new SwarmIndex(swarm); redraw(); $('swarm-status').textContent = 'Observation unavailable · retained facts are stale'; }
      } finally { clearTimeout(deadline); if (!stopped) timer = setTimeout(() => void poll(), 5000); }
    };
    void poll();
  }
  window.addEventListener('pagehide', () => { stopped = true; controller?.abort(); clearTimeout(timer); });
}
window.addEventListener('pagehide', () => { clearInterval(expiryTimer); renderer.dispose(); });
