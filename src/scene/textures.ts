import { CanvasTexture, Texture } from 'three';

let glowCache: Texture | null = null;
let nebulaCache: Texture | null = null;

function radial(size: number, stops: Array<[number, number]>): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, alpha] of stops) g.addColorStop(at, `rgba(255,255,255,${alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(c);
}

/** Soft radial glow used for neuron halos and travelling signal pulses. */
export function glowTexture(): Texture {
  // Tight bright core with a long soft falloff — reads as a star, not bokeh.
  return (glowCache ??= radial(128, [
    [0, 1],
    [0.16, 0.75],
    [0.42, 0.22],
    [0.75, 0.05],
    [1, 0],
  ]));
}

/** Very soft wide falloff for galaxy nebula clouds. */
export function nebulaTexture(): Texture {
  return (nebulaCache ??= radial(256, [
    [0, 0.5],
    [0.35, 0.22],
    [0.7, 0.07],
    [1, 0],
  ]));
}
