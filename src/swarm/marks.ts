/** Local presentation helpers for the Observatory.
 *
 * Every mark here is drawn from data that was already observed and parsed:
 * nothing invents a measurement, and nothing animates on its own. The one
 * recurring form is the O — a ring that opens into a mouth. The Observatory
 * only ever speaks about records, so the mouth is the brand. */

const NS = 'http://www.w3.org/2000/svg';

export const svgNode = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
};
const frame = (viewBox: string, className: string): SVGSVGElement =>
  svgNode('svg', { viewBox, class: className, focusable: 'false', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' });
const polar = (cx: number, cy: number, r: number, turn: number) =>
  [cx + r * Math.cos(turn * Math.PI * 2 - Math.PI / 2), cy + r * Math.sin(turn * Math.PI * 2 - Math.PI / 2)] as const;
const arcPath = (cx: number, cy: number, r: number, from: number, to: number): string => {
  const span = Math.max(0, Math.min(0.9999, to - from));
  const [x1, y1] = polar(cx, cy, r, from), [x2, y2] = polar(cx, cy, r, from + span);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${span > 0.5 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
};

export interface Segment { color: string; broken?: boolean }

/** The O: a registry ring that opens into a mouth.
 * Each ring segment is one registered authority in its deterministic hue; a
 * broken segment is a retained or unavailable record. The mouth core is filled
 * only when the caller counted at least one running lease — it is a count,
 * not a heartbeat, and it never animates by itself. */
export function oMark(segments: Segment[], speaking: boolean, size = 44): SVGSVGElement {
  const root = frame('0 0 64 64', 'o-mark');
  root.setAttribute('width', String(size));
  root.setAttribute('height', String(size));
  root.dataset.speaking = String(speaking);
  const count = Math.max(1, segments.length), gap = segments.length > 1 ? Math.min(0.02, 0.35 / count) : 0;
  for (let i = 0; i < count && segments.length; i++) {
    const seg = segments[i]!;
    const arc = svgNode('path', { d: arcPath(32, 32, 27, i / count + gap / 2, (i + 1) / count - gap / 2), stroke: seg.color, 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' });
    if (seg.broken) { arc.setAttribute('stroke-dasharray', '2.4 3.4'); arc.setAttribute('opacity', '.6'); }
    root.append(arc);
  }
  if (!segments.length) root.append(svgNode('circle', { cx: 32, cy: 32, r: 27, stroke: 'var(--rule-strong)', 'stroke-width': 1.5, fill: 'none', 'stroke-dasharray': '2 4' }));
  root.append(svgNode('circle', { class: 'o-bezel', cx: 32, cy: 32, r: 21.5, stroke: 'var(--rule)', 'stroke-width': 1, fill: 'none' }));
  // An open mouth, not an eye: a shallow upper lip over a deep lower one.
  root.append(svgNode('path', { class: 'o-lip o-lip-upper', d: 'M 18.5 31 Q 32 26.4 45.5 31', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' }));
  root.append(svgNode('path', { class: 'o-lip o-lip-lower', d: 'M 18.5 31 Q 32 44 45.5 31', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' }));
  const core = svgNode('path', { class: 'o-core', d: 'M 25.6 36.6 Q 32 42.4 38.4 36.6', fill: speaking ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round', opacity: speaking ? '.9' : '.34' });
  root.append(core);
  for (const [i, turn] of [-0.055, 0, 0.055].entries()) {
    const [x1, y1] = polar(32, 32, 31, 0.25 + turn), [x2, y2] = polar(32, 32, 31 + (i === 1 ? 4.5 : 3), 0.25 + turn);
    root.append(svgNode('line', { class: 'o-say', x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2), stroke: 'currentColor', 'stroke-width': 1, 'stroke-linecap': 'round', opacity: i === 1 ? '.5' : '.26' }));
  }
  return root;
}

/** One reading drawn as an arc: a part of a counted whole, never health. */
export function arcDial(value: number, total: number, tone = 'var(--accent)'): SVGSVGElement {
  const root = frame('0 0 120 120', 'dial-art');
  const share = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  root.append(svgNode('path', { d: arcPath(60, 60, 49, 0, 0.9999), fill: 'none', stroke: 'var(--rule-strong)', 'stroke-width': 5, opacity: '.3', 'stroke-linecap': 'round' }));
  for (let i = 0; i < 48; i++) {
    const [x1, y1] = polar(60, 60, 41, i / 48), [x2, y2] = polar(60, 60, i % 4 === 0 ? 35 : 38, i / 48);
    root.append(svgNode('line', { x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2), stroke: i / 48 < share ? tone : 'var(--rule-strong)', 'stroke-width': i % 4 === 0 ? 1 : 0.6, opacity: i / 48 < share ? '.8' : '.34' }));
  }
  if (share > 0) root.append(svgNode('path', { d: arcPath(60, 60, 49, 0, Math.max(share, 0.005)), fill: 'none', stroke: tone, 'stroke-width': 5, 'stroke-linecap': 'round' }));
  return root;
}

/** Observed record density across the window that was actually observed. */
export interface RibbonPoint { at: number; lane: 0 | 1 | 2 }
export function ribbon(points: RibbonPoint[], lanes: string[]): SVGSVGElement {
  const width = 960, height = 80, columns = 72;
  const root = frame(`0 0 ${width} ${height}`, 'ribbon-art');
  root.setAttribute('preserveAspectRatio', 'none');
  const times = points.map(point => point.at);
  const min = Math.min(...times), max = Math.max(...times), span = Math.max(1, max - min);
  const buckets = Array.from({ length: columns }, () => [0, 0, 0]);
  for (const point of points) buckets[Math.min(columns - 1, Math.max(0, Math.round(((point.at - min) / span) * (columns - 1))))]![point.lane]++;
  const peak = Math.max(1, ...buckets.map(bucket => bucket[0]! + bucket[1]! + bucket[2]!)), step = width / columns;
  for (let i = 0; i <= 8; i++) root.append(svgNode('line', { x1: ((width / 8) * i).toFixed(2), y1: 4, x2: ((width / 8) * i).toFixed(2), y2: height - 8, stroke: 'var(--rule)', 'stroke-width': 1, opacity: i % 8 === 0 ? '.9' : '.55' }));
  for (let i = 0; i < columns; i += 2) root.append(svgNode('line', { x1: (i * step + step / 2).toFixed(2), y1: height - 12, x2: (i * step + step / 2).toFixed(2), y2: height - 8, stroke: 'var(--rule)', 'stroke-width': 1, opacity: '.5' }));
  for (let i = 0; i < columns; i++) {
    let base = height - 9;
    for (let lane = 0; lane < 3; lane++) {
      const value = buckets[i]![lane]!;
      if (!value) continue;
      const bar = Math.max(3, (value / peak) * (height - 20));
      root.append(svgNode('rect', { x: (i * step + 1.2).toFixed(2), y: (base - bar).toFixed(2), width: Math.max(1.6, step - 2.4).toFixed(2), height: bar.toFixed(2), fill: lanes[lane]!, opacity: '.8' }));
      base -= bar + 1.5;
    }
  }
  root.append(svgNode('line', { x1: 0, y1: height - 8, x2: width, y2: height - 8, stroke: 'var(--rule-strong)', 'stroke-width': 1 }));
  return root;
}

/** The paid ledger drawn as one measured rule, not a progress bar. */
export function budgetRule(heldCents: number, limitCents: number, meteredCents: number | null): SVGSVGElement {
  const width = 600, height = 32, root = frame(`0 0 ${width} ${height}`, 'budget-art');
  root.setAttribute('preserveAspectRatio', 'none');
  const scale = Math.max(1, limitCents, heldCents), at = (cents: number) => Math.max(0, Math.min(width, (cents / scale) * width));
  root.append(svgNode('rect', { x: 0, y: 12, width, height: 10, fill: 'var(--plate-solid)', stroke: 'var(--rule)', 'stroke-width': 1 }));
  root.append(svgNode('rect', { x: 0, y: 12, width: at(Math.min(heldCents, limitCents)).toFixed(2), height: 10, fill: 'var(--accent)', opacity: '.8' }));
  if (heldCents > limitCents) root.append(svgNode('rect', { x: at(limitCents).toFixed(2), y: 12, width: Math.max(1, at(heldCents) - at(limitCents)).toFixed(2), height: 10, fill: 'var(--warn)', opacity: '.85' }));
  for (let i = 0; i <= 20; i++) root.append(svgNode('line', { x1: ((width / 20) * i).toFixed(2), y1: 5, x2: ((width / 20) * i).toFixed(2), y2: i % 5 === 0 ? 10 : 8.5, stroke: 'var(--rule-strong)', 'stroke-width': 1 }));
  root.append(svgNode('line', { x1: at(limitCents).toFixed(2), y1: 3, x2: at(limitCents).toFixed(2), y2: 29, stroke: 'var(--text)', 'stroke-width': 1, opacity: '.7' }));
  if (meteredCents !== null) root.append(svgNode('line', { x1: at(meteredCents).toFixed(2), y1: 11, x2: at(meteredCents).toFixed(2), y2: 27, stroke: 'var(--signal)', 'stroke-width': 1.5, 'stroke-dasharray': '2 3' }));
  return root;
}

/** Recorded flow structure drawn as a real graph with its recorded edges.
 * Only the node the conversation reports is marked; the rest are definitions. */
export interface DiagramNode { id: string; label: string; type: string }
export interface DiagramFlow { nodes: DiagramNode[]; edges: Array<{ source: string; target: string }> }
export function flowDiagram(flow: DiagramFlow, currentId: string | null, currentBadge: string | null): SVGSVGElement {
  const W = 168, H = 56, GX = 58, GY = 22, PAD = 16, TOP = 26;
  const depth = new Map(flow.nodes.map(node => [node.id, 0]));
  for (let pass = 0; pass < Math.min(flow.nodes.length, 48); pass++) {
    let changed = false;
    for (const edge of flow.edges) {
      const next = (depth.get(edge.source) ?? 0) + 1;
      if (depth.has(edge.target) && next > depth.get(edge.target)! && next < flow.nodes.length) { depth.set(edge.target, next); changed = true; }
    }
    if (!changed) break;
  }
  const columns = new Map<number, DiagramNode[]>();
  for (const node of flow.nodes) { const at = depth.get(node.id) ?? 0; columns.set(at, [...(columns.get(at) ?? []), node]); }
  // Cycles and disconnected components can leave gaps in the bounded ranks.
  const ranks = [...columns.keys()].sort((a, b) => a - b);
  const rows = Math.max(1, ...[...columns.values()].map(column => column.length));
  const place = new Map<string, { x: number; y: number }>();
  for (const [column, rank] of ranks.entries()) for (const [row, node] of columns.get(rank)!.entries()) {
    const nodes = columns.get(rank)!;
    place.set(node.id, { x: PAD + column * (W + GX), y: TOP + row * (H + GY) + ((rows - nodes.length) * (H + GY)) / 2 });
  }
  const width = PAD * 2 + Math.max(0, columns.size - 1) * (W + GX) + W, height = TOP + rows * (H + GY) + PAD;
  const root = frame(`0 0 ${width} ${height}`, 'flow-art');
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  const id = `flow-arrow-${Math.random().toString(36).slice(2, 9)}`;
  const marker = svgNode('marker', { id, viewBox: '0 0 8 8', refX: 7.5, refY: 4, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' });
  marker.append(svgNode('path', { d: 'M 0.5 1 L 7.5 4 L 0.5 7 z', fill: 'var(--rule-strong)' }));
  const defs = svgNode('defs'); defs.append(marker); root.append(defs);
  for (const edge of flow.edges) {
    const a = place.get(edge.source), b = place.get(edge.target);
    if (!a || !b) continue;
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const d = x2 >= x1
      ? `M ${x1} ${y1} C ${x1 + GX * 0.62} ${y1}, ${x2 - GX * 0.62} ${y2}, ${x2} ${y2}`
      : `M ${a.x + W / 2} ${a.y + H} C ${a.x + W / 2} ${a.y + H + 30}, ${b.x + W / 2} ${b.y + H + 30}, ${b.x + W / 2} ${b.y + H}`;
    root.append(svgNode('path', { class: 'flow-art-edge', d, fill: 'none', stroke: 'var(--rule-strong)', 'stroke-width': 1, 'marker-end': `url(#${id})`, opacity: '.85' }));
  }
  for (const node of flow.nodes) {
    const at = place.get(node.id)!, current = node.id === currentId;
    const group = svgNode('g', { class: `flow-art-node${current ? ' is-current' : ''}`, transform: `translate(${at.x} ${at.y})` });
    const title = svgNode('title'); title.textContent = `${node.label} · ${node.type} · ${node.id}${current && currentBadge ? ` · ${currentBadge}` : ''}`; group.append(title);
    group.append(svgNode('rect', { x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 3, fill: current ? 'var(--plate-lit)' : 'var(--plate-solid)', stroke: current ? 'var(--accent)' : 'var(--rule)', 'stroke-width': 1 }));
    group.append(svgNode('rect', { x: 0.5, y: 0.5, width: 2, height: H - 1, fill: current ? 'var(--accent)' : 'var(--rule-strong)' }));
    const label = svgNode('text', { x: 15, y: 25, class: 'flow-art-label' });
    label.textContent = node.label.length > 21 ? `${node.label.slice(0, 20)}…` : node.label;
    const type = svgNode('text', { x: 15, y: 41, class: 'flow-art-type' });
    type.textContent = node.type.toUpperCase();
    group.append(label, type);
    if (current && currentBadge) {
      const badge = svgNode('text', { x: 1, y: -10, class: 'flow-art-badge' });
      badge.textContent = currentBadge;
      group.append(badge);
    }
    root.append(group);
  }
  return root;
}

/** The deterministic authority palette, mirrored verbatim from renderer.ts so
 * the field, the atlas rail and the instrument deck cannot disagree about a
 * source's hue. test/swarm.test.mjs asserts the two readers stay identical. */
const hues = ['#7fd1de', '#9bb8e8', '#c2a7e8', '#e8a7b8', '#e8c98a', '#8fd9b6'];
export const sourceHue = (id: string): string => hues[[...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0) % hues.length]!;
