// Small test worlds for item tests: five human-controlled 'dummy' heroes on
// the flat part of the hand-made test map (no squads, zone, ambient loot).
import type { Vec3 } from '../../../src/core/math';
import type { Entity, GameEvent, InputAction, InputFrame, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { aimAnglesFor } from '../../../src/sim/aim';
import type { AbilityImplEx } from '../../../src/sim/ext';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

export { hero, place, stepN };

export const ROLES5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

let seq = 1000;

/**
 * World with every hero parked far apart; seat 2 (a rebel) is the usual item
 * user at (0, 20) facing +z. The test map spans ±60 m: keep everything inside ±55.
 */
export function setup(opts: Parameters<typeof makeWorld>[1] = {}): { w: World; a: Entity; b: Entity; c: Entity } {
  const w = makeWorld(ROLES5, opts);
  place(w, hero(w, 0), -50, 50);
  place(w, hero(w, 1), -50, 42);
  place(w, hero(w, 4), 50, 50);
  const a = hero(w, 2);
  const b = hero(w, 3);
  const c = hero(w, 4);
  place(w, a, 0, 20, Math.PI); // facing +z
  place(w, b, 50, 42);
  w.step();
  w.drainEvents();
  return { w, a, b, c };
}

export const chest = (e: Entity): Vec3 => ({ x: e.pos.x, y: e.pos.y + 1.1, z: e.pos.z });
export const feet = (e: Entity): Vec3 => ({ x: e.pos.x, y: e.pos.y, z: e.pos.z });

/** An input frame whose crosshair passes through `point`. */
export function aimFrame(w: World, e: Entity, point: Vec3, p: Partial<InputFrame> = {}): InputFrame {
  const ang = aimAnglesFor(e.pos, point);
  return { ...emptyInput(seq++), yaw: ang.yaw, pitch: ang.pitch, aimPoint: { ...point }, viewTick: w.tick, ...p };
}

export function send(w: World, e: Entity, frame: InputFrame, actions: InputAction[] = []): void {
  w.setInput(e.hero!.playerId, { ...frame, actions });
}

/** Aim at `point` (optionally at `target`) and press the item key for `slot`; runs one tick. */
export function useSlot(w: World, e: Entity, slot: number, point: Vec3, target?: Entity): void {
  send(w, e, aimFrame(w, e, point, { aimTargetId: target?.id }), [{ a: 'item', slot }]);
  w.step();
}

/** Put `count` of `itemId` into slot 0 (others emptied) and use it at `point`. */
export function giveAndUse(w: World, e: Entity, itemId: string, point: Vec3, target?: Entity, count = 1): void {
  e.hero!.items = [{ id: itemId, count }, null, null, null];
  useSlot(w, e, 0, point, target);
}

/** Keep aiming (no actions) for n ticks — for channelled items. */
export function hold(w: World, e: Entity, n: number, point: Vec3, target?: Entity): void {
  for (let i = 0; i < n; i++) {
    send(w, e, aimFrame(w, e, point, { aimTargetId: target?.id }));
    w.step();
  }
}

export const slotCount = (e: Entity, slot = 0): number => e.hero!.items[slot]?.count ?? 0;

export function events<T extends GameEvent['t']>(evs: GameEvent[], t: T): Extract<GameEvent, { t: T }>[] {
  return evs.filter((x): x is Extract<GameEvent, { t: T }> => x.t === t);
}

/** Inject an extra passive onto a hero (vetoes, test hooks). */
export function inject(w: World, e: Entity, impl: AbilityImplEx): void {
  w.heroRt(e.id)!.abilities.push({
    def: { id: impl.id, slot: 'passive', nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {} },
    impl,
  });
}

/** Seconds → ticks at 30 Hz. */
export const ticks = (s: number): number => Math.round(s * 30);
