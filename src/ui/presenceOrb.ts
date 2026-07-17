/**
 * The brain-stem's face: a small living neural network on a canvas, the dock's
 * presence. Seeded by the stem id so it's unique per brain, it breathes softly
 * when idle, brightens when the chat is active, and fires a cascade on every
 * heartbeat and every reply — so the dock literally pulses with the brain's
 * life. Pure Canvas 2D, additive glow, no dependencies (adapted from the
 * lobby orb in "brain online").
 */

const TAU = Math.PI * 2;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type PresenceState = 'idle' | 'active' | 'thinking' | 'paused';

interface PNode {
  tx: number;
  ty: number;
  r: number;
  hue: number;
  seed: number;
  act: number;
}
interface PEdge {
  a: number;
  b: number;
  mx: number;
  my: number;
}
interface PPulse {
  e: number;
  t: number;
  dir: 1 | -1;
}

/** Immersive hue triad from "brain online": cyan / violet / heartbeat-pink. */
const HUES = [190, 262, 338, 210, 285];

export class PresenceOrb {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private disposed = false;
  private last = 0;
  private time: number;
  private state: PresenceState = 'idle';

  private nodes: PNode[] = [];
  private edges: PEdge[] = [];
  private pulses: PPulse[] = [];
  private lastCascade = 0;
  private baseHue: number;

