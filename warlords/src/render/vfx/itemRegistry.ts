// Item-card VFX registry: the renderer calls the registered function for every
// { t: 'itemUse' } event (the moment a card is played); items without one get
// the generic coloured sparkle + ring. Bespoke effects live in items-vfx.ts
// (registered by registerAll.ts). Lingering results of a card (fields, traps,
// grenades, EMP / heal explosions) are drawn by their own entities / events.
import type * as THREE from 'three';
import type { EntityId, GameEvent } from '../../core/types';
import type { Effects } from './effects';

export type ItemUseEvent = Extract<GameEvent, { t: 'itemUse' }>;

export interface ItemVfxContext {
  fx: Effects;
  /** chest of the hero who played the card (null: not visible) */
  userPos: THREE.Vector3 | null;
  /** chest of the target hero / unit, if any and visible */
  targetPos: THREE.Vector3 | null;
  /** ev.pos, or the target / user position */
  point: THREE.Vector3 | null;
  /** facing of the user (horizontal, normalised) */
  dir: THREE.Vector3;
  /** the card colour (ItemDef.color, HDR-boosted) */
  color: THREE.Color;
  localId: EntityId | null;
}

export type ItemVfxFn = (ctx: ItemVfxContext, ev: ItemUseEvent) => void;

const registry = new Map<string, ItemVfxFn>();

/** Register (or replace) the VFX for an item id. Returns an unregister function. */
export function setItemVfx(id: string, fn: ItemVfxFn): () => void {
  registry.set(id, fn);
  return () => {
    if (registry.get(id) === fn) registry.delete(id);
  };
}

export function getItemVfx(id: string): ItemVfxFn | undefined {
  return registry.get(id);
}

export function itemVfxIds(): string[] {
  return [...registry.keys()];
}
