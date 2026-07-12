/**
 * Pre-rendered canvas sprites for the 2D renderer. Radial gradients are drawn
 * once into small offscreen canvases and then blitted with drawImage — the
 * same luminous look as the WebGL glow textures, at a fraction of the cost
 * (no shadowBlur in the hot path).
 */

const glowCache = new Map<string, HTMLCanvasElement>();
const nebulaCache = new Map<string, HTMLCanvasElement>();

function make(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Mix a hex colour toward white by `t` (0..1). */
export function toward(hex: string, target: string, t: number): string {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(target.slice(1), 16);
  const ch = (sh: number) => {
    const x = (a >> sh) & 255;
    const y = (b >> sh) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/**
 * Star sprite: tight bright core with a long soft coloured falloff. Mirrors
 * the 3D glowTexture stops so both renderers read the same.
 */
export function glowSprite(hex: string): HTMLCanvasElement {
  let c = glowCache.get(hex);
  if (c) return c;
  const size = 64;
  let ctx: CanvasRenderingContext2D;
  [c, ctx] = make(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.16, rgba(hex, 0.85));
  g.addColorStop(0.42, rgba(hex, 0.24));
  g.addColorStop(0.75, rgba(hex, 0.05));
  g.addColorStop(1, rgba(hex, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowCache.set(hex, c);
  return c;
}

/** Very soft wide falloff for galaxy nebula clouds, tinted per group. */
export function nebulaSprite(hex: string): HTMLCanvasElement {
  let c = nebulaCache.get(hex);
  if (c) return c;
  const size = 256;
  let ctx: CanvasRenderingContext2D;
  [c, ctx] = make(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, rgba(hex, 0.5));
  g.addColorStop(0.35, rgba(hex, 0.22));
  g.addColorStop(0.7, rgba(hex, 0.07));
  g.addColorStop(1, rgba(hex, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  nebulaCache.set(hex, c);
  return c;
}

/** Deterministic pseudo-random in [0, 1) from an integer seed. */
function hash(i: number): number {
  return (((i * 2654435761) >>> 0) % 100000) / 100000;
}

/**
 * A screen-sized background starfield, rendered once per resize into an
 * offscreen canvas and blitted (wrap-tiled for a slight parallax drift).
 */
export function buildStarfield(w: number, h: number, dpr: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const count = Math.round((w * h) / 3400);
  const TINTS = ['#dbe4ff', '#dbe4ff', '#dbe4ff', '#aecbff', '#ffd9c2', '#c9b8ff'];
  for (let i = 0; i < count; i++) {
    const x = hash(i * 3 + 1) * w;
    const y = hash(i * 3 + 2) * h;
    const r = 0.3 + hash(i * 3 + 3) * 1.0;
    const a = 0.12 + hash(i * 7 + 5) * 0.55;
    ctx.globalAlpha = a;
    ctx.fillStyle = TINTS[i % TINTS.length];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // A handful of brighter stars with a soft halo.
  ctx.globalAlpha = 1;
  const bright = glowSprite('#dbe4ff');
  for (let i = 0; i < count / 22; i++) {
    const x = hash(i * 11 + 401) * w;
    const y = hash(i * 11 + 402) * h;
    const s = 3.5 + hash(i * 11 + 403) * 5;
    ctx.globalAlpha = 0.18 + hash(i * 11 + 404) * 0.3;
    ctx.drawImage(bright, x - s / 2, y - s / 2, s, s);
  }
  return c;
}
