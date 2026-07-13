import type { Neuron, ServerStatus } from '../types';
import { NODE_TYPE_COLORS, nodeTypeLabel } from '../theme';
import { toward } from './sprites';

export const NODE_R = 1.15;

/** Shape per node type: circle=process, hexagon=ability, diamond=behaviour, square=finish. */
const SIDES: Record<string, number> = { process: 0, start: 0, mcp: 6, subflow: 4, finish: 4 };
const ROTATION: Record<string, number> = { process: 0, start: 0, mcp: Math.PI / 6, subflow: 0, finish: Math.PI / 4 };

const FILL = '#0e1327';
const EDGE = '#8b96bd';
const STATUS_COLORS: Record<ServerStatus, string> = {
  connected: '#35e0d0',
  disconnected: '#ff5c8a',
  disabled: '#556080',
  unknown: '#9aa6c8',
};

function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

interface GNode {
  id: string;
  type: string;
  label: string;
  x: number; // world coords (y down)
  y: number;
  color: string;
  dotColor: string;
}

interface GEdge {
  fx: number; fy: number; // line start
  tx: number; ty: number; // arrow tip
  angle: number;
}

interface Rect { x1: number; y1: number; x2: number; y2: number }

/**
 * The focused behaviour rendered as its actual graph on the canvas: solid
 * discs at the flow editor's own layout, wired with arrowed edges, name pills
 * underneath. Built for reading and clicking, drawn in world space.
 */
export class FlowGraph2D {
  readonly nodes: GNode[] = [];
  readonly halfWidth: number;
  readonly halfHeight: number;

  private edges: GEdge[] = [];
  private labelRects = new Map<string, Rect>(); // screen space, rebuilt per draw
  private hoverId: string | null = null;
  private selectedId: string | null = null;
  private activeId: string | null = null;
  /** nodeId -> message count from the chat dock's conversation (💬 badges). */
  private badges = new Map<string, number>();

