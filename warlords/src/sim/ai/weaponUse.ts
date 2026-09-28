// How a bot handles its gun (weapons spec C10): when to raise the sights, when the sights are
// actually up, whether the crosshair is on target for this weapon, burst control, the sidearm
// inside a scope's / launcher's minimum range, and the recoil a bot fails to pull down. HeroBot
// and the weapon duel harness (tests/unit/balance/duelHarness.ts DuelBrain) both use these, so a
// balance measured in duels is the balance the bots in a match play.
import type { BotDifficulty, Entity } from '../../core/types';
import { WEAPON_BY_ID } from '../../data/weapons';
import type { WeaponDef } from '../../data/types';
import type { SimApi } from '../api';
import { MOVE_AIMED, MOVE_AIMED_OTHER, adsEase, aimProfile, stepAdsT } from '../../data/weaponFeel';
import { raiseFromSprint } from '../handling';
import { LOCK_ADS_T } from '../combat';
import type { Rng } from '../../core/rng';
import type { AimOut } from './aimer';
import type { DifficultyProfile } from './difficulty';

const DEG = Math.PI / 180;

/** Scoped / drawn long guns: a 3–10° hip cone is useless, the sights are the gun (C10-12). */
export const aimsAlways = (def: WeaponDef): boolean => def.class === 'sniper' || def.class === 'dmr' || def.class === 'bow';

/** Beyond this the sights come up on every gun that has them (rifles, LMGs, SMGs, pistols, crossbows, launchers). */
export const ADS_BEYOND = 12;
/** A DMR's hip cone (3–4.5°) still lands up close; its sights come up beyond this. */
export const DMR_ADS_BEYOND = 10;

/** 方天's lock-on range (sim/combat.ts pickHomingTargets). */
const lockRangeOf = (def: WeaponDef): number => (def.special === 'multiTarget' ? (def.specialParams.lockRange ?? 40) : 0);

/**
 * Raise the sights at `d` m? Snipers and bows beyond 4 m, DMRs beyond 10 m (easy bots: both beyond
 * 25 m); shotguns and flamers never; 方天 from its sidearm distance out to its lock range (only a
 * fully aimed volley locks, weapons spec R7); everything else beyond ADS_BEYOND — beyond 2 m at a
 * `downed` target (a crawling body is small and cannot dodge: finish it aimed). `restrained`: the
 * bot 主公's opening seconds on a hero (LORD_RESTRAINT.gunOpening) — his rifle stays at the hip
 * inside 22 m (16 m hard), as it always did: his gun opens the fight, it does not end it.
 * (Bots hip-fired every rifle, LMG and SMG out to 22 m, where the hip cone makes them harmless —
 * a 15 m carbine hit 17 % of its shots.)
 */
export function wantsAds(def: WeaponDef | undefined, d: number, prof: DifficultyProfile, downed = false, restrained = false): boolean {
  if (!def || def.melee) return false;
  if (def.class === 'shotgun' || def.class === 'flamer') return false;
  if (downed && d > 2) return true;
  if (def.class === 'dmr') return d > (prof.name === 'easy' ? 25 : DMR_ADS_BEYOND);
  if (aimsAlways(def)) return prof.name === 'easy' ? d > 25 : d > 4;
  if (restrained) return d > (prof.name === 'hard' ? 16 : 22);
  if (d <= lockRangeOf(def)) return d > sidearmInside(def);
  return d > ADS_BEYOND;
}

/**
 * From here out a sniper, DMR or bow stands still while aimed (C10-6): 40 m — and a DMR from where
 * its moving-aimed penalty (data/weaponFeel.ts MOVE_AIMED 1.2°, the cone's added half-angle) is
 * wider than a body (0.4 m half-width), ≈ 19 m: its aimed cone is 0.1–0.2°, so strafing with the
 * sights up wasted most shots between 20 and 40 m (25 % hits at 30 m strafing, 51 % planted).
 * (The sniper and the bow keep 40 m: planted from 9 / 23 m they out-shot the rifle at 30 m, D4.)
 */
export function plantRange(def: WeaponDef): number {
  if (def.class !== 'dmr') return 40;
  return Math.min(40, 0.4 / Math.tan(((MOVE_AIMED.dmr ?? MOVE_AIMED_OTHER) * Math.PI) / 180));
}

