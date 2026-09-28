// How a bot handles its gun (weapons spec C10): when to raise the sights, when the sights are
// actually up, whether the crosshair is on target for this weapon, burst control, the sidearm
// inside a scope's / launcher's minimum range, and the recoil a bot fails to pull down. HeroBot
// and the weapon duel harness (tests/unit/balance/duelHarness.ts DuelBrain) both use these, so a
// balance measured in duels is the balance the bots in a match play.
import type { BotDifficulty } from '../../core/types';
import type { WeaponDef } from '../../data/types';
import { adsEase, aimProfile, stepAdsT } from '../../data/weaponFeel';
import type { Rng } from '../../core/rng';
import type { AimOut } from './aimer';
import type { DifficultyProfile } from './difficulty';

const DEG = Math.PI / 180;

/** Scoped / drawn long guns: a 3–10° hip cone is useless, the sights are the gun (C10-12). */
export const aimsAlways = (def: WeaponDef): boolean => def.class === 'sniper' || def.class === 'dmr' || def.class === 'bow';

/**
 * Raise the sights at `d` m? DMRs, snipers and bows at every range beyond 4 m (easy bots only
 * beyond 25 m); shotguns and flamers never; everything else beyond 16 m (hard) / 22 m.
 */
export function wantsAds(def: WeaponDef | undefined, d: number, prof: DifficultyProfile): boolean {
  if (!def || def.melee) return false;
  if (aimsAlways(def)) return prof.name === 'easy' ? d > 25 : d > 4;
  if (def.class === 'shotgun' || def.class === 'flamer') return false;
  return d > (prof.name === 'hard' ? 16 : 22);
}

/** Plant the feet (no strafing) while aimed with a sniper, DMR or bow at 40 m or more: moving opens the aimed cone (C10-6). */
export const plantsFeet = (def: WeaponDef | undefined, d: number, aimed: boolean): boolean => !!def && aimed && aimsAlways(def) && d >= 40;

/**
 * The sim's aim progress, mirrored from the ADS button the bot presses (data/weaponFeel.ts
 * stepAdsT over the class's ADS time; a weapon swap starts from the hip) — a bot cannot read
 * the host's number, but it knows what it pressed.
 */
export class AdsTracker {
  t = 0;
  private weapon = '';
  update(def: WeaponDef | undefined, aiming: boolean, dt: number): number {
    const id = def?.id ?? '';
    if (id !== this.weapon) {
      this.weapon = id;
      this.t = 0;
    }
    this.t = stepAdsT(this.t, aiming && !!def, aimProfile(def).adsTime, dt);
    return this.t;
  }
}

/**
 * The sights are up enough to shoot (C10-7): a scope (lens overlay) at aim progress ≥ 0.9, a bow
 * drawn ≥ 0.95 beyond 10 m (a snap shot up close is fine); everything else any time.
 */
export function sightsReady(def: WeaponDef, adsT: number, d: number): boolean {
  if (def.class === 'bow' && d > 10) return adsT >= 0.95;
  if (aimProfile(def).overlay) return adsT >= 0.9;
  return true;
}

/**
 * The crosshair is on the target for this weapon: within the target's size plus some of the
 * cone. A projectile is judged against its lead / holdover point (AimOut.leadErrAngle), not the
 * target's body: a well-led arrow points beside the target (C10-2).
 */
export function onTarget(def: WeaponDef, o: AimOut, ads: boolean, prof: DifficultyProfile): boolean {
  const spread = ((ads ? def.spreadAds : def.spreadHip) * DEG) / 2;
  const tol = (o.targetAngle * 1.25 + spread * (def.pellets > 1 ? 1.2 : 0.4)) * (prof.name === 'easy' ? 1.6 : 1);
  return (def.projectile ? o.leadErrAngle : o.errAngle) <= tol;
}

/**
 * Burst control for automatics at range (C10-1): fire through a 0.25–0.6 s burst, rest 0.15–0.4 s,
 * repeat. (HeroBot used to start the rest with the burst, so one round went out per window.)
 * LMGs hold the trigger; inside 1.1 × falloffStart everyone does.
 */
export class BurstControl {
  private burstUntil = 0;
  private pauseUntil = 0;
  /**
   * May the trigger stay down this tick? `restrained`: short bursts with long rests at any range,
   * whatever the skill (the bot 主公 opening on a hero, LORD_RESTRAINT.gunOpening).
   */
  allow(now: number, rng: Rng, def: WeaponDef, d: number, prof: DifficultyProfile, restrained = false): boolean {
    if (!restrained && (!prof.burstControl || d <= def.falloffStart * 1.1 || def.class === 'lmg')) return true;
    if (now >= this.burstUntil) {
      if (now < this.pauseUntil) return false;
      this.burstUntil = now + (restrained ? 0.15 + rng.next() * 0.2 : 0.25 + rng.next() * 0.35);
      this.pauseUntil = this.burstUntil + (restrained ? 0.3 + rng.next() * 0.2 : 0.15 + rng.next() * 0.25);
    }
    return true;
  }
}

/**
 * Inside this distance the primary is the wrong gun — swap to the sidearm (C10-11): a scope or a
 * drawn bow inside 12 m, a launcher inside its arming distance + 2 m or its blast + 1.5 m.
 */
export function sidearmInside(def: WeaponDef | undefined): number {
  if (!def || def.melee) return 0;
  if (def.class === 'sniper' || def.class === 'bow') return 12;
  if (def.class === 'launcher') return Math.max((def.specialParams.armDist ?? 0) + 2, (def.projectile?.explodeRadius ?? 0) + 1.5);
  return 0;
}

/** Never fire a launcher at a target this close: its own blast (C10-11). */
export const launcherTooClose = (def: WeaponDef, d: number): boolean => def.class === 'launcher' && d < (def.projectile?.explodeRadius ?? 0) + 1;

/** How much of each shot's recoil a bot pulls back down (C10-8); the rest climbs its aim. */
export const RECOIL_COMP: Readonly<Record<BotDifficulty, number>> = { easy: 0.4, normal: 0.6, hard: 0.8 };

/** Chance a bot dodge-rolls when a 方天 rocket is locked on it (C10-9). */
export const LOCK_DODGE: Readonly<Record<BotDifficulty, number>> = { easy: 0, normal: 0.3, hard: 0.6 };

/** Aim blend of the recoil (0 hip … 1 aimed) at aim progress `adsT`. */
export const kickBlend = (adsT: number): number => adsEase(adsT);
