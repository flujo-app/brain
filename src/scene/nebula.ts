import {
  AdditiveBlending,
  Group,
  Sprite,
  SpriteMaterial,
} from 'three';
import type { Grouping } from '../grouping';
import type { SectionedLayout } from '../layout/sectionedLayout';
import { nebulaTexture } from './textures';

/**
 * A faint coloured cloud behind each galaxy, so sections read as regions.
 * Each galaxy gets one wide veil plus a few offset puffs — layered soft
 * sprites read as gas, a single one reads as a bokeh blob.
 */
export function createNebulae(grouping: Grouping, layout: SectionedLayout): Group {
  const group = new Group();
  const tex = nebulaTexture();
  grouping.groups.forEach((g, gi) => {
    const center = layout.centers.get(g.id)!;
    const radius = layout.radii.get(g.id)!;
    for (let k = 0; k < 4; k++) {
      const rnd = (n: number) => ((((gi * 31 + k * 17 + n * 7) * 2654435761) % 1000) / 1000) - 0.5;
      const material = new SpriteMaterial({
        map: tex,
        color: g.color.clone(),
        transparent: true,
        opacity: k === 0 ? 0.055 : 0.03,
        blending: AdditiveBlending,
        depthWrite: false,
        rotation: rnd(3) * Math.PI * 2,
      });
      const sprite = new Sprite(material);
      const spread = k === 0 ? 0 : radius * 0.6;
      sprite.position.set(
        center.x + rnd(0) * spread * 2,
        center.y + rnd(1) * spread * 1.4,
        center.z + rnd(2) * spread * 2,
      );
      sprite.scale.setScalar(k === 0 ? radius * 2.6 + 8 : radius * (1.1 + (rnd(4) + 0.5) * 0.9) + 4);
      sprite.userData.baseOpacity = material.opacity;
      group.add(sprite);
    }
  });
  group.renderOrder = -1;
  return group;
}

/** Scale all nebula opacities (1 = resting); used to clear the stage in focus mode. */
export function setNebulaeDim(group: Group, factor: number): void {
  for (const child of group.children) {
    const sprite = child as Sprite;
    sprite.material.opacity = (sprite.userData.baseOpacity ?? 0.05) * factor;
  }
}
