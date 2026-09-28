// Per-frame context shared by all entity views.
import type * as THREE from 'three';
import type { Vec3 } from '../../core/math';
import type { EntityId, PrivateHeroView } from '../../core/types';
import type { Lang } from '../../game/settings';
import type { Effects } from '../vfx/effects';
import type { TroopBadgeLayer } from './nameplate';

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
  /** troops / NPCs beyond this are hidden (heroes are never distance-culled) */
  characterDistance: number;
  /** the tier's draw distance (m): loot / crates beyond its fog are not drawn */
  drawDistance?: number;
  /** the quality tier's LOD distance scale (entities/lod.ts; default 1) */
  lodScale?: number;
  /** this frame's camera frustum (off-screen characters animate less often: entities/lod.ts) */
  frustum?: THREE.Frustum | null;
  /** shared batch for troop / NPC overhead markers (one draw call) */
  badges: TroopBadgeLayer;
  shadows: boolean;
  /** frame counter (for staggered work) */
  frame: number;
  /**
   * Chest of the hero the camera follows (local hero / spectate target), null
   * for orbit / free cameras: characters between the camera and it fade out.
   */
  focusPos?: THREE.Vector3 | null;
  /** normalised camera forward (screen-coverage fade of your own squad) */
  camDir?: THREE.Vector3 | null;
  /** never near-camera faded: the downed ally the local hero is reviving (kneeling right beside him) */
  keepVisibleId?: EntityId | null;
}