  private w = 0;
  private h = 0;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement, seedStr = 'brain-stem') {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
    const rnd = mulberry32(hashStr(seedStr) || 7);
    this.time = rnd() * 100; // start mid-life
    this.baseHue = HUES[Math.floor(rnd() * HUES.length)]!;
    this.build(rnd);
    this.resize();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  setState(s: PresenceState): void {
    this.state = s;
  }

  /** Fire a cascade through the network — a heartbeat, or a fresh thought. */
  pulse(): void {
    const s = Math.floor(Math.random() * this.nodes.length);
    this.nodes[s]!.act = 1;
    for (let ei = 0; ei < this.edges.length; ei++) {
      const e = this.edges[ei]!;
      if (e.a === s || e.b === s) this.pulses.push({ e: ei, t: e.a === s ? 0 : 1, dir: e.a === s ? 1 : -1 });
    }
    this.lastCascade = this.time;
  }

  /** Re-seed the network when the stem changes (a different mind). */
  reseed(seedStr: string): void {
    const rnd = mulberry32(hashStr(seedStr) || 7);
    this.baseHue = HUES[Math.floor(rnd() * HUES.length)]!;
    this.nodes = [];
    this.edges = [];
    this.pulses = [];
    this.build(rnd);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
  }

  private build(rnd: () => number): void {
    const N = 12 + Math.floor(rnd() * 4);
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const r = 0.12 + 0.36 * Math.sqrt((i + 0.6) / N);
      const a = i * GOLDEN + rnd() * 0.3;
      this.nodes.push({
        tx: Math.cos(a) * r,
        ty: Math.sin(a) * r * 0.85,
        r: 1.5 + rnd() * 1.7,
        hue: this.baseHue + (rnd() - 0.5) * 60,
        seed: rnd() * TAU,
        act: 0,
      });
    }
    for (let i = 1; i < N; i++) {
      const links = 1 + (rnd() < 0.35 ? 1 : 0);
      const dists = this.nodes
        .slice(0, i)
        .map((n, j) => ({ j, d: (n.tx - this.nodes[i]!.tx) ** 2 + (n.ty - this.nodes[i]!.ty) ** 2 }))
        .sort((p, q) => p.d - q.d);
      for (let k = 0; k < links && k < dists.length; k++) {
        const j = dists[k]!.j;
        const a = this.nodes[i]!;
        const b = this.nodes[j]!;
        const bend = (rnd() - 0.5) * 0.4;
        this.edges.push({
          a: i,
          b: j,
          mx: (a.tx + b.tx) / 2 - (b.ty - a.ty) * bend,
          my: (a.ty + b.ty) / 2 + (b.tx - a.tx) * bend,
        });
      }
    }
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = this.canvas.clientWidth || 72;
    this.h = this.canvas.clientHeight || 72;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  private frame(now: number): void {
    if (this.disposed) return;
    const dt = Math.min(0.05, this.last ? (now - this.last) / 1000 : 0.016);
    this.last = now;
    this.time += dt;

    const paused = this.state === 'paused';
    const lively = this.state === 'active' || this.state === 'thinking';

    for (const n of this.nodes) n.act *= Math.exp(-dt * 2.4);

    // Ambient cascades keep the network murmuring; thinking fires faster.
    const interval = this.state === 'thinking' ? 1.0 : lively ? 2.6 : paused ? 9 : 4.5;
    if (!paused && this.time - this.lastCascade > interval) this.pulse();

    const next: PPulse[] = [];
    for (const p of this.pulses) {
      p.t += p.dir * dt * 1.4;
      if (p.t > 0 && p.t < 1) {
        next.push(p);
        continue;
      }
      const e = this.edges[p.e]!;
      const arrived = p.dir > 0 ? e.b : e.a;
      this.nodes[arrived]!.act = 1;
      if (next.length < 26 && Math.random() < 0.55) {
        for (let ei = 0; ei < this.edges.length; ei++) {
          if (ei === p.e) continue;
          const e2 = this.edges[ei]!;
          if ((e2.a === arrived || e2.b === arrived) && Math.random() < 0.5) {
            next.push({ e: ei, t: e2.a === arrived ? 0 : 1, dir: e2.a === arrived ? 1 : -1 });
          }
        }
      }
    }
    this.pulses = next;

    this.render();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private render(): void {
    const ctx = this.ctx;
    const { w, h } = this;
    if (this.canvas.clientWidth && Math.abs(this.canvas.clientWidth - w) > 2) this.resize();

    const paused = this.state === 'paused';
    const lively = this.state === 'active' || this.state === 'thinking';
    const breath = lively ? 1 : 0.5 + 0.18 * Math.sin(this.time * 0.9);
    const vivid = clamp(paused ? 0.35 : breath, 0, 1.15);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    const S = Math.min(w, h);
    const cx = w / 2;
    const cy = h / 2;

    // aura
    const aura = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.62);
    aura.addColorStop(0, `hsla(${this.baseHue}, 80%, 62%, ${0.12 * vivid})`);
    aura.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, w, h);

    const px = (n: PNode) => {
      const wob = 1 + 0.03 * Math.sin(this.time * 0.8 + n.seed);
      return { x: cx + n.tx * S * wob, y: cy + n.ty * S * wob };
    };

    for (const e of this.edges) {
      const a = this.nodes[e.a]!;
      const b = this.nodes[e.b]!;
      const pa = px(a);
      const pb = px(b);
      const act = Math.max(a.act, b.act);
      ctx.strokeStyle = `hsla(${a.hue}, 80%, ${60 + act * 22}%, ${(0.14 + 0.5 * act) * vivid})`;
      ctx.lineWidth = 0.8 + act * 1.2;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.quadraticCurveTo(cx + e.mx * S, cy + e.my * S, pb.x, pb.y);
      ctx.stroke();
    }

    for (const p of this.pulses) {
      const e = this.edges[p.e]!;
      const pa = px(this.nodes[e.a]!);
      const pb = px(this.nodes[e.b]!);
      const t = p.t;
      const it = 1 - t;
      const x = it * it * pa.x + 2 * it * t * (cx + e.mx * S) + t * t * pb.x;
      const y = it * it * pa.y + 2 * it * t * (cy + e.my * S) + t * t * pb.y;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 4);
      g.addColorStop(0, `hsla(${this.baseHue}, 95%, 82%, ${0.85 * vivid})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, TAU);
      ctx.fill();
    }

    for (const n of this.nodes) {
      const p = px(n);
      const r = n.r * (1 + n.act * 0.8);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
      g.addColorStop(0, `hsla(${n.hue}, 90%, ${70 + n.act * 20}%, ${(0.8 + n.act * 0.2) * vivid})`);
      g.addColorStop(0.4, `hsla(${n.hue}, 90%, 58%, ${0.24 * vivid})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 3, 0, TAU);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
  }
}
