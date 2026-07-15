import { Vector3, type Camera } from 'three';
import type { FlowGraph } from './flowGraph';
import { NODE_R } from './flowGraph';
import type { Neuron } from '../types';
import { NODE_TYPE_COLORS, nodeTypeLabel } from '../theme';

interface Label {
  el: HTMLDivElement;
  pos: Vector3;
  /** Hide the label once the camera is further than this (0 = never hide). */
  maxDist: number;
  /** Anchor above (default) or below the projected point. */
  anchor: 'above' | 'below';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A layer of HTML labels projected to screen space each frame. */
export class LabelLayer {
  protected container: HTMLDivElement;
  protected labels: Label[] = [];
  private v = new Vector3();
  private hiddenAll = false;

  constructor(private avoidOverlap = false) {
    this.container = document.createElement('div');
    this.container.className = 'label-layer';
    document.body.appendChild(this.container);
  }

  /** Fade the whole layer out (e.g. while a behaviour is focused). */
  setHidden(hidden: boolean): void {
    if (hidden === this.hiddenAll) return;
    this.hiddenAll = hidden;
    this.container.style.opacity = hidden ? '0' : '1';
    this.container.style.visibility = hidden ? 'hidden' : 'visible';
  }

  protected add(pos: Vector3, className: string, html: string, maxDist = 0, anchor: 'above' | 'below' = 'above'): HTMLDivElement {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = html;
    this.container.appendChild(el);
    this.labels.push({ el, pos, maxDist, anchor });
    return el;
  }

  update(camera: Camera, w: number, h: number): void {
    if (this.hiddenAll) return;
    const camPos = (camera as unknown as { position: Vector3 }).position;
    // Greedy screen-space collision: earlier labels win, colliders hide.
    const placed: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const l of this.labels) {
      if (l.maxDist > 0 && camPos.distanceTo(l.pos) > l.maxDist) {
        l.el.style.opacity = '0';
        continue;
      }
      this.v.copy(l.pos).project(camera);
      if (this.v.z > 1) {
        l.el.style.opacity = '0';
        continue;
      }
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * h;
      if (this.avoidOverlap) {
        const lw = l.el.offsetWidth || 90;
        const lh = l.el.offsetHeight || 20;
        const top = l.anchor === 'below' ? y : y - lh;
        const rect = { x1: x - lw / 2 - 3, y1: top - 3, x2: x + lw / 2 + 3, y2: top + lh + 3 };
        if (placed.some((r) => rect.x1 < r.x2 && rect.x2 > r.x1 && rect.y1 < r.y2 && rect.y2 > r.y1)) {
          l.el.style.opacity = '0';
          l.el.style.pointerEvents = 'none';
          continue;
        }
        placed.push(rect);
        l.el.style.pointerEvents = '';
      }
      const anchorY = l.anchor === 'below' ? '0%' : '-100%';
      l.el.style.transform = `translate(-50%, ${anchorY}) translate(${x}px, ${y}px)`;
      l.el.style.opacity = String(Math.max(0.25, 1 - this.v.z * 0.8));
    }
  }

  dispose(): void {
    this.container.remove();
    this.labels = [];
  }
}

/**
 * Name tags under each node of the focused behaviour's graph. Labels are
 * clickable and select the node, so small nodes stay easy to hit.
 */
export class FlowNodeLabels extends LabelLayer {
  constructor(
    neuron: Neuron,
    flowGraph: FlowGraph,
    onSelect: (nodeId: string) => void,
    msgCounts?: Map<string, number>,
  ) {
    super(true);
    flowGraph.group.updateMatrixWorld(true);
    for (const node of neuron.inner.nodes) {
      const local = flowGraph.localPos.get(node.id);
      if (!local) continue;
      const pos = flowGraph.group.localToWorld(local.clone().add(new Vector3(0, -NODE_R * 1.45, 0)));
      const color = '#' + NODE_TYPE_COLORS[node.type].toString(16).padStart(6, '0');
      const count = msgCounts?.get(node.id) ?? 0;
      const el = this.add(
        pos,
        'flow-label',
        `<span class="t" style="color:${color}">${nodeTypeLabel(node.type)}</span><span class="l">${escapeHtml(node.label)}</span>` +
          (count ? `<span class="mc">💬 ${count}</span>` : ''),
        0,
        'below',
      );
      el.style.setProperty('--c', color);
      el.addEventListener('click', () => onSelect(node.id));
    }
  }
}
