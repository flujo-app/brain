import './insights.css';
import { ObservationFloors, type Observatory, type ObservationSource, type Worker, type Conversation } from './insights-model';
import { activities, type Swarm, type Selection } from './model';
import { arcDial, budgetRule, flowDiagram, oMark, ribbon, sourceHue, type Segment } from './marks';

const el = <T extends keyof HTMLElementTagNameMap>(tag: T, text?: string, cls?: string): HTMLElementTagNameMap[T] => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const btn = (label: string, action: () => void) => { const b = el('button', label); b.type = 'button'; b.onclick = action; return b; };
const time = (v: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(v));
const atTime = (v: string) => new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(v));
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const key = (s: ObservationSource, w: Worker, c: Conversation) => JSON.stringify([s.sourceId, s.factoryId, w.id, c.id]);
const empty = (): Observatory => ({ schemaVersion: 1, scope: 'factory-observatory', commands: false, observedAt: new Date().toISOString(), sources: [] });
/** Short, factual badge. The long wording lives in its tooltip and in the
 * section's Evidence drawer, never in the reading flow. */
const chip = (text: string, tone?: string, title?: string) => { const s = el('span', text, tone ? `chip chip-${tone}` : 'chip'); if (title) s.title = title; return s; };
const drawer = (summary: string, lines: string[]) => { const d = el('details', undefined, 'evidence-drawer'); d.append(el('summary', summary)); for (const line of lines) d.append(el('p', line)); return d; };
const pad = (n: number) => String(n).padStart(2, '0');

/** Section order is the reading order: the deck is one long page, never tabs. */
const SECTIONS: Array<[string, string, string, string[]]> = [
  ['analytics', 'Ledger', 'Paid budget per registered authority.', ['Held, limit and metered figures come from the paid ledger at its own revision. A logical cell allocation is a separate measure.', 'Final paid billing is not established by this contract.']],
  ['history', 'Timeline', 'Controller events, provider receipts and transcript stamps.', ['Each lane keeps its own provenance and is not merged into a single source of truth.', 'Controller history starts when this view connects; snapshot state does not reconstruct earlier events.']],
  ['workers', 'Flow', 'Recorded flow structure and the reported execution position.', ['The marked node comes from the conversation. Every other node is flow definition: completion, idle state and worker health are not inferred.', 'Machine-to-worker and cell-to-worker relationships stay unbound unless they were recorded.']],
  ['conversations', 'Transcript', 'The recorded conversation, including tool calls.', ['Messages and tool arguments are displayed inside a bounded window; a shortened record is marked where it occurs.']],
  ['machines', 'Providers', 'Modal and Fly observations.', ['Provider observations are independent of cell lifecycle and task leases, and provider state does not establish worker health.', 'A reservation is spending evidence. It does not identify or prove a running machine.']],
];

