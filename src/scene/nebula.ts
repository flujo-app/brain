import {
  AdditiveBlending,
  Group,
  Sprite,
  SpriteMaterial,
} from 'three';
import type { Grouping } from '../grouping';
import type { SectionedLayout } from '../layout/sectionedLayout';
import { glowTexture } from './textures';

/** A faint coloured cloud behind each galaxy, so sections read as regions. */
export function createNebulae(grouping: Grouping, layout: SectionedLayout): Group {
  const group = new Group();
  const tex = glowTexture();
  for (const g of grouping.groups) {
    const center = layout.centers.get(g.id)!;
    const radius = layout.radii.get(g.id)!;
    const sprite = new Sprite(
      new SpriteMaterial({
        map: tex,
        color: g.color.clone(),
        transparent: true,
        opacity: 0.07,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    sprite.position.copy(center);
    sprite.scale.setScalar(radius * 2.2 + 6);
    group.add(sprite);
  }
  group.renderOrder = -1;
  return group;
}
