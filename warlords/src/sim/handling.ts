// Weapon handling rules shared by the sim and the client's prediction (pure; no World, no DOM):
// how fast you walk with the sights up, how long a gun takes to come up out of a sprint, and the
// semi-auto fire buffer. The host (sim/world.ts, sim/combat.ts heroFire, sim/physics.ts) and the
// client (net/clientView.ts movement prediction, render/localFire.ts shot prediction) call these
// same functions, so a prediction never disagrees with the host about them (weapons spec C1, R10).
import type { WeaponDef } from '../data/types';
import { AIM_PROFILES, aimProfile, type AimProfile } from '../data/weaponFeel';

/** What the handling rules read of a weapon (the client's shot predictor carries only this much). */
export type HandlingDef = Pick<WeaponDef, 'id' | 'class'>;

// the aim profile (data/weaponFeel.ts AIM_PROFILES + AIM_BY_WEAPON: 雌雄 handles like an SMG) carries
// both numbers per class, weapons spec C1; aimProfile reads only the id and the class
const profileOf = (def: HandlingDef): AimProfile => aimProfile(def as WeaponDef);

/** Walk-speed multiplier with this weapon's sights up (physics MoveMods.adsMul; a rifle's without a weapon). */
export function adsMoveMul(def: HandlingDef | undefined): number {
  return def ? profileOf(def).adsMove : AIM_PROFILES.rifle.adsMove;
}

/** Seconds this weapon takes to come up out of a sprint (0 without a weapon). */
export function sprintOutTime(def: HandlingDef | undefined): number {
  return def ? profileOf(def).sprintOut : 0;
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
