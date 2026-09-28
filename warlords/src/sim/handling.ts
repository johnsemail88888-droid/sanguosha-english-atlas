// Weapon handling rules shared by the sim and the client's prediction (pure; no World, no DOM):
// how fast you walk with the sights up, how long a gun takes to come up out of a sprint, and the
// semi-auto fire buffer. The host (sim/world.ts, sim/combat.ts heroFire, sim/physics.ts) and the
// client (net/clientView.ts movement prediction, render/localFire.ts shot prediction) call these
// same functions, so a prediction never disagrees with the host about them (weapons spec C1, R10).
import type { WeaponClass, WeaponDef } from '../data/types';
import { aimProfile } from '../data/weaponFeel';

/** Walk-speed multiplier while aimed, per class (replaces physics ADS_MUL 0.6 for heroes). */
export const ADS_MOVE: Readonly<Record<WeaponClass, number>> = {
  pistol: 0.75,
  smg: 0.72,
  flamer: 0.7,
  shotgun: 0.68,
  rifle: 0.6,
  crossbow: 0.6,
  bow: 0.55,
  dmr: 0.52,
  launcher: 0.5,
  lmg: 0.45,
  sniper: 0.42,
  melee: 0.6,
};

/** Seconds a gun takes to come up out of a sprint before it can fire (sprint-to-fire), per class. */
export const SPRINT_OUT: Readonly<Record<WeaponClass, number>> = {
  pistol: 0.1,
  smg: 0.12,
  flamer: 0.12,
  shotgun: 0.15,
  rifle: 0.18,
  crossbow: 0.18,
  bow: 0.2,
  dmr: 0.22,
  launcher: 0.25,
  lmg: 0.28,
  sniper: 0.3,
  melee: 0,
};

/** Weapons that handle like another class (雌雄 akimbo: an SMG's handling, spec C1). */
export const HANDLES_LIKE: Readonly<Record<string, WeaponClass>> = { cixiong: 'smg' };

/** What the handling rules read of a weapon (the client's shot predictor carries only this much). */
export type HandlingDef = Pick<WeaponDef, 'id' | 'class'>;

/** The aim profile's own handling numbers when it carries them (data/weaponFeel.ts AimProfile, once it has adsMove / sprintOut). */
type HandlingFields = Partial<Record<'adsMove' | 'sprintOut', number>>;
// (aimProfile reads only the id and the class)
const own = (def: HandlingDef): HandlingFields => aimProfile(def as WeaponDef) as HandlingFields;
const handlingClass = (def: HandlingDef): WeaponClass => HANDLES_LIKE[def.id] ?? def.class;

/** Walk-speed multiplier with this weapon's sights up (physics MoveMods.adsMul). */
export function adsMoveMul(def: HandlingDef | undefined): number {
  if (!def) return ADS_MOVE.rifle;
  return own(def).adsMove ?? ADS_MOVE[handlingClass(def)] ?? ADS_MOVE.rifle;
}

/** Seconds this weapon takes to come up out of a sprint. */
export function sprintOutTime(def: HandlingDef | undefined): number {
  if (!def) return 0;
  return own(def).sprintOut ?? SPRINT_OUT[handlingClass(def)] ?? SPRINT_OUT.rifle;
}

/**
 * Sprint-to-fire: fire or ADS pressed while sprinting (not with 神速's sprintAds) cancels the
 * sprint and raises the gun: the new "gun is up" time, else `until` unchanged. While it is in the
 * future no shot fires and the aim progress stays at the hip.
 */
export function raiseFromSprint(now: number, until: number, wasSprinting: boolean, fireHeld: boolean, adsHeld: boolean, sprintAds: boolean, def: HandlingDef | undefined): number {
  if (!wasSprinting || sprintAds || !(fireHeld || adsHeld)) return until;
  return Math.max(until, now + sprintOutTime(def));
}

/** A semi-auto press this early before the gun is ready again fires when it is (instead of being lost). */
export const FIRE_BUFFER = 0.12;

/**
 * The semi-auto trigger with its buffer (sim/combat.ts heroFire, render/localFire.ts): `pressed` =
 * the button went down now, `queuedAt` = an earlier press still waiting (−1 none), `readyAt` = when
 * the next shot may fire (nextFireAt), `raiseAt` = when the gun is up from a sprint. A press waits
 * for the gun when it came at most FIRE_BUFFER before readyAt (a press during a sprint-out always
 * waits); a later one is lost, as before. Returns whether to shoot now and the new queue.
 */
export function semiTrigger(now: number, pressed: boolean, queuedAt: number, readyAt: number, raiseAt = 0): { fire: boolean; queuedAt: number } {
  const q = pressed ? now : queuedAt;
  if (q < 0) return { fire: false, queuedAt: -1 };
  if (now + 1e-9 >= readyAt && now + 1e-9 >= raiseAt) return { fire: true, queuedAt: -1 };
  if (readyAt - q <= FIRE_BUFFER + 1e-9) return { fire: false, queuedAt: q };
  return { fire: false, queuedAt: -1 };
}
