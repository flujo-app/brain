import { CanvasTexture, Texture } from 'three';

let glowCache: Texture | null = null;

/** Soft radial glow used for neuron halos and travelling signal pulses. */
export function glowTexture(): Texture {
  if (glowCache) return glowCache;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowCache = new CanvasTexture(c);
  return glowCache;
}
