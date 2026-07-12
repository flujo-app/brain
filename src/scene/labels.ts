import { Vector3, type Camera } from 'three';
import type { Grouping } from '../grouping';
import type { SectionedLayout } from '../layout/sectionedLayout';
import type { Neuron, ServerStatus } from '../types';
import { NODE_TYPE_COLORS } from '../theme';

interface Label {
  el: HTMLDivElement;
  pos: Vector3;
  /** Hide the label once the camera is further than this (0 = never hide). */
  maxDist: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A layer of HTML labels projected to screen space each frame. */
export class LabelLayer {
  protected container: HTMLDivElement;
  protected labels: Label[] = [];
  private v = new Vector3();

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'label-layer';
    document.body.appendChild(this.container);
  }

  protected add(pos: Vector3, className: string, html: string, maxDist = 0): HTMLDivElement {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = html;
    this.container.appendChild(el);
    this.labels.push({ el, pos, maxDist });
    return el;
  }

  update(camera: Camera, w: number, h: number): void {
    const camPos = (camera as unknown as { position: Vector3 }).position;
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
      l.el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
      l.el.style.opacity = String(Math.max(0.25, 1 - this.v.z * 0.8));
    }
  }

  dispose(): void {
    this.container.remove();
    this.labels = [];
  }
}

/** Floating labels naming each galaxy section. */
export class SectionLabels extends LabelLayer {
  constructor(grouping: Grouping, layout: SectionedLayout) {
    super();
    for (const g of grouping.groups) {
      const pos = layout.centers.get(g.id)!.clone();
      pos.y += (layout.radii.get(g.id) ?? 4) + 3;
      const el = this.add(
        pos,
        'section-label',
        `<span class="name">${escapeHtml(g.label)}</span><span class="n">${g.neuronIds.length} flows</span>`,
      );
      el.style.setProperty('--c', '#' + g.color.getHexString());
    }
  }
}

const STATUS_DOT: Record<ServerStatus, string> = {
  connected: '#35e0d0',
  disconnected: '#ff5c8a',
  disabled: '#556080',
  unknown: '#9aa6c8',
};

/** Labels for a focused neuron's internal nodes (the zoomed-in flow view). */
export class InnerNodeLabels extends LabelLayer {
  constructor(neuron: Neuron, world: Map<string, Vector3>, servers: Record<string, ServerStatus>) {
    super();
    for (const node of neuron.inner.nodes) {
      const pos = world.get(node.id);
      if (!pos) continue;
      const color = '#' + NODE_TYPE_COLORS[node.type].toString(16).padStart(6, '0');
      let status = '';
      if (node.type === 'mcp' && node.server) {
        const s = servers[node.server] ?? 'unknown';
        status = `<i class="st" style="background:${STATUS_DOT[s]}" title="${s}"></i>`;
      }
      const el = this.add(
        pos,
        'inner-label',
        `<span class="t" style="color:${color}">${node.type}</span>${status}<span class="l">${escapeHtml(node.label)}</span>`,
      );
      el.style.setProperty('--c', color);
    }
  }
}