  constructor(neuron: Neuron, servers: Record<string, ServerStatus>, cx: number, cy: number) {
    const inner = neuron.inner.nodes;

    // Scale the normalized layout so no two nodes crowd each other
    // (same maths as the WebGL FlowGraph, so both views frame alike).
    let minDist = Infinity;
    for (let i = 0; i < inner.length; i++) {
      for (let j = i + 1; j < inner.length; j++) {
        minDist = Math.min(minDist, Math.hypot(inner[i].x - inner[j].x, inner[i].y - inner[j].y));
      }
    }
    const base = 7 + Math.sqrt(inner.length) * 3;
    const scale = Math.min(60, Math.max(base, isFinite(minDist) && minDist > 0 ? (NODE_R * 3.4) / minDist : base));

    let hw = NODE_R * 2;
    let hh = NODE_R * 2;
    const byId = new Map<string, GNode>();
    for (const node of inner) {
      // Layout y is up (three-style); canvas world y grows down.
      const x = cx + node.x * scale;
      const y = cy - node.y * scale;
      hw = Math.max(hw, Math.abs(x - cx) + NODE_R * 3);
      hh = Math.max(hh, Math.abs(y - cy) + NODE_R * 3);
      const color = hex(NODE_TYPE_COLORS[node.type]);
      const dotColor =
        node.type === 'mcp' && node.server
          ? STATUS_COLORS[servers[node.server] ?? 'unknown']
          : toward(color, '#000000', 0.15);
      const g: GNode = { id: node.id, type: node.type, label: node.label, x, y, color, dotColor };
      this.nodes.push(g);
      byId.set(node.id, g);
    }
    this.halfWidth = hw;
    this.halfHeight = hh;

    for (const e of neuron.inner.edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < NODE_R * 2) continue;
      const ux = dx / len;
      const uy = dy / len;
      this.edges.push({
        fx: a.x + ux * NODE_R * 1.25,
        fy: a.y + uy * NODE_R * 1.25,
        tx: b.x - ux * NODE_R * 1.25,
        ty: b.y - uy * NODE_R * 1.25,
        angle: Math.atan2(uy, ux),
      });
    }
  }

  setHover(id: string | null): boolean {
    if (id === this.hoverId) return false;
    this.hoverId = id;
    return true;
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
  }

  /** Highlight the node the flow engine is currently executing. */
  setActive(id: string | null): boolean {
    if (id === this.activeId) return false;
    this.activeId = id;
    return true;
  }

  /** Per-node message counts (the chat conversation overlaid on the graph). */
  setBadges(counts: Map<string, number>): void {
    this.badges = counts;
  }

  /** Node id at screen point (disc or its name pill), or null. */
  pick(sx: number, sy: number, w2s: (x: number, y: number) => [number, number], s: number): string | null {
    const rPick = Math.max(NODE_R * 1.3 * s, 10);
    for (const n of this.nodes) {
      const [nx, ny] = w2s(n.x, n.y);
      if (Math.hypot(sx - nx, sy - ny) <= rPick) return n.id;
      const r = this.labelRects.get(n.id);
      if (r && sx >= r.x1 && sx <= r.x2 && sy >= r.y1 && sy <= r.y2) return n.id;
    }
    return null;
  }

  private polygonPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, sides: number, rot: number): void {
    ctx.beginPath();
    if (sides === 0) {
      ctx.arc(x, y, r, 0, Math.PI * 2);
      return;
    }
    for (let k = 0; k <= sides; k++) {
      const a = rot + (k / sides) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /** Draw the whole graph in screen space via the given world->screen mapping. */
  draw(ctx: CanvasRenderingContext2D, w2s: (x: number, y: number) => [number, number], s: number, alpha: number): void {
    if (alpha <= 0.01) return;
    ctx.globalCompositeOperation = 'source-over';
    this.labelRects.clear();

    // Edges + arrowheads.
    ctx.globalAlpha = alpha * 0.85;
    ctx.strokeStyle = EDGE;
    ctx.fillStyle = EDGE;
    ctx.lineWidth = Math.max(1, 0.1 * s);
    const ah = 1.05 * s; // arrow length in px
    ctx.beginPath();
    for (const e of this.edges) {
      const [fx, fy] = w2s(e.fx, e.fy);
      const [tx, ty] = w2s(e.tx, e.ty);
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx - Math.cos(e.angle) * ah * 0.8, ty - Math.sin(e.angle) * ah * 0.8);
    }
    ctx.stroke();
    for (const e of this.edges) {
      const [tx, ty] = w2s(e.tx, e.ty);
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(e.angle);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-ah, ah * 0.45);
      ctx.lineTo(-ah, -ah * 0.45);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Nodes: dark disc, coloured ring, centre dot.
    for (const n of this.nodes) {
      const selected = n.id === this.selectedId;
      const hovered = n.id === this.hoverId;
      const active = n.id === this.activeId;
      const k = selected ? 1.22 : active ? 1.18 : hovered ? 1.12 : 1;
      const r = NODE_R * k * s;
      const [x, y] = w2s(n.x, n.y);
      const sides = SIDES[n.type] ?? 0;
      const rot = ROTATION[n.type] ?? 0;

      let ring = n.color;
      if (selected) ring = toward(n.color, '#ffffff', 0.55);
      else if (active) ring = toward(n.color, '#ffffff', 0.45);
      else if (hovered) ring = toward(n.color, '#ffffff', 0.3);

      ctx.globalAlpha = alpha;
      this.polygonPath(ctx, x, y, r, sides, rot);
      ctx.fillStyle = FILL;
      ctx.fill();
      this.polygonPath(ctx, x, y, r * 0.91, sides, rot);
      ctx.strokeStyle = ring;
      ctx.lineWidth = Math.max(1.2, r * 0.18);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, r * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = n.dotColor;
      ctx.fill();
    }

    // Name pills under each node (clickable — rects recorded for pick()).
    for (const n of this.nodes) {
      const [x, y] = w2s(n.x, n.y);
      const top = y + NODE_R * 1.45 * s;
      const type = nodeTypeLabel(n.type as never).toUpperCase();
      ctx.font = '700 9px Inter, "Segoe UI", system-ui, sans-serif';
      const tw = ctx.measureText(type).width;
      ctx.font = '400 11.5px Inter, "Segoe UI", system-ui, sans-serif';
      const lw = ctx.measureText(n.label).width;
      const padX = 9;
      const gap = 6;
      const w = padX * 2 + tw + gap + lw;
      const h = 20;
      const x1 = x - w / 2;

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.roundRect(x1, top, w, h, 8);
      ctx.fillStyle = 'rgba(10,14,28,0.82)';
      ctx.fill();
      ctx.strokeStyle = n.id === this.hoverId ? n.color : 'rgba(140,160,220,0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = '700 9px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = n.color;
      ctx.fillText(type, x1 + padX, top + h / 2 + 0.5);
      ctx.font = '400 11.5px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#dbe4ff';
      ctx.fillText(n.label, x1 + padX + tw + gap, top + h / 2 + 0.5);

      this.labelRects.set(n.id, { x1, y1: top, x2: x1 + w, y2: top + h });
    }

    // 💬 badges: how much of the chat conversation happened at each node.
    for (const n of this.nodes) {
      const count = this.badges.get(n.id);
      if (!count) continue;
      const [x, y] = w2s(n.x, n.y);
      const label = `💬 ${count}`;
      ctx.font = '600 10px Inter, "Segoe UI", system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      const bw = tw + 12;
      const bh = 16;
      const bx = x + NODE_R * 0.8 * s;
      const by = y - NODE_R * 1.3 * s - bh;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 8);
      ctx.fillStyle = 'rgba(10,14,28,0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(245,158,11,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#dbe4ff';
      ctx.fillText(label, bx + 6, by + bh / 2 + 0.5);
    }
    ctx.globalAlpha = 1;
  }
}
