import {
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  RingGeometry,
  Shape,
  ShapeGeometry,
  Vector3,
} from 'three';
import type { Neuron, ServerStatus } from '../types';
import { NODE_TYPE_COLORS } from '../theme';

export const NODE_R = 1.15;

/** Shape per node type: circle=process, hexagon=ability, diamond=behaviour, square=finish. */
const SEGMENTS: Record<string, number> = { process: 40, mcp: 6, subflow: 4, finish: 4, start: 40 };
const ROTATION: Record<string, number> = { process: 0, mcp: Math.PI / 6, subflow: 0, finish: Math.PI / 4, start: 0 };

const FILL = 0x0e1327;
const EDGE = 0x8b96bd;
const STATUS_COLORS: Record<ServerStatus, number> = {
  connected: 0x35e0d0,
  disconnected: 0xff5c8a,
  disabled: 0x556080,
  unknown: 0x9aa6c8,
};

interface NodeVisual {
  holder: Group;
  ring: MeshBasicMaterial;
  base: Color;
}

/**
 * The focused behaviour rendered as its actual graph: solid discs at the
 * flow editor's own layout, wired with arrowed edges. No glow, no scatter —
 * built for reading and clicking.
 */
export class FlowGraph {
  readonly group = new Group();
  /** Local-space node positions (z=0 plane), for labels. */
  readonly localPos = new Map<string, Vector3>();
  /** Half-extents of the laid-out graph, for camera framing. */
  readonly halfWidth: number;
  readonly halfHeight: number;

  private visuals = new Map<string, NodeVisual>();
  private pickMeshes: Mesh[] = [];
  private hoverId: string | null = null;
  private selectedId: string | null = null;
  private activeId: string | null = null;

  constructor(neuron: Neuron, servers: Record<string, ServerStatus>) {
    const nodes = neuron.inner.nodes;

    // Scale the normalized layout so no two nodes crowd each other.
    let minDist = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        minDist = Math.min(minDist, Math.hypot(dx, dy));
      }
    }
    const base = 7 + Math.sqrt(nodes.length) * 3;
    const scale = Math.min(60, Math.max(base, isFinite(minDist) && minDist > 0 ? (NODE_R * 3.4) / minDist : base));

    let hw = NODE_R * 2;
    let hh = NODE_R * 2;
    for (const node of nodes) {
      const p = new Vector3(node.x * scale, node.y * scale, 0);
      this.localPos.set(node.id, p);
      hw = Math.max(hw, Math.abs(p.x) + NODE_R * 3);
      hh = Math.max(hh, Math.abs(p.y) + NODE_R * 3);

      const color = new Color(NODE_TYPE_COLORS[node.type]);
      const holder = new Group();
      holder.position.copy(p);

      const seg = SEGMENTS[node.type] ?? 40;
      const rot = ROTATION[node.type] ?? 0;

      const fill = new Mesh(
        new CircleGeometry(NODE_R, seg),
        new MeshBasicMaterial({ color: FILL, side: DoubleSide }),
      );
      fill.rotation.z = rot;
      fill.userData.nodeId = node.id;
      this.pickMeshes.push(fill);

      const ringMat = new MeshBasicMaterial({ color: color.clone(), side: DoubleSide });
      const ring = new Mesh(new RingGeometry(NODE_R * 0.82, NODE_R, seg), ringMat);
      ring.rotation.z = rot;
      ring.position.z = 0.02;

      // Center dot: ability nodes show live status, others echo their type.
      const dotColor =
        node.type === 'mcp' && node.server
          ? new Color(STATUS_COLORS[servers[node.server] ?? 'unknown'])
          : color.clone().multiplyScalar(0.85);
      const dot = new Mesh(new CircleGeometry(NODE_R * 0.28, 24), new MeshBasicMaterial({ color: dotColor, side: DoubleSide }));
      dot.position.z = 0.02;

      holder.add(fill, ring, dot);
      this.group.add(holder);
      this.visuals.set(node.id, { holder, ring: ringMat, base: color });
    }

    this.halfWidth = hw;
    this.halfHeight = hh;
    this.buildEdges(neuron);
  }

  private buildEdges(neuron: Neuron): void {
    const verts: number[] = [];
    const arrowGeo = triangleGeometry();
    const arrowMat = new MeshBasicMaterial({ color: EDGE, side: DoubleSide, transparent: true, opacity: 0.95 });

    for (const e of neuron.inner.edges) {
      const a = this.localPos.get(e.source);
      const b = this.localPos.get(e.target);
      if (!a || !b) continue;
      const dir = b.clone().sub(a);
      const len = dir.length();
      if (len < NODE_R * 2) continue;
      dir.normalize();

      const from = a.clone().addScaledVector(dir, NODE_R * 1.25);
      const tip = b.clone().addScaledVector(dir, -NODE_R * 1.25);
      const lineEnd = tip.clone().addScaledVector(dir, -0.9);
      verts.push(from.x, from.y, 0, lineEnd.x, lineEnd.y, 0);

      const arrow = new Mesh(arrowGeo, arrowMat);
      arrow.position.set(tip.x, tip.y, 0.01);
      arrow.rotation.z = Math.atan2(dir.y, dir.x);
      this.group.add(arrow);
    }

    if (!verts.length) return;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(verts, 3));
    const lines = new LineSegments(geo, new LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.85 }));
    this.group.add(lines);
  }

  /** Node id under the pointer, or null. */
  pick(raycaster: Raycaster): string | null {
    const hits = raycaster.intersectObjects(this.pickMeshes, false);
    return hits.length ? (hits[0].object.userData.nodeId as string) : null;
  }

  setHover(id: string | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.refresh();
  }

  setSelected(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.refresh();
  }

  /** Highlight the node the flow engine is currently executing. */
  setActive(id: string | null): void {
    if (id === this.activeId) return;
    this.activeId = id;
    this.refresh();
  }

  private refresh(): void {
    for (const [id, v] of this.visuals) {
      const selected = id === this.selectedId;
      const hovered = id === this.hoverId;
      const active = id === this.activeId;
      v.holder.scale.setScalar(selected ? 1.22 : active ? 1.18 : hovered ? 1.12 : 1);
      v.ring.color.copy(v.base);
      if (selected) v.ring.color.lerp(new Color(0xffffff), 0.55);
      else if (active) v.ring.color.lerp(new Color(0xffffff), 0.45);
      else if (hovered) v.ring.color.lerp(new Color(0xffffff), 0.3);
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as { geometry?: { dispose?: () => void }; material?: { dispose?: () => void } };
      m.geometry?.dispose?.();
      m.material?.dispose?.();
    });
    this.group.removeFromParent();
  }
}

function triangleGeometry(): ShapeGeometry {
  const s = new Shape();
  s.moveTo(0, 0);
  s.lineTo(-1.1, 0.5);
  s.lineTo(-1.1, -0.5);
  s.closePath();
  return new ShapeGeometry(s);
}