export function mountInsights(onSelect: (selection: Selection | null) => void) {
  let swarm: Swarm, selection: Selection | null = null, detail = empty(), chosen: string | null = null, filter = '', signature = '', temporalSignature = '', transcriptSignature = '', sourceSignature = '', transcriptKey: string | null = null, clock = Date.now();
  const floors = new ObservationFloors();
  const root = el('section', undefined, 'observatory-insights'); root.id = 'observatory-insights'; root.setAttribute('aria-label', 'Observatory instruments');
  const head = el('header', undefined, 'deck-head');
  const markSlot = el('div', undefined, 'deck-mark');
  const ident = el('div', undefined, 'deck-ident');
  const scopeTitle = el('h1', 'All registered sources');
  const freshness = el('p', 'Waiting for observations', 'insight-freshness'); freshness.setAttribute('role', 'status');
  ident.append(el('p', 'OBSERVATORY INSTRUMENTS', 'insight-kicker'), scopeTitle, freshness);
  const sourcePicker = el('select'); sourcePicker.setAttribute('aria-label', 'Observation source');
  sourcePicker.onchange = () => onSelect(sourcePicker.value ? { sourceId: sourcePicker.value, kind: 'source', id: sourcePicker.value } : null);
  const scope = el('label', undefined, 'deck-scope'); scope.append(el('span', 'SCOPE'), sourcePicker);
  const vitals = el('div', undefined, 'deck-vitals');
  head.append(markSlot, ident, scope, vitals);
  const body = el('div', undefined, 'deck-body');
  const spine = el('nav', undefined, 'deck-spine'); spine.setAttribute('aria-label', 'Observation views');
  const spineList = el('ol'); spine.append(spineList);
  const column = el('div', undefined, 'deck-sections');
  const panels = new Map<string, HTMLElement>(), links = new Map<string, HTMLAnchorElement>();
  for (const [index, [id, label, note, evidence]] of SECTIONS.entries()) {
    const link = el('a', undefined, 'spine-link'); link.href = `#insights-${id}`;
    // The URL fragment belongs to the authority selection, not section navigation.
    link.onclick = event => { event.preventDefault(); document.getElementById(`insights-${id}`)!.scrollIntoView({ block: 'start' }); };
    link.append(el('i', pad(index + 1)), el('span', label));
    const item = el('li'); item.append(link); spineList.append(item); links.set(id, link);
    const section = el('section', undefined, `insight-section insight-${id}`); section.id = `insights-${id}`;
    const header = el('header', undefined, 'section-head');
    const line = el('div', undefined, 'section-line');
    line.append(el('span', pad(index + 1), 'section-numeral'), el('h2', label), el('p', note, 'insight-subtitle'));
    header.append(line, drawer('Evidence', evidence));
    const content = el('div', undefined, 'insight-content'); panels.set(id, content);
    section.append(header, content); column.append(section);
  }
  body.append(spine, column); root.append(head, body);
  document.querySelector('#swarm-app > footer')!.before(root);
  const shortcut = btn('Instruments', () => root.scrollIntoView({ block: 'start' })); shortcut.id = 'swarm-instruments';
  document.getElementById('swarm-find')!.after(shortcut);
  if (typeof IntersectionObserver === 'function') {
    const watcher = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const link = links.get(entry.target.id.replace('insights-', ''));
        if (link && entry.isIntersecting) { for (const other of links.values()) other.removeAttribute('aria-current'); link.setAttribute('aria-current', 'true'); }
      }
    }, { rootMargin: '-15% 0px -70% 0px' });
    for (const id of links.keys()) watcher.observe(document.getElementById(`insights-${id}`)!);
  }
  const search = el('input'); search.type = 'search'; search.placeholder = 'Find a conversation'; search.setAttribute('aria-label', 'Find a conversation'); search.oninput = () => { filter = search.value; paintConversations(); };
  const conversationContent = panels.get('conversations')!, conversationBody = el('div', undefined, 'conversation-layout'); conversationContent.append(search, conversationBody);
  function scoped() { return detail.sources.filter(s => !selection || s.sourceId === selection.sourceId); }
  function allConversations() { return scoped().flatMap(s => s.workers.flatMap(w => w.conversations.map(c => ({ s, w, c, key: key(s, w, c) })))); }
  function currentConversation() { const list = allConversations(); return list.find(c => c.key === chosen) ?? list[0]; }
  function scopeLabel(s: ObservationSource) { return swarm.sources.find(a => a.id === s.sourceId)?.label ?? s.sourceId; }
  function recent(observedAt: string) { const age = clock - Date.parse(observedAt); return swarm.sample || (age >= 0 && age <= 15000); }
  function sources() { return swarm.sources.filter(s => !selection || s.id === selection.sourceId); }
  function timeSignature() {
    return JSON.stringify([
      sources().map(s => [s.status === 'observed' && !!s.snapshot && recent(s.snapshot.observedAt), [...activities(s, clock, swarm.sample).values()].filter(a => a === 'recent').length]),
      scoped().map(s => [s.workers.map(w => recent(w.observedAt)), s.machines.map(m => recent(m.observedAt))]),
    ]);
  }
  /** One reading: label, figure, and the shortest honest qualifier. */
  function card(label: string, value: string, note: string, extra = '') { const c = el('article', undefined, `metric-card${extra ? ` ${extra}` : ''}`); c.append(el('p', label, 'insight-kicker'), el('strong', value), el('small', note)); return c; }
  function paintAnalytics() {
    const content = panels.get('analytics')!; content.replaceChildren();
    const observed = sources(), details = scoped();
    const tasks = observed.flatMap(s => s.snapshot?.snapshot.tasks ?? []), effects = observed.flatMap(s => s.snapshot?.snapshot.effects ?? []);
    const activity = observed.flatMap(s => [...activities(s, clock, swarm.sample).values()]);
    const leased = activity.filter(a => a === 'recent').length;
    const conversations = allConversations(), knownTokens = conversations.filter(v => v.c.tokens !== null);
    const stale = observed.filter(s => s.status !== 'observed' || !s.snapshot || !recent(s.snapshot.observedAt)).length;
    const grid = el('div', undefined, 'metrics-grid');
    const leadCard = card('Recent leased cells', String(leased), `of ${activity.length} recorded cells · records, not host health`, 'metric-lead');
    const dial = el('div', undefined, 'vital-dial'); dial.append(arcDial(leased, activity.length), leadCard.querySelector('strong')!);
    leadCard.insertBefore(dial, leadCard.querySelector('small'));
    grid.append(leadCard,
      card('Sources', String(observed.length), `${stale} stale or unavailable`),
      card('Tasks', String(tasks.length), `${tasks.filter(t => t.status === 'running').length} running · ${tasks.filter(t => t.status === 'delivered').length} delivered · ${tasks.filter(t => t.status === 'completed').length} completed`),
      card('Unknown effects', String(effects.filter(e => e.state === 'unknown').length), 'awaiting reconciliation'),
      card('Conversations', String(conversations.length), `${conversations.filter(v => v.c.status === 'running' && recent(v.w.observedAt)).length} reported running · ${details.reduce((n, s) => n + s.workers.length, 0)} workers`),
      card('Reported tokens', knownTokens.length ? knownTokens.reduce((n, v) => n + v.c.tokens!, 0).toLocaleString() : 'Unknown', `${knownTokens.length} reported totals · nested runs may overlap`));
    vitals.replaceChildren(grid);
    const ledger = el('div', undefined, 'budget-grid');
    for (const s of details) if (s.budget) {
      const b = s.budget, panel = el('article', undefined, 'budget-card');
      const heading = el('div', undefined, 'budget-heading');
      heading.append(el('h3', scopeLabel(s)), chip(`REV ${b.revision}`, 'quiet', 'Paid ledger revision'));
      if (b.incomplete) heading.append(chip('BILLING INCOMPLETE', 'warn', 'Some charges have not been reported yet.'));
      panel.append(heading, el('p', money(b.heldCents), 'budget-total'), budgetRule(b.heldCents, b.limitCents, b.meteredCents));
      const legend = el('dl', undefined, 'budget-legend');
      for (const [term, value] of [['held', money(b.heldCents)], ['limit', money(b.limitCents)], ['available', money(b.availableCents)], ['metered', b.meteredCents === null ? 'unknown' : money(b.meteredCents)]] as Array<[string, string]>) {
        const reading = el('div'); reading.append(el('dt', term), el('dd', value)); legend.append(reading);
      }
      panel.append(legend);
      if (b.heldCents > b.limitCents) panel.append(el('p', `${money(b.heldCents - b.limitCents)} over committed`, 'insight-warning'));
      ledger.append(panel);
    }
    if (!ledger.childElementCount) ledger.append(el('p', 'No paid budget observation.', 'insight-empty'));
    content.append(ledger);
  }
  const LANES = ['var(--signal)', '#9ed7a6', '#b6a6ea'], LANE_NAMES = ['controller', 'provider receipt', 'transcript'];
  function paintHistory() {
    const content = panels.get('history')!, rows: Array<{ at: string; lane: 0 | 1 | 2; label: string; source: string; subject: string }> = [];
    for (const s of sources()) for (const e of s.events) rows.push({ at: e.observedAt, lane: 0, label: e.type, source: `${s.label} · controller #${e.seq}`, subject: e.subject });
    for (const s of scoped()) for (const m of s.machines) for (const o of m.operations) rows.push({ at: o.observedAt, lane: 1, label: `${o.label} · ${o.state}`, source: `${scopeLabel(s)} · ${m.provider} receipt`, subject: m.runId ?? m.resourceId ?? '' });
    for (const { s, w, c } of allConversations()) for (const m of c.messages) if (m.at) rows.push({ at: m.at, lane: 2, label: `${m.role}${m.tools.length ? ` · ${m.tools.map(t => t.name).join(', ')}` : ''}`, source: `${scopeLabel(s)} · ${w.label}`, subject: m.content.slice(0, 180) || 'Tool call' });
    rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); content.replaceChildren();
    if (!rows.length) { content.append(el('p', 'No timestamped record observed.', 'insight-empty')); return; }
    const chart = el('div', undefined, 'ribbon');
    chart.append(ribbon(rows.map(r => ({ at: Date.parse(r.at), lane: r.lane })), LANES));
    const axis = el('div', undefined, 'ribbon-axis');
    axis.append(el('span', atTime(rows[rows.length - 1]!.at)), el('span', `${rows.length} records`), el('span', atTime(rows[0]!.at)));
    const legend = el('ul', undefined, 'ribbon-legend');
    for (const [index, name] of LANE_NAMES.entries()) { const item = el('li', undefined, `lane-${index}`); item.append(el('i'), el('span', `${name} · ${rows.filter(r => r.lane === index).length}`)); legend.append(item); }
    content.append(chart, axis, legend);
    const list = el('ol', undefined, 'insight-timeline');
    for (const row of rows.slice(0, 200)) {
      // Every record sits inside the observed window, so the clock carries the
      // reading and the full stamp stays available on the element itself.
      const item = el('li', undefined, `lane-${row.lane}`); const stamp = el('time', atTime(row.at)); stamp.dateTime = row.at; stamp.title = time(row.at);
      const text = el('div'); text.append(el('strong', row.label), el('small', row.source), el('p', row.subject));
      item.append(stamp, text); list.append(item);
    }
    if (rows.length > 200) content.append(el('p', `newest 200 of ${rows.length}`, 'insight-meta'));
    content.append(list);
  }
  function paintWorkers() {
    const content = panels.get('workers')!; content.replaceChildren(); const selected = currentConversation();
    for (const s of scoped()) for (const w of s.workers) {
      const c = selected?.w === w ? selected.c : w.conversations[0], f = w.flows.find(f => f.id === c?.flowId), section = el('article', undefined, 'worker-card');
      const fresh = w.availability === 'observed' && recent(w.observedAt);
      const heading = el('div', undefined, 'worker-heading');
      const title = el('div', undefined, 'worker-title');
      title.append(el('h3', w.label), el('p', scopeLabel(s), 'insight-meta'));
      const marks = el('div', undefined, 'worker-chips');
      marks.append(chip(w.availability === 'observed' && !recent(w.observedAt) ? 'stale observation' : w.availability, fresh ? 'live' : 'quiet', `Worker observation read ${time(w.observedAt)}`));
      marks.append(chip(w.cellId ? `cell ${w.cellId}` : 'no cell binding', 'quiet', 'Recorded FACTORY cell binding'));
      marks.append(chip(w.machineKey ? 'machine bound' : 'no machine binding', 'quiet', 'Recorded machine binding'));
      heading.append(title, marks); section.append(heading);
      if (!c) section.append(el('p', w.conversationStatus === 'not_configured' ? 'No conversation registered.' : 'Conversation access unavailable · transcript and position cleared.', 'insight-empty'));
      else {
        const current = el('div', undefined, 'worker-current');
        current.append(el('strong', c.title), chip(c.status, c.status === 'running' && fresh ? 'live' : 'quiet'), el('span', `${f?.name ?? c.flowId ?? 'flow unknown'}`, 'worker-flow-name'));
        section.append(current);
        if (!f) section.append(el('p', 'Flow structure unavailable · no topology inferred.', 'insight-empty'));
        else {
          const badge = c.currentNodeId ? c.status === 'running' && fresh ? 'REPORTED RUNNING HERE' : 'LAST RECORDED POSITION' : null;
          const graph = el('div', undefined, 'flow-nodes'); graph.setAttribute('role', 'img');
          graph.setAttribute('aria-label', `${f.name}: ${f.nodes.length} recorded nodes, ${f.edges.length} recorded edges${c.currentNodeId ? `, reported position ${c.currentNodeId}` : ''}. Nodes: ${f.nodes.map(n => `${n.label} (${n.type}, ${n.id})`).join('; ')}. Edges: ${f.edges.map(e => `${e.source} to ${e.target}`).join('; ')}`);
          graph.append(flowDiagram(f, c.currentNodeId, badge));
          const foot = el('p', undefined, 'flow-foot');
          foot.append(chip(badge ?? 'FLOW DEFINITION', badge === 'REPORTED RUNNING HERE' ? 'live' : 'quiet', 'Position is reported by the conversation, not measured from the worker.'),
            el('span', `${f.nodes.length} nodes · ${f.edges.length} edges · position ${c.currentNodeId ?? 'unknown'}`));
          section.append(graph, foot);
        }
      }
      content.append(section);
    }
    if (!content.childElementCount) content.append(el('p', 'No FLUJO worker registered with this view.', 'insight-empty'));
  }
  function paintConversations() {
    const selected = currentConversation(), stamp = JSON.stringify([allConversations().map(v => [v.key, v.c]), selected?.key, filter]);
    if (stamp === transcriptSignature) return; transcriptSignature = stamp;
    const previousTranscript = conversationBody.querySelector('.transcript'), oldScroll = previousTranscript?.scrollTop ?? 0, atEnd = !previousTranscript || previousTranscript.scrollHeight - previousTranscript.clientHeight - previousTranscript.scrollTop < 40;
    conversationBody.replaceChildren();
    const list = el('div', undefined, 'conversation-list');
    for (const v of allConversations().filter(v => `${v.c.title} ${v.c.id} ${v.w.label}`.toLowerCase().includes(filter.toLowerCase()))) {
      const b = btn(v.c.title, () => { clock = Date.now(); chosen = v.key; paintConversations(); paintWorkers(); });
      b.setAttribute('aria-pressed', String(v.key === selected?.key));
      b.append(el('small', `${v.c.status} · ${v.w.label}`)); list.append(b);
    }
    if (!list.childElementCount) list.append(el('p', filter ? 'No matching conversation.' : 'No accessible conversation observed.', 'insight-empty'));
    conversationBody.append(list);
    if (!selected) return;
    const { s, w, c } = selected, transcript = el('article', undefined, 'transcript'), h = el('header');
    const chips = el('div', undefined, 'transcript-chips');
    chips.append(chip(c.status, c.status === 'running' && recent(w.observedAt) ? 'live' : 'quiet'), chip(`${c.messages.length}/${c.totalMessages} messages`, 'quiet', 'Displayed messages of the recorded total'));
    if (c.truncated) chips.append(chip('bounded window', 'warn', 'Older messages are outside the display bound.'));
    if (c.tokens !== null) chips.append(chip(`${c.tokens.toLocaleString()} tokens`, 'quiet', 'Reported by the conversation'));
    if (c.estimatedCostUsd !== null) chips.append(chip(`$${c.estimatedCostUsd.toFixed(3)} est.`, 'quiet', 'Estimated model cost, not paid billing'));
    h.append(el('h3', c.title), el('p', `${scopeLabel(s)} · ${w.label} · updated ${time(c.updatedAt)}`, 'insight-meta'), chips, el('code', c.id), btn('Latest ↓', () => { transcript.scrollTop = transcript.scrollHeight; }));
    transcript.append(h);
    for (const m of c.messages) {
      const message = el('section', undefined, `transcript-message message-${m.role}`), label = el('header');
      label.append(el('strong', m.role), el('small', [m.at ? atTime(m.at) : 'time not recorded', m.nodeId ? `node ${m.nodeId}` : ''].filter(Boolean).join(' · ')));
      message.append(label);
      if (m.content) message.append(el('p', m.content, 'message-content'));
      if (m.truncated) message.append(el('p', 'shortened to the display bound', 'insight-warning'));
      for (const t of m.tools) { const tool = el('details', undefined, 'transcript-tool'); tool.open = true; tool.append(el('summary', `Tool · ${t.name}`), el('pre', t.arguments || 'Arguments not recorded')); message.append(tool); }
      transcript.append(message);
    }
    if (!c.messages.length) transcript.append(el('p', 'No displayable message recorded.', 'insight-empty'));
    conversationBody.append(transcript);
    transcript.scrollTop = selected.key !== transcriptKey || atEnd ? transcript.scrollHeight : oldScroll; transcriptKey = selected.key;
  }
  function paintMachines() {
    const content = panels.get('machines')!; content.replaceChildren(); const grid = el('div', undefined, 'provider-grid');
    for (const provider of ['modal', 'fly'] as const) {
      const column = el('section', undefined, `provider-column provider-${provider}`), machineRows = scoped().flatMap(s => s.machines.filter(m => m.provider === provider).map(m => ({ s, m })));
      const head = el('div', undefined, 'provider-head');
      head.append(el('h3', provider === 'modal' ? 'Modal' : 'Fly.io'), el('p', `${machineRows.length} ${provider === 'modal' ? 'apps / runs' : 'machines'}`, 'insight-meta'));
      column.append(head);
      for (const { s, m } of machineRows) {
        const live = m.freshness === 'provider_observed', fresh = live && recent(m.observedAt);
        const c = el('article', undefined, `machine-card${m.freshness === 'retained' ? ' is-retained' : ''}`);
        const top = el('div', undefined, 'machine-top');
        top.append(chip(live ? fresh ? 'PROVIDER OBSERVATION' : 'STALE PROVIDER OBSERVATION' : m.freshness === 'retained' ? 'HISTORICAL RECEIPTS' : 'UNAVAILABLE', fresh ? 'live' : m.freshness === 'retained' ? 'hist' : 'quiet',
          m.freshness === 'retained' ? `${m.provider === 'modal' ? 'Local journal read' : 'Retained receipt timestamp'} ${time(m.observedAt)}. Current container count and machine health are unknown.` : `Provider read ${time(m.observedAt)}. Provider state does not establish worker health.`), el('span', scopeLabel(s), 'machine-scope'));
        c.append(top, el('h4', m.label), el('p', m.state, 'machine-state'), el('code', m.resourceId ?? m.runId ?? ''));
        const facts = el('ul', undefined, 'machine-facts');
        for (const fact of [m.kind, m.region ?? 'region unknown', m.accountId ?? 'account not supplied', m.appId ? `app ${m.appId}` : '', m.runId ? `run ${m.runId}` : '', m.cellId ? `cell ${m.cellId}` : ''].filter(Boolean)) facts.append(el('li', fact));
        c.append(facts, el('small', `${m.freshness === 'retained' ? m.provider === 'modal' ? 'journal read' : 'retained receipt' : 'provider read'} ${time(m.observedAt)}`));
        if (m.operations.length) {
          const receipts = el('details', undefined, 'machine-receipts'); receipts.open = true; receipts.append(el('summary', `${m.operations.length} recorded operations`));
          for (const o of m.operations) { const row = el('p', undefined, o.state === 'unknown' ? 'insight-warning' : 'insight-meta'); row.append(el('span', o.label), el('b', o.state)); receipts.append(row); }
          c.append(receipts);
        }
        if (m.evidenceDigest) { const evidence = el('details', undefined, 'machine-receipts'); evidence.open = true; evidence.append(el('summary', 'Evidence digest'), el('code', m.evidenceDigest)); c.append(evidence); }
        column.append(c);
      }
      for (const s of scoped()) {
        const reservations = s.budget?.reservations.filter(r => r.provider === provider) ?? [];
        if (reservations.length) {
          const holds = el('article', undefined, 'reservation-card'); holds.append(el('h4', `${scopeLabel(s)} · reservations`));
          for (const r of reservations) { const row = el('p', undefined, 'insight-meta'); row.append(el('span', r.id), el('b', `${money(r.heldCents)} · ${r.state}`)); holds.append(row); }
          holds.append(el('small', 'spending evidence · not proof of a running machine')); column.append(holds);
        }
        const observed = provider === 'modal' ? s.modalStatus : s.flyStatus;
        if (observed !== 'observed') column.append(el('p', `${scopeLabel(s)} · ${observed === 'not_configured' ? 'no machine observer configured' : 'machine observations unavailable'}`, 'insight-empty'));
      }
      if (!machineRows.length) column.append(el('p', 'Machine identity and current state unknown until an owned provider observation is connected.', 'insight-empty'));
      grid.append(column);
    }
    content.append(grid);
  }
  /** The O is the registry: one arc per registered authority, in the same
   * deterministic hue the field uses. The mouth core is filled only when a
   * running lease was counted in the current scope. */
  function paintMark() {
    const segments: Segment[] = swarm.sources.map(s => ({ color: sourceHue(s.id), broken: s.status !== 'observed' }));
    const leased = sources().some(s => [...activities(s, clock, swarm.sample).values()].some(a => a === 'recent'));
    const mark = oMark(segments, leased, 56);
    mark.setAttribute('role', 'img');
    mark.removeAttribute('aria-hidden');
    mark.setAttribute('aria-label', `${swarm.sources.length} registered authorities · ${leased ? 'recent leased-cell evidence in scope' : 'no recent leased-cell evidence in scope'}; running leases require recent heartbeat/source evidence, with uncertain and retained records excluded`);
    markSlot.replaceChildren(mark);
  }
  function paint() { paintMark(); paintAnalytics(); paintHistory(); paintWorkers(); paintConversations(); paintMachines(); }
  function temporal() { paintMark(); paintAnalytics(); paintWorkers(); paintMachines(); }
  return {
    observe(value: unknown, next: Swarm) {
      swarm = next;
      try { detail = floors.accept(value === undefined ? empty() : value, next.sources); }
      catch { detail = empty(); freshness.textContent = 'Detail observation rejected · private detail cleared'; }
    },
    render(next: Swarm, nextSelection: Selection | null) {
      swarm = next; selection = nextSelection; clock = Date.now();
      const sourceStamp = JSON.stringify(next.sources.map(s => [s.id, s.factoryId, s.label]));
      if (sourceStamp !== sourceSignature) {
        sourceSignature = sourceStamp; sourcePicker.replaceChildren();
        const all = el('option', 'All registered sources'); all.value = ''; sourcePicker.append(all);
        for (const s of next.sources) { const o = el('option', s.label); o.value = s.id; sourcePicker.append(o); }
      }
      sourcePicker.value = selection?.sourceId ?? '';
      detail.sources = detail.sources.filter(s => next.sources.some(a => a.id === s.sourceId && a.factoryId === s.factoryId));
      const selected = currentConversation(); if (chosen && !allConversations().some(v => v.key === chosen)) chosen = selected?.key ?? null;
      const scopeName = selection ? swarm.sources.find(s => s.id === selection!.sourceId)?.label ?? 'source' : 'All registered sources';
      scopeTitle.textContent = scopeName;
      root.style.setProperty('--accent', selection ? sourceHue(selection.sourceId) : '#7fd1de');
      freshness.textContent = `${swarm.sample ? 'Sample data · design preview' : 'Live read-only · 5s'} · ${scoped().length ? `detail read ${atTime(detail.observedAt)}` : 'worker detail unavailable'}`;
      const stamp = JSON.stringify([swarm, detail, selection]), signatureTime = timeSignature();
      if (stamp !== signature) { signature = stamp; temporalSignature = signatureTime; paint(); }
      else if (signatureTime !== temporalSignature) { temporalSignature = signatureTime; temporal(); }
    },
    tick() {
      if (!swarm || !signature) return;
      clock = Date.now(); const signatureTime = timeSignature();
      if (signatureTime !== temporalSignature) { temporalSignature = signatureTime; temporal(); }
    },
  };
}
