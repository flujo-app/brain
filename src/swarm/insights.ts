import './insights.css';
import { ObservationFloors, type Observatory, type ObservationSource, type Worker, type Conversation } from './insights-model';
import { activities, type Swarm, type Selection } from './model';

const el = <T extends keyof HTMLElementTagNameMap>(tag: T, text?: string, cls?: string): HTMLElementTagNameMap[T] => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const btn = (label: string, action: () => void) => { const b = el('button', label); b.type = 'button'; b.onclick = action; return b; };
const time = (v: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(v));
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const key = (s: ObservationSource, w: Worker, c: Conversation) => JSON.stringify([s.sourceId, s.factoryId, w.id, c.id]);
const empty = (): Observatory => ({ schemaVersion: 1, scope: 'factory-observatory', commands: false, observedAt: new Date().toISOString(), sources: [] });

export function mountInsights(onSelect: (selection: Selection | null) => void) {
  let swarm: Swarm, selection: Selection | null = null, detail = empty(), chosen: string | null = null, filter = '', signature = '', transcriptSignature = '', sourceSignature = '', transcriptKey: string | null = null;
  const floors = new ObservationFloors();
  const root = el('section', undefined, 'observatory-insights'); root.id = 'observatory-insights'; root.setAttribute('aria-label', 'Observatory analytics and worker detail');
  const header = el('header', undefined, 'insights-heading'), title = el('div'); title.append(el('p', 'OBSERVATORY / INSTRUMENTS', 'insight-kicker'), el('h1', 'The work, in focus.'));
  const freshness = el('p', 'Waiting for observations', 'insight-freshness'); freshness.setAttribute('role', 'status'); header.append(title, freshness);
  const nav = el('nav', undefined, 'insights-nav'); nav.setAttribute('aria-label', 'Observation views');
  for (const [id, label] of [['analytics', 'Analytics'], ['history', 'Timeline'], ['workers', 'Worker nodes'], ['conversations', 'Conversations'], ['machines', 'Modal + Fly']]) nav.append(btn(label, () => document.getElementById(`insights-${id}`)?.scrollIntoView({ behavior: 'auto', block: 'start' })));
  const sourcePicker = el('select'); sourcePicker.setAttribute('aria-label', 'Observation source'); sourcePicker.onchange = () => onSelect(sourcePicker.value ? { sourceId: sourcePicker.value, kind: 'source', id: sourcePicker.value } : null); nav.append(sourcePicker);
  const panels = new Map<string, HTMLElement>();
  for (const [id, label, note] of [
    ['analytics', 'Analytics', 'Observed work, usage and budget. Missing measurements remain unknown.'],
    ['history', 'Timeline', 'Controller events, provider receipts and transcript timestamps keep their own provenance.'],
    ['workers', 'Inside the worker', 'Flow structure and the conversation’s recorded execution position.'],
    ['conversations', 'Conversations & transcript', 'Read the actual conversation, including tool calls and results.'],
    ['machines', 'Machines & provider resources', 'Modal and Fly observations are independent of cell lifecycle and task leases.'],
  ]) { const section = el('section', undefined, `insight-section insight-${id}`); section.id = `insights-${id}`; section.append(el('h2', label), el('p', note, 'insight-subtitle')); const content = el('div', undefined, 'insight-content'); panels.set(id, content); section.append(content); root.append(section); }
  root.prepend(header, nav);
  document.querySelector('#swarm-app > footer')!.before(root);
  const shortcut = btn('Instruments ↓', () => root.scrollIntoView({ behavior: 'auto' })); document.getElementById('swarm-find')!.after(shortcut);
  const search = el('input'); search.type = 'search'; search.placeholder = 'Find a conversation'; search.setAttribute('aria-label', 'Find a conversation'); search.oninput = () => { filter = search.value; paintConversations(); };
  const conversationContent = panels.get('conversations')!, conversationBody = el('div', undefined, 'conversation-layout'); conversationContent.append(search, conversationBody);
  function scoped() { return detail.sources.filter(s => !selection || s.sourceId === selection.sourceId); }
  function allConversations() { return scoped().flatMap(s => s.workers.flatMap(w => w.conversations.map(c => ({ s, w, c, key: key(s, w, c) })))); }
  function currentConversation() { const list = allConversations(); return list.find(c => c.key === chosen) ?? list[0]; }
  function scopeLabel(s: ObservationSource) { return swarm.sources.find(a => a.id === s.sourceId)?.label ?? s.sourceId; }
  function recent(observedAt: string) { const age = Date.now() - Date.parse(observedAt); return swarm.sample || (age >= 0 && age <= 15000); }
  function card(label: string, value: string, note: string) { const c = el('article', undefined, 'metric-card'); c.append(el('p', label, 'insight-kicker'), el('strong', value), el('small', note)); return c; }
  function paintAnalytics() {
    const content = panels.get('analytics')!; content.replaceChildren();
    const sources = swarm.sources.filter(s => !selection || s.id === selection.sourceId), details = scoped();
    const tasks = sources.flatMap(s => s.snapshot?.snapshot.tasks ?? []), effects = sources.flatMap(s => s.snapshot?.snapshot.effects ?? []);
    const activity = sources.flatMap(s => [...activities(s, Date.now(), swarm.sample).values()]);
    const conversations = allConversations(), knownTokens = conversations.filter(v => v.c.tokens !== null);
    const metrics = el('div', undefined, 'metrics-grid');
    metrics.append(card('Sources', String(sources.length), `${sources.filter(s => s.status !== 'observed').length} stale or unavailable`),
      card('Recent leased cells', String(activity.filter(a => a === 'recent').length), `${activity.length} recorded cells · host health separate`),
      card('Tasks', String(tasks.length), `${tasks.filter(t => t.status === 'running').length} running · ${tasks.filter(t => ['delivered', 'completed'].includes(t.status)).length} delivered / operation completed`),
      card('Unknown effects', String(effects.filter(e => e.state === 'unknown').length), 'External outcomes require reconciliation'),
      card('Conversations', String(conversations.length), `${conversations.filter(v => v.c.status === 'running' && recent(v.w.observedAt)).length} recently reported running · ${details.reduce((n, s) => n + s.workers.length, 0)} registered workers`),
      card('Reported tokens', knownTokens.length ? knownTokens.reduce((n, v) => n + v.c.tokens!, 0).toLocaleString() : 'Unknown', `Sum of ${knownTokens.length} reported totals; nested runs may overlap`)); content.append(metrics);
    const budgets = el('div', undefined, 'budget-grid');
    for (const s of details) if (s.budget) {
      const b = s.budget, panel = el('article', undefined, 'budget-card'); panel.append(el('h3', `${scopeLabel(s)} · paid budget`));
      const meter = el('meter'); meter.min = 0; meter.max = Math.max(1, b.limitCents, b.heldCents); meter.value = b.heldCents; meter.setAttribute('aria-label', 'Committed paid budget');
      panel.append(el('p', `${money(b.heldCents)} held / ${money(b.limitCents)} limit`, 'budget-total'), meter, el('p', `${money(b.availableCents)} available · ${b.meteredCents === null ? 'final spend unknown' : `${money(b.meteredCents)} metered`}${b.incomplete ? ' · billing incomplete' : ''}`, 'insight-meta'));
      if (b.heldCents > b.limitCents) panel.append(el('p', `${money(b.heldCents - b.limitCents)} over committed`, 'insight-warning'));
      panel.append(el('small', `Paid ledger revision ${b.revision}. Logical cell allocation is a separate measure.`)); budgets.append(panel);
    }
    if (!budgets.childElementCount) budgets.append(el('p', 'Paid budget observations are unavailable.', 'insight-empty')); content.append(budgets);
  }
  function paintHistory() {
    const content = panels.get('history')!, rows: Array<{ at: string; label: string; source: string; subject: string }> = [];
    for (const s of swarm.sources.filter(s => !selection || s.id === selection.sourceId)) for (const e of s.events) rows.push({ at: e.observedAt, label: e.type, source: `${s.label} / controller #${e.seq}`, subject: e.subject });
    for (const s of scoped()) for (const m of s.machines) for (const o of m.operations) rows.push({ at: o.observedAt, label: `${o.label} · ${o.state}`, source: `${scopeLabel(s)} / ${m.provider} receipt`, subject: m.runId ?? m.resourceId ?? '' });
    for (const { s, w, c } of allConversations()) for (const m of c.messages) if (m.at) rows.push({ at: m.at, label: `${m.role}${m.tools.length ? ` · ${m.tools.map(t => t.name).join(', ')}` : ''}`, source: `${scopeLabel(s)} / ${w.label} / transcript`, subject: m.content.slice(0, 180) || 'Tool call' });
    rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); content.replaceChildren();
    if (!rows.length) { content.append(el('p', 'No timestamped history has been observed. Snapshot state does not reconstruct earlier events.', 'insight-empty')); return; }
    const list = el('ol', undefined, 'insight-timeline');
    for (const row of rows.slice(0, 200)) { const item = el('li'); const stamp = el('time', time(row.at)); stamp.dateTime = row.at; const text = el('div'); text.append(el('strong', row.label), el('small', row.source), el('p', row.subject)); item.append(stamp, text); list.append(item); }
    content.append(el('p', `${Math.min(rows.length, 200)} newest timestamped records${rows.length > 200 ? ` of ${rows.length}` : ''} · controller history starts when this view connects`, 'insight-meta'), list);
  }
  function paintWorkers() {
    const content = panels.get('workers')!; content.replaceChildren(); const selected = currentConversation();
    for (const s of scoped()) for (const w of s.workers) {
      const c = selected?.w === w ? selected.c : w.conversations[0], f = w.flows.find(f => f.id === c?.flowId), section = el('article', undefined, 'worker-card');
      const heading = el('div', undefined, 'worker-heading'); heading.append(el('h3', w.label), el('span', `${w.availability === 'observed' && !recent(w.observedAt) ? 'stale observation' : w.availability} · ${scopeLabel(s)}`, 'status-pill')); section.append(heading);
      section.append(el('p', `${w.cellId ? `Registered cell binding: ${w.cellId}` : 'Unbound to a FACTORY cell'} · ${w.machineKey ? 'registered machine binding' : 'machine binding unavailable'}`, 'insight-meta'));
      if (!c) section.append(el('p', w.conversationStatus === 'not_configured' ? 'No conversation IDs are registered for this worker.' : 'Conversation access unavailable. Transcript and execution position cleared.', 'insight-empty'));
      else {
        section.append(el('p', `${c.title} · ${c.status}`, 'worker-current'), el('p', `Flow: ${f?.name ?? c.flowId ?? 'unknown'} · recorded position: ${c.currentNodeId ?? 'unknown'}`, 'insight-meta'));
        if (!f) section.append(el('p', 'Flow structure unavailable. No node topology or execution history is inferred.', 'insight-empty'));
        else {
          const graph = el('div', undefined, 'flow-nodes'); graph.setAttribute('aria-label', `${f.name} execution nodes`);
          for (const n of f.nodes) { const at = c.currentNodeId === n.id, node = el('article', undefined, `flow-node${at ? ' node-current' : ''}`); const incoming = f.edges.filter(e => e.target === n.id).map(e => f.nodes.find(n => n.id === e.source)?.label ?? e.source);
            node.append(el('span', at ? c.status === 'running' && w.availability === 'observed' && recent(w.observedAt) ? 'REPORTED RUNNING HERE' : 'LAST RECORDED POSITION' : 'FLOW DEFINITION', 'insight-kicker'), el('strong', n.label), el('small', n.type), el('code', n.id));
            if (incoming.length) node.append(el('small', `← ${incoming.join(', ')}`)); graph.append(node);
          } section.append(graph, el('p', 'The current position comes from the conversation. Other nodes are definitions; completion and idle state are not inferred.', 'insight-meta'));
        }
      } content.append(section);
    }
    if (!content.childElementCount) content.append(el('p', 'No FLUJO workers are registered with this view. Machine-to-worker and cell-to-worker relationships remain unbound.', 'insight-empty'));
  }
  function paintConversations() {
    const selected = currentConversation(), stamp = JSON.stringify([allConversations().map(v => [v.key, v.c]), selected?.key, filter]);
    if (stamp === transcriptSignature) return; transcriptSignature = stamp;
    const previousTranscript = conversationBody.querySelector('.transcript'), oldScroll = previousTranscript?.scrollTop ?? 0, atEnd = !previousTranscript || previousTranscript.scrollHeight - previousTranscript.clientHeight - previousTranscript.scrollTop < 40;
    conversationBody.replaceChildren();
    const list = el('div', undefined, 'conversation-list');
    for (const v of allConversations().filter(v => `${v.c.title} ${v.c.id} ${v.w.label}`.toLowerCase().includes(filter.toLowerCase()))) {
      const b = btn(v.c.title, () => { chosen = v.key; paintConversations(); paintWorkers(); }); b.setAttribute('aria-pressed', String(v.key === selected?.key)); b.append(el('small', `${v.c.status} · ${v.w.label}`)); list.append(b);
    }
    if (!list.childElementCount) list.append(el('p', filter ? 'No matching conversations.' : 'No accessible conversations observed.', 'insight-empty'));
    conversationBody.append(list);
    if (!selected) return;
    const { s, w, c } = selected, transcript = el('article', undefined, 'transcript'); const h = el('header'); h.append(el('h3', c.title), el('p', `${scopeLabel(s)} / ${w.label} · ${c.status} · updated ${time(c.updatedAt)}`, 'insight-meta'), el('code', c.id), el('p', `${c.messages.length} displayed / ${c.totalMessages} recorded messages${c.truncated ? ' · bounded window' : ''}${c.tokens !== null ? ` · ${c.tokens.toLocaleString()} tokens` : ''}${c.estimatedCostUsd !== null ? ` · $${c.estimatedCostUsd.toFixed(3)} estimated model cost` : ''}`, 'insight-meta'), btn('Latest message ↓', () => { transcript.scrollTop = transcript.scrollHeight; })); transcript.append(h);
    for (const m of c.messages) { const message = el('section', undefined, `transcript-message message-${m.role}`); const label = el('header'); label.append(el('strong', m.role), el('small', [m.at ? time(m.at) : 'time not recorded', m.nodeId ? `node ${m.nodeId}` : ''].filter(Boolean).join(' · '))); message.append(label);
      if (m.content) message.append(el('p', m.content, 'message-content'));
      if (m.truncated) message.append(el('p', 'Long message or tool arguments shortened to the display bound.', 'insight-warning'));
      for (const t of m.tools) { const tool = el('details', undefined, 'transcript-tool'); tool.open = true; tool.append(el('summary', `Tool call · ${t.name}`), el('pre', t.arguments || 'Arguments not recorded')); message.append(tool); } transcript.append(message);
    }
    if (!c.messages.length) transcript.append(el('p', 'No displayable messages recorded.', 'insight-empty')); conversationBody.append(transcript); transcript.scrollTop = selected.key !== transcriptKey || atEnd ? transcript.scrollHeight : oldScroll; transcriptKey = selected.key;
  }
  function paintMachines() {
    const content = panels.get('machines')!; content.replaceChildren(); const grid = el('div', undefined, 'provider-grid');
    for (const provider of ['modal', 'fly'] as const) {
      const column = el('section', undefined, `provider-column provider-${provider}`), machineRows = scoped().flatMap(s => s.machines.filter(m => m.provider === provider).map(m => ({ s, m })));
      column.append(el('h3', provider === 'modal' ? 'Modal' : 'Fly.io'), el('p', `${machineRows.length} ${provider === 'modal' ? 'registered apps / runs' : 'machine observations'}`, 'insight-meta'));
      for (const { s, m } of machineRows) { const c = el('article', undefined, 'machine-card'); c.append(el('div', `${m.freshness === 'provider_observed' ? recent(m.observedAt) ? 'PROVIDER OBSERVATION' : 'STALE PROVIDER OBSERVATION' : m.freshness === 'retained' ? 'HISTORICAL RECEIPTS' : 'UNAVAILABLE'} · ${scopeLabel(s)}`, 'insight-kicker'), el('h4', m.label), el('p', m.state, 'machine-state'), el('code', m.resourceId ?? m.runId ?? ''), el('p', `${m.kind} · ${m.region ?? 'region unknown'} · ${m.accountId ?? 'account identity not supplied'}`, 'insight-meta'));
        if (m.appId) c.append(el('p', `App: ${m.appId}${m.runId ? ` · run ${m.runId}` : ''}${m.cellId ? ` · recorded cell ${m.cellId}` : ''}`, 'insight-meta'));
        c.append(el('small', `${m.freshness === 'retained' ? m.provider === 'modal' ? 'Local journal read' : 'Retained receipt timestamp' : 'Provider read'} ${time(m.observedAt)}${m.freshness === 'retained' ? '. Current container count and machine health are unknown.' : '. Provider state does not establish worker health.'}`));
        if (m.operations.length) { const receipts = el('details'); receipts.open = true; receipts.append(el('summary', `${m.operations.length} recorded operations`)); for (const o of m.operations) receipts.append(el('p', `${o.label} · ${o.state}`, o.state === 'unknown' ? 'insight-warning' : 'insight-meta')); c.append(receipts); } column.append(c);
        if (m.evidenceDigest) { const evidence = el('details'); evidence.open = true; evidence.append(el('summary', 'Evidence digest'), el('code', m.evidenceDigest)); c.append(evidence); }
      }
      for (const s of scoped()) {
        const reservations = s.budget?.reservations.filter(r => r.provider === provider) ?? [];
        if (reservations.length) { const holds = el('article', undefined, 'reservation-card'); holds.append(el('h4', `${scopeLabel(s)} · paid reservations`)); for (const r of reservations) holds.append(el('p', `${r.id} · ${r.state} · ${money(r.heldCents)} held`, 'insight-meta')); holds.append(el('small', 'A reservation is spending evidence. It does not identify or prove a running machine.')); column.append(holds); }
        const observed = provider === 'modal' ? s.modalStatus : s.flyStatus;
        if (observed !== 'observed') column.append(el('p', `${scopeLabel(s)} · ${observed === 'not_configured' ? 'no machine observer configured' : 'machine observations unavailable'}`, 'insight-empty'));
      }
      if (!machineRows.length) column.append(el('p', 'Machine identity and current state are unknown until an owned provider observation is connected.', 'insight-empty')); grid.append(column);
    } content.append(grid);
  }
  function paint() { paintAnalytics(); paintHistory(); paintWorkers(); paintConversations(); paintMachines(); }
  return {
    observe(value: unknown, next: Swarm) {
      swarm = next;
      try { detail = floors.accept(value === undefined ? empty() : value, next.sources); }
      catch { detail = empty(); freshness.textContent = 'Detail observation rejected · private detail cleared'; }
    },
    render(next: Swarm, nextSelection: Selection | null) {
      swarm = next; selection = nextSelection;
      const sourceStamp = JSON.stringify(next.sources.map(s => [s.id, s.factoryId, s.label]));
      if (sourceStamp !== sourceSignature) { sourceSignature = sourceStamp; sourcePicker.replaceChildren(); const all = el('option', 'All registered sources'); all.value = ''; sourcePicker.append(all); for (const s of next.sources) { const o = el('option', s.label); o.value = s.id; sourcePicker.append(o); } }
      sourcePicker.value = selection?.sourceId ?? '';
      detail.sources = detail.sources.filter(s => next.sources.some(a => a.id === s.sourceId && a.factoryId === s.factoryId));
      const selected = currentConversation(); if (chosen && !allConversations().some(v => v.key === chosen)) chosen = selected?.key ?? null;
      const sources = scoped(); freshness.textContent = `${swarm.sample ? 'Sample data / design preview' : 'Live read-only / 5-second refresh'} · ${selection ? swarm.sources.find(s => s.id === selection!.sourceId)?.label ?? 'source' : 'all registered sources'} · ${sources.length ? `detail read ${time(detail.observedAt)}` : 'worker detail unavailable'}`;
      const stamp = JSON.stringify([swarm, detail, selection]); if (stamp !== signature) { signature = stamp; paint(); }
    },
  };
}
