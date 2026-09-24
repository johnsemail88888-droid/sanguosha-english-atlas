// Per-frame context shared by all entity views.
import type * as THREE from 'three';
import type { Vec3 } from '../../core/math';
import type { EntityId, PrivateHeroView } from '../../core/types';
import type { Lang } from '../../game/settings';
import type { Effects } from '../vfx/effects';

export interface EntityCtx {
  time: number;
  dt: number;
  camPos: THREE.Vector3;
  fovDeg: number;
  localId: EntityId | null;
  local: PrivateHeroView | null;
  /** ids of the local player's squad */
  squad: ReadonlySet<EntityId>;
  lang: Lang;
  fx: Effects;
  /** static line-of-sight test (colliders + terrain) */
  blocked(a: Vec3, b: Vec3): boolean;
  groundY(x: number, z: number): number;
  characterDistance: number;
  shadows: boolean;
  /** frame counter (for staggered work) */
  frame: number;
}