/** Plant the feet (no strafing) while aimed with a sniper, DMR or bow beyond its plantRange (C10-6). */
export const plantsFeet = (def: WeaponDef | undefined, d: number, aimed: boolean): boolean => !!def && aimed && aimsAlways(def) && d >= plantRange(def);

/**
 * The sim's aim progress, mirrored from the buttons the bot presses (data/weaponFeel.ts stepAdsT
 * over the class's ADS time; a weapon swap starts from the hip; aim or fire pressed mid-sprint
 * holds it at the hip for the class's sprint-to-fire time, sim/handling.ts raiseFromSprint) — a
 * bot cannot read the host's number, but it knows what it pressed and that it was sprinting.
 */
export class AdsTracker {
  t = 0;
  private weapon = '';
  private raiseUntil = 0;
  /** `sprinting`: the bot's hero was sprinting as it pressed (self.hero.sprinting); `firing`: fire is held this tick. */
  update(def: WeaponDef | undefined, aiming: boolean, dt: number, now = 0, sprinting = false, firing = false): number {
    const id = def?.id ?? '';
    if (id !== this.weapon) {
      this.weapon = id;
      this.t = 0;
    }
    this.raiseUntil = raiseFromSprint(now, this.raiseUntil, sprinting, firing, aiming, false, def);
    this.t = stepAdsT(this.t, aiming && !!def, aimProfile(def).adsTime, dt);
    if (now < this.raiseUntil) this.t = 0;
    return this.t;
  }
  /** Fire pressed this tick while sprinting: the gun comes up for sprintOut first (the aim progress with it). */
  fired(def: WeaponDef | undefined, now: number, sprinting: boolean): void {
    this.raiseUntil = raiseFromSprint(now, this.raiseUntil, sprinting, true, false, false, def);
  }
}

/**
 * The sights are up enough to shoot (C10-7): a scoped gun — the sniper, a DMR (its near sight is
 * no lens overlay, but its hip cone is 3–4.5° against 0.1–0.2° aimed) or 烈弓's scope — at aim
 * progress ≥ 0.9, a bow drawn ≥ 0.95 beyond 10 m (a snap shot up close is fine), 方天 fully aimed
 * inside its lock range (else no rocket homes: the bots never locked inside 22 m); everything else
 * any time.
 */
export function sightsReady(def: WeaponDef, adsT: number, d: number): boolean {
  // 方天 inside its lock range: only a fully aimed volley locks (the tracker's estimate + a margin)
  if (def.special === 'multiTarget' && d <= lockRangeOf(def)) return adsT >= LOCK_ADS_T + 0.01;
  if (def.class === 'bow' && d > 10) return adsT >= 0.95;
  if (def.class === 'sniper' || def.class === 'dmr' || aimProfile(def).overlay) return adsT >= 0.9;
  return true;
}

/**
 * The crosshair is on the target for this weapon: within the target's size plus some of the
 * cone. A projectile is judged against its lead / holdover point (AimOut.leadErrAngle), not the
 * target's body: a well-led arrow points beside the target (C10-2).
 */
export function onTarget(def: WeaponDef, o: AimOut, ads: boolean, prof: DifficultyProfile): boolean {
  const spread = ((ads ? def.spreadAds : def.spreadHip) * DEG) / 2;
  // targetAngle's 0.63 m half-size is ~1.6× a body's half-width: a bolt-action (< 1 shot/s
  // hitscan) waits until it is really on the body instead of spending the shot (C10: qilin hit
  // 22 % at 80 m and lost to 烈弓 there)
  const slack = def.fireRate < 1 && !def.projectile ? 1 : 1.25;
  const tol = (o.targetAngle * slack + spread * (def.pellets > 1 ? 1.2 : 0.4)) * (prof.name === 'easy' ? 1.6 : 1);
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

/**
 * A lock-on (方天) rocket is homing on `self` — exactly what the lock warning shows a human (C8):
 * a real lock, not any 方天 rocket flying its way (bots rolled out of unlocked hip volleys) (C10-9).
 */
export const lockedRocketAt = (sim: SimApi, self: Entity): boolean => sim.lockedOn(self.id);

/** Chance a bot dodge-rolls when a 方天 rocket is locked on it (C10-9). */
export const LOCK_DODGE: Readonly<Record<BotDifficulty, number>> = { easy: 0, normal: 0.3, hard: 0.6 };

/** Aim blend of the recoil (0 hip … 1 aimed) at aim progress `adsT`. */
export const kickBlend = (adsT: number): number => adsEase(adsT);
