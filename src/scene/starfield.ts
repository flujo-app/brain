import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Points,
  PointsMaterial,
} from 'three';
import { glowTexture } from './textures';

/** A faint dust of background stars, deterministically placed. */
export function createStarfield(count = 1400, radius = 320): Points {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Deterministic spread using an irrational-angle spiral on a shell.
    const t = (i + 0.5) / count;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const r = radius * (0.6 + 0.4 * (((i * 9301 + 49297) % 233280) / 233280));
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const mat = new PointsMaterial({
    size: 1.6,
    map: glowTexture(),
    color: 0x9fb4ff,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: AdditiveBlending,
    sizeAttenuation: true,
    fog: false, // scenery: scene fog would swallow the distant shell
  });
  const pts = new Points(geo, mat);
  pts.renderOrder = -1;
  return pts;
}
