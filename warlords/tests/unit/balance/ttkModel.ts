// The human TTK model of the weapons spec (D3; a port of the study's ttk3.mjs, 'new' mechanics,
// 'omega' aim model). A standing human shoots a target strafing at 5 m/s, `d` m away, on open
// ground: time from the first shot until 300 / 400 / 500 damage (20 % of hits on the head, or
// none), reloads included, 12 s cap — per weapon, range, skill and hip / ADS.
//
// Everything the sim decides is read from src, so the model follows the game: the weapons
// (data/weapons.ts), the spread cone (data/weaponFeel.ts spreadDeg: hip → aimed, MOVE_AIMED, the
// class's BLOOM with its linear recovery), centre-weighted single shots (sim/combat.ts spreadDir),
// the ADS time / sway / hold breath / recoil kick of the aim profile (aimProfile + shotKick units),
// the bow's draw (drawDamageMul / BOW_HIP_SPEED), launcher arming, armor (data/items.ts ARMORS,
// sim/damageKinds.ts: every direct weapon hit is a bullet, fire skips 藤甲's reduction) and 方天's
// lock (only fully aimed, one homing rocket per distinct target — one target here — the rest
// straight). What is the model's own: the HUMAN (SKILLS: motor floor shrinking with zoom, tracking
// lag × the target's angular speed, lead / holdover misjudgement, the share of each kick pulled
// down), a standing shooter, no cover / skills, missed splash under-counted.
import type { WeaponClass, WeaponDef } from '../../../src/data/types';
import { ARMOR_BY_ID, WEAPONS, WEAPON_BY_ID } from '../../../src/data';
import { BOW_HIP_DAMAGE, BOW_HIP_SPEED, adsEase, aimProfile, bloomIdle, bloomRow, recoilSettleDelay, shotKick, spreadDeg } from '../../../src/data/weaponFeel';
import { CHAR_HEIGHT, CHAR_RADIUS } from '../../../src/sim/physics';

// ── model constants (the study's) ─────────────────────────────────────────────
const DT = 1 / 30;
const EYE = 1.62;
const HEAD_R = Math.max(0.15, 0.22 * (CHAR_HEIGHT / 1.8));
const HB = { r: CHAR_RADIUS, bodyTop: CHAR_HEIGHT - HEAD_R * 1.6, headY: CHAR_HEIGHT - HEAD_R, headR: HEAD_R };
const CENTER_EXPLODE = 0.9;
const PROJ_INFLATE = 0.1;
const AIM_Y = 1.0;
const TARGET_SPEED = 5.0;
const TRACK_TAU = 0.15;
const MIN_CLICK = 0.15;
/** seconds a cell gives up after (the TTK strip's 'cannot kill'); the band check looks as far as its tolerance, CAP × 1.05 */
export const CAP = 12;
const HS_FRAC = 0.2;
const D2R = Math.PI / 180;
/** hold breath (Shift) leaves this share of a scope's sway */
const HOLD_BREATH_SWAY = 0.08;
/** horizontal recoil σ as a share of the vertical kick, per class (the study's recoil shape) */
const H_RATIO: Readonly<Record<WeaponClass, number>> = {
  pistol: 0.27, smg: 0.6, rifle: 0.33, lmg: 0.35, dmr: 0.18, sniper: 0.13, crossbow: 0.2, bow: 0.2, shotgun: 0.1, launcher: 0.1, flamer: 0.5, melee: 0,
};
/**
 * Share of the outstanding climb the game's settle takes back after a release (spec C3
 * AimProfile.recoverFrac; read from the aim profile once it carries it).
 */
const RECOVER_FRAC: Readonly<Record<WeaponClass, number>> = {
  pistol: 0.9, smg: 0.85, rifle: 0.8, lmg: 0.7, dmr: 0.95, crossbow: 0.95, sniper: 1, bow: 1, shotgun: 1, launcher: 1, flamer: 1, melee: 1,
};

export const RANGES = [5, 10, 20, 35, 50, 75, 100] as const;
export const ARMORS = ['none', 'tengjia', 'renwang', 'bagua', 'baiyin'] as const;
export type ArmorId = (typeof ARMORS)[number];

/**
 * HUMAN skill. floor: motor error at 1× (deg, 1σ); lag: tracking lag (s) × the target's angular
 * speed; lead / drop: σ of the lead / holdover misjudgement (share of the travel / drop); comp:
 * share of each recoil kick pulled down; tc: time constant of re-centring.
 */
export interface Skill {
  floor: number;
  lag: number;
  lead: number;
  drop: number;
  comp: number;
  tc: number;
}
export const SKILLS: Record<string, Skill> = {
  good: { floor: 0.22, lag: 0.02, lead: 0.3, drop: 0.07, comp: 0.8, tc: 0.15 },
  mid: { floor: 0.35, lag: 0.03, lead: 0.4, drop: 0.1, comp: 0.65, tc: 0.2 },
  casual: { floor: 0.5, lag: 0.045, lead: 0.5, drop: 0.15, comp: 0.45, tc: 0.28 },
};

/**
 * Touch + aim assist (spec C9): slowdown → floor × 0.85; follow `f` (hip 0.3 / aimed 0.4) of the
 * target's angular speed ω, capped at 10°/s → lag × (1 − min(fω, cap) / ω); recoil × 0.6 (touch).
 */
export function touchSkill(d: number, mode: 'hip' | 'ads', follow = { hip: 0.3, ads: 0.4 }, capDeg = 10): Skill {
  const om = ((TARGET_SPEED / d) * 180) / Math.PI;
  const fr = Math.min(follow[mode] * om, capDeg) / om;
  return { ...SKILLS.mid, floor: 0.5 * 0.85, lag: 0.05 * (1 - fr), lead: 0.45, drop: 0.12, comp: 0.55, tc: 0.24 };
}

// ── rng (mulberry32, seeded per cell: the model is deterministic) ────────────
let rnd: () => number = mulberry32(12345);
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seed(s: number): void {
  rnd = mulberry32(s);
}
function gauss(): number {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** 0 miss, 1 body, 2 head: a point (x lateral, y height) against the target's silhouette. */
function sil(x: number, y: number, inf: number): 0 | 1 | 2 {
  const r = HB.r + inf;
  if (x <= r && x >= -r && y >= 0 && y <= HB.bodyTop) return 1;
  const hr = HB.headR + inf;
  const dy = y - HB.headY;
  return x * x + dy * dy <= hr * hr ? 2 : 0;
}
function falloffMul(w: WeaponDef, d: number): number {
  if (d <= w.falloffStart || w.maxRange <= w.falloffStart) return 1;
  return 1 - 0.5 * Math.min(1, (d - w.falloffStart) / (w.maxRange - w.falloffStart));
}
function ballistic(v: number, g: number, d: number, yAim: number): { T: number; tf: number; slope: number; drop: number } | null {
  const dy = yAim - EYE;
  if (g <= 0) return { T: dy / d, tf: Math.hypot(d, dy) / v, slope: dy / d, drop: 0 };
  const A = (g * d * d) / (2 * v * v);
  const disc = d * d - 4 * A * (dy + A);
  if (disc < 0) return null;
  const T = (d - Math.sqrt(disc)) / (2 * A);
  const cos = 1 / Math.sqrt(1 + T * T);
  const tf = d / (v * cos);
  return { T, tf, slope: T - (g * d * (1 + T * T)) / (v * v), drop: 0.5 * g * tf * tf };
}

/** The wielder's passive damage multiplier (烈弓 beyond 30 m, 鬼道 thunder, 雌雄 vs the opposite gender when asked). */
function passiveMul(w: WeaponDef, d: number, opp: boolean): number {
  let m = 1;
  if (w.id === 'liegong' && d > 30) m *= 1.25;
  if (w.id === 'taiping' && w.dtype === 'thunder') m *= 1.3;
  if (opp && w.special === 'genderBonus') m *= w.specialParams.mul ?? 1;
  return m;
}
const undodgeable = (w: WeaponDef, d: number): boolean => w.id === 'wushuang' || (w.id === 'liegong' && d > 30);

interface ArmorState {
  now: number;
  followUntil?: number;
}

/** One hit through the armor rules (sim/combat.ts applyArmor + bulletEvadeChance). `direct`: a weapon's direct hit (a bullet). */
function armorApply(armor: ArmorId, w: WeaponDef, amount: number, type: string, direct: boolean, d: number, st: ArmorState): number {
  if (w.special === 'pierceArmor') return amount;
  const def = armor === 'none' ? undefined : ARMOR_BY_ID[armor];
  const bullet = direct;
  if (def?.special === 'bagua' && bullet && !undodgeable(w, d) && rnd() < (def.params.chance ?? 0.3)) {
    if (w.special === 'followUp') st.followUntil = st.now + (w.specialParams.window ?? 2);
    return 0;
  }
  if (w.special === 'noArmorBonus' && armor === 'none') amount *= w.specialParams.mul ?? 1.5;
  if (st.followUntil !== undefined && st.now <= st.followUntil) {
    amount *= w.specialParams.nextMul ?? 1.5;
    st.followUntil = undefined;
  }
  if (!def) return amount;
  if (bullet && type !== 'fire') amount *= 1 - def.bulletReduction;
  if (def.special === 'tengjia' && type === 'fire') amount *= def.params.fireMul ?? 1.75;
  else if (def.special === 'renwang' && bullet) amount *= def.params.mul ?? 0.6; // (front-only: an upper bound)
  else if (def.special === 'baiyin') amount = Math.min(amount, def.params.cap ?? 80);
  return amount;
}

export interface EngageOpts {
  armors?: readonly ArmorId[];
  /** the shooter strafes too (aimed: MOVE_AIMED; hip ×1.35) */
  moving?: boolean;
  /** touch recoil (× 0.6) */
  touch?: boolean;
  /** perfect aim at a rooted target's chest (1.1 m), perfect holdover: the D2 comparison */
  calib?: boolean;
  /** stop at this much damage (tX) */
  hpX?: number;
  /** the opposite gender (雌雄's bonus) */
  opp?: boolean;
  /** give up after this many seconds (default CAP) */
  cap?: number;
}

interface Variant {
  armor: ArmorId;
  hs: number;
  dmg: number;
  t300: number;
  t400: number;
  t500: number;
  tX?: number;
  st: ArmorState;
}

type Strat = 'full' | 'burst3' | 'burst5' | 'tap';

function engage(w: WeaponDef, d: number, skill: Skill, mode: 'hip' | 'ads', strat: Strat, opt: EngageOpts): { variants: Variant[]; shots: number; hits: number; pellets: number } {
  const calib = !!opt.calib;
  const cap = opt.cap ?? CAP;
  const ads = mode === 'ads';
  const cls = w.class;
  const prof = aimProfile(w);
  const zooms = [Math.max(1, w.adsZoom), ...prof.zoomSteps.slice(1).map((m) => Math.max(1, w.adsZoom) * m)];
  const zoom = d >= 75 && zooms.length > 1 ? zooms[1] : zooms[0];
  // HUMAN aim error: motor floor (shrinking with zoom) ⊕ tracking lag × the strafer's angular speed
  const zf = ads ? 0.5 + 0.5 / Math.max(1, zoom) : 1;
  const sigma = calib ? 0 : Math.hypot(skill.floor * zf, skill.lag * ((TARGET_SPEED / d) * 180) / Math.PI);
  const adsTime = calib || !ads ? 0 : prof.adsTime;
  const swayAmp0 = calib || !ads ? 0 : prof.sway * (prof.holdBreath ? HOLD_BREATH_SWAY : 1);
  const moving = !!opt.moving && !calib;
  const bl = bloomRow(w);
  const hRatio = H_RATIO[cls] ?? 0.3;
  const recFrac = (prof as { recoverFrac?: number }).recoverFrac ?? RECOVER_FRAC[cls] ?? 1;
  // recoil (degrees per shot) in the aim profile's units, aimed or at the hip; touch × 0.6
  const kickV = calib ? 0 : shotKick(w, ads ? 1 : 0).pitch * (opt.touch ? 0.6 : 1);
  const proj = w.projectile;
  const explosive = !!proj && proj.explodeRadius > 0;
  const aimY = calib ? 1.1 : explosive && w.special !== 'multiTarget' ? (cls === 'bow' ? AIM_Y : 0.2) : AIM_Y;
  // the bow's draw: the hip is a snap shot (damage × BOW_HIP_DAMAGE, speed × BOW_HIP_SPEED), ADS a full draw
  const draw = cls === 'bow' && !ads ? 0 : 1;
  const pSpeed = proj ? proj.speed * (cls === 'bow' ? BOW_HIP_SPEED + (1 - BOW_HIP_SPEED) * adsEase(draw) : 1) : 0;
  const drawDmg = cls === 'bow' ? BOW_HIP_DAMAGE + (1 - BOW_HIP_DAMAGE) * adsEase(draw) : 1;
  const bal = proj ? (calib ? { ...ballistic(pSpeed, 0, d, aimY)!, drop: 0 } : ballistic(pSpeed, proj.gravity, d, aimY)) : null;
  const inMaxRange = proj ? bal !== null && bal.tf <= proj.lifetime : d <= w.maxRange;
  const dtype = w.special === 'fireConvert' ? 'fire' : w.dtype;

  const variants: Variant[] = [];
  for (const armor of opt.armors ?? ARMORS) for (const hs of [0, HS_FRAC]) variants.push({ armor, hs, dmg: 0, t300: Infinity, t400: Infinity, t500: Infinity, st: { now: 0 } });
  if (!inMaxRange) return { variants, shots: 0, hits: 0, pellets: 0 };

  let mag = w.magSize;
  let reserve = w.magSize * w.reserveMags;
  let t = adsTime;
  let adsSince = 0;
  let bloom = 0;
  let lastFire = -1e9;
  let rampStart = t;
  let acc = t;
  let ex = gauss() * sigma;
  let ey = gauss() * sigma;
  let rx = 0;
  let ry = 0;
  let shots = 0;
  let hitsN = 0;
  let pelletsN = 0;
  let inBurst = 0;
  let burnUntil = -1;
  let burnNext = Infinity;
  const burnDps = w.specialParams.burnDps ?? 12;
  const tengjiaFire = ARMOR_BY_ID.tengjia.params.fireMul ?? 1.75;

  const record = (v: Variant, time: number, amount: number): void => {
    if (amount <= 0) return;
    v.dmg += amount;
    if (v.dmg >= 300 && v.t300 === Infinity) v.t300 = time;
    if (v.dmg >= 400 && v.t400 === Infinity) v.t400 = time;
    if (v.dmg >= 500 && v.t500 === Infinity) v.t500 = time;
    if (opt.hpX && v.dmg >= opt.hpX && v.tX === undefined) v.tX = time;
  };
  const flushBurn = (upTo: number): void => {
    while (burnNext <= upTo && burnNext <= burnUntil + 1e-9) {
      for (const v of variants) record(v, burnNext, (burnDps / 2) * (v.armor === 'tengjia' ? tengjiaFire : 1));
      burnNext += 0.5;
    }
  };
  const allDead = (): boolean => variants.every((v) => v.t500 < Infinity && (!opt.hpX || v.tX !== undefined));
  const pending: [number, number, number][] = [];
  const pm = passiveMul(w, d, !!opt.opp);
  const resolveEvent = (ev: [number, number, number]): void => {
    const [at, directAmt, splashAmt] = ev;
    flushBurn(at);
    for (const v of variants) {
      v.st.now = at;
      if (directAmt > 0) {
        const hm = v.hs > 0 ? (rnd() < HS_FRAC ? w.headshotMul : 1) : 1;
        record(v, at, armorApply(v.armor, w, directAmt * hm * pm, w.dtype, true, d, v.st));
      }
      if (splashAmt > 0) record(v, at, armorApply(v.armor, w, splashAmt * pm, w.dtype === 'normal' ? 'explosive' : w.dtype, false, d, v.st));
    }
  };
  const resolveUpTo = (time: number): void => {
    pending.sort((a, b) => a[0] - b[0]);
    while (pending.length && pending[0][0] <= time) resolveEvent(pending.shift()!);
  };

  while (t <= cap && !allDead()) {
    if (mag <= 0) {
      if (reserve <= 0) break;
      const take = Math.min(w.magSize, reserve);
      reserve -= take;
      t = lastFire + Math.max(w.reloadTime, 1e-6) + (ads ? adsTime : 0);
      mag = take;
      bloom = 0;
      rx = ry = 0;
      rampStart = t;
      inBurst = 0;
      adsSince = t - adsTime;
      if (t > cap) break;
    }
    const gap = t - lastFire;
    if (gap > (w.specialParams.resetAfter ?? 0.35)) rampStart = t;
    shots++;
    mag--;
    if (sigma > 0 && shots > 1) {
      const rho = Math.exp(-Math.max(0, gap) / TRACK_TAU);
      const k = Math.sqrt(1 - rho * rho);
      ex = rho * ex + k * sigma * gauss();
      ey = rho * ey + k * sigma * gauss();
    }
    let swayAmp = swayAmp0;
    if (!calib && ads && cls === 'bow' && prof.fatigueAfter > 0) swayAmp += Math.min(0.35, Math.max(0, t - adsSince - prof.fatigueAfter) * 0.14);
    const sx = swayAmp > 0 ? gauss() * 0.5 * swayAmp : 0;
    const sy = swayAmp > 0 ? gauss() * 0.5 * swayAmp : 0;

    // the cone of this shot (the bloom of the shots before it), then this shot's bloom
    if (shots > 1) bloom = Math.max(0, bloom - Math.max(0, gap - bloomIdle(w)) * bl.decay);
    const spread = spreadDeg(w, { adsT: ads ? 1 : 0, moving, airborne: false, bloom });
    bloom = Math.min(bl.max, bloom + bl.per);
    // recoil residual: the player re-centres (tc); the game settles a released trigger
    if (shots > 1 && kickV > 0) {
      const rel = !w.auto || gap > 1.5 / w.fireRate;
      const recT = recoilSettleDelay(w) + 2.5 * prof.recover;
      const rec = rel ? recFrac * Math.min(1, gap / recT) : 0;
      const pc = Math.exp(-gap / skill.tc);
      ry *= (1 - rec) * pc;
      rx *= (1 - rec) * pc;
    }
    const aimX = ex + sx + rx;
    const aimYd = ey + sy + ry;
    for (const v of variants) v.st.now = t;
    flushBurn(t);
    // a single bullet / arrow of a hero's gun is centre-weighted (deg·u); pellets uniform (deg·√u)
    const spreadSample = (pel: number): number => spread * (pel <= 1 ? rnd() : Math.sqrt(rnd()));

    if (!proj || !bal) {
      const pel = Math.max(1, w.pellets);
      let nb = 0;
      const base = w.damage * falloffMul(w, d) * pm;
      let bodyAmt = 0;
      let hsAmt = 0;
      for (let p = 0; p < pel; p++) {
        const a = spreadSample(pel);
        const th = 2 * Math.PI * rnd();
        const x = d * Math.tan((aimX + a * Math.cos(th)) * D2R);
        const y = aimY + d * Math.tan((aimYd + a * Math.sin(th)) * D2R);
        pelletsN++;
        if (sil(x, y, 0)) {
          nb++;
          bodyAmt += base;
          hsAmt += rnd() < HS_FRAC ? base * w.headshotMul : base;
        }
      }
      if (nb > 0) {
        hitsN += nb;
        for (const v of variants) record(v, t, armorApply(v.armor, w, v.hs > 0 ? hsAmt : bodyAmt, dtype, true, d, v.st));
        if (w.special === 'fireConvert') {
          if (burnUntil < t) burnNext = t + 0.5;
          burnUntil = t + (w.specialParams.burnTime ?? 3);
        }
      }
    } else if (w.special === 'multiTarget') {
      // 方天: fully aimed and within lockRange, one rocket homes on the (single) target; the rest fly straight
      const tf = bal.tf * 1.03;
      const n = Math.max(1, w.pellets);
      const lockRange = w.specialParams.lockRange ?? 40;
      for (let i = 0; i < n; i++) {
        pelletsN++;
        let direct = false;
        let splashF = 0;
        const homes = (ads || calib) && d <= lockRange && i === 0;
        if (homes) {
          direct = true;
          splashF = 1 - (0.5 * 0.11) / proj.explodeRadius;
        } else {
          const fan = n > 1 ? (i / (n - 1) - 0.5) * (w.specialParams.fanDeg ?? 8) : 0;
          const a = spreadSample(1);
          const th = 2 * Math.PI * rnd();
          const leadErr = calib ? 0 : gauss() * skill.lead * TARGET_SPEED * bal.tf;
          const x = d * Math.tan((aimX + fan + a * Math.cos(th)) * D2R) + leadErr;
          const y = aimY + d * Math.tan((aimYd + a * Math.sin(th)) * D2R);
          const k = sil(x, y, PROJ_INFLATE);
          if (k) {
            direct = true;
            splashF = 1 - (0.5 * 0.11) / proj.explodeRadius;
          } else if (y < EYE) {
            const s = (y - EYE) / d;
            const zg = d - y / s;
            const xg = (x * zg) / d;
            const dist = Math.max(0, Math.hypot(xg, CENTER_EXPLODE, zg - d) - HB.r);
            if (dist <= proj.explodeRadius) splashF = 1 - (0.5 * dist) / proj.explodeRadius;
          }
        }
        if (direct) hitsN++;
        pending.push([t + tf, direct ? w.damage : 0, splashF > 0 ? proj.explodeDamage * splashF : 0]);
      }
    } else {
      const leadErr = calib ? 0 : gauss() * skill.lead * TARGET_SPEED * bal.tf;
      const dropErr = calib ? 0 : gauss() * skill.drop * bal.drop;
      const a = spreadSample(1);
      const th = 2 * Math.PI * rnd();
      const x = d * Math.tan((aimX + a * Math.cos(th)) * D2R) + leadErr;
      const y = aimY + d * Math.tan((aimYd + a * Math.sin(th)) * D2R) + dropErr;
      pelletsN++;
      const k = sil(x, y, cls === 'bow' && !explosive ? 0.04 : PROJ_INFLATE);
      let directAmt = 0;
      let splashAmt = 0;
      const armed = d >= (w.specialParams.armDist ?? 0);
      if (k) {
        hitsN++;
        directAmt = w.damage * drawDmg;
        if (explosive && armed) {
          const r = HB.r + PROJ_INFLATE;
          const zf2 = Math.sqrt(Math.max(0, r * r - x * x));
          const dist = Math.max(0, Math.hypot(x, y - CENTER_EXPLODE, zf2) - HB.r);
          splashAmt = proj.explodeDamage * drawDmg * (1 - 0.5 * Math.min(1, dist / proj.explodeRadius));
        }
      } else if (explosive && armed) {
        const s = bal.slope;
        if (s < 0) {
          const zg = d - y / s;
          const dist = Math.max(0, Math.hypot(x, CENTER_EXPLODE, zg - d) - HB.r);
          if (dist <= proj.explodeRadius) splashAmt = proj.explodeDamage * drawDmg * (1 - (0.5 * dist) / proj.explodeRadius);
        }
      }
      if (directAmt > 0 || splashAmt > 0) pending.push([t + bal.tf, directAmt, splashAmt]);
    }

    // this shot's recoil lands on the aim of the next one
    if (kickV > 0) {
      ry += kickV * (1 - skill.comp);
      rx += kickV * hRatio * gauss() * (1 - 0.3 * skill.comp);
    }

    lastFire = t;
    inBurst++;
    let next: number;
    if (w.auto) {
      let rate = w.fireRate;
      if (w.special === 'rapid') rate *= 1 + ((w.specialParams.rampMul ?? 1.5) - 1) * Math.min(1, (t - rampStart) / (w.specialParams.rampTime ?? 1.5));
      next = t + 1 / rate;
    } else {
      // nextFireAt accumulates (sim/combat.ts heroFire): the data rate, on ticks
      if (acc < t - DT) acc = t;
      acc += 1 / w.fireRate;
      const want = Math.max(acc, t + (calib ? 0 : MIN_CLICK));
      next = t + Math.ceil((want - t) / DT - 1e-6) * DT;
    }
    const blooms = bl.per > 0;
    // tap / bursts: pause until the cone is back to the first shot's
    const recover = bloomIdle(w) + bloom / bl.decay + 0.02;
    if (blooms && strat === 'tap') next = Math.max(next, t + recover);
    if (blooms && strat === 'burst3' && inBurst >= 3) {
      next = Math.max(next, t + recover);
      inBurst = 0;
    }
    if (blooms && strat === 'burst5' && inBurst >= 5) {
      next = Math.max(next, t + recover);
      inBurst = 0;
    }
    resolveUpTo(Math.min(next, cap + 5));
    if (mag <= 0) resolveUpTo(t + w.reloadTime);
    t = next;
  }
  pending.sort((a, b) => a[0] - b[0]);
  while (pending.length) {
    if (pending[0][0] > cap + 3) break;
    resolveEvent(pending.shift()!);
  }
  flushBurn(Math.min(burnUntil + 0.01, cap));
  return { variants, shots, hits: hitsN, pellets: pelletsN };
}

function quant(arr: readonly number[], q: number): number {
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1) + 0.5)));
  return a[i];
}

/** The fire strategies a human would try: full auto, bursts, taps (for guns that bloom). */
export function stratsFor(w: WeaponDef): Strat[] {
  const blooms = bloomRow(w).per > 0;
  const interval = w.auto ? 1 / w.fireRate : Math.max(Math.ceil(1 / w.fireRate / DT - 1e-6) * DT, MIN_CLICK);
  if (!blooms || interval >= 0.4) return ['full'];
  return w.auto ? ['full', 'burst3', 'burst5', 'tap'] : ['full', 'tap'];
}

export interface CellResult {
  id: string;
  d: number;
  mode: 'hip' | 'ads';
  strat: Strat;
  hitRate: number;
  /** median TTK (s) by `${armor}_${'body' | 'hs20'}_${300 | 400 | 500}`; Infinity = not in CAP */
  t: Record<string, number>;
}

export interface CellOpts {
  armors?: readonly ArmorId[];
  moving?: boolean;
  touch?: boolean;
  opp?: boolean;
  /** a custom skill (touch) — default SKILLS[skill] */
  skill?: Skill;
  /** give up after this many seconds (default CAP) */
  cap?: number;
}

/** One cell (weapon × range × skill × hip / ADS): the best strategy by the 400 HP / 20 % head / unarmored median. */
export function runCell(id: string, d: number, skillName: string, mode: 'hip' | 'ads', trials: number, opt: CellOpts = {}): CellResult {
  const w = WEAPON_BY_ID[id];
  const skill = opt.skill ?? SKILLS[skillName];
  const armors = opt.armors ?? ARMORS;
  let best: CellResult | null = null;
  const key = (r: CellResult): number => (r.t[`${armors[0]}_hs20_400`] ?? Infinity) + (r.t[`${armors[0]}_hs20_300`] ?? 0) * 1e-3;
  for (const strat of stratsFor(w)) {
    seed(1000 + d * 7 + strat.length);
    const T: Record<number, number[][]> = { 300: armors.flatMap(() => [[], []]), 400: armors.flatMap(() => [[], []]), 500: armors.flatMap(() => [[], []]) };
    let hits = 0;
    let pel = 0;
    for (let k = 0; k < trials; k++) {
      const r = engage(w, d, skill, mode, strat, { armors, moving: opt.moving, touch: opt.touch, opp: opt.opp, cap: opt.cap });
      r.variants.forEach((v, i) => {
        T[300][i].push(v.t300);
        T[400][i].push(v.t400);
        T[500][i].push(v.t500);
      });
      hits += r.hits;
      pel += r.pellets;
    }
    const med = (a: number[]): number => {
      const m = quant(a, 0.5);
      return m > (opt.cap ?? CAP) ? Infinity : m;
    };
    const out: CellResult = { id, d, mode, strat, hitRate: pel > 0 ? hits / pel : 0, t: {} };
    armors.forEach((armor, ai) => {
      [0, 1].forEach((h) => {
        const i = ai * 2 + h;
        for (const hp of [300, 400, 500]) out.t[`${armor}_${h ? 'hs20' : 'body'}_${hp}`] = med(T[hp][i]);
      });
    });
    if (!best || key(out) < key(best)) best = out;
  }
  return best!;
}

/** The better of hip and ADS for a cell (the band's number): TTK vs `hp`, 20 % head, `armor` (all armors: `cells`). */
export function bestTtk(id: string, d: number, skillName: string, trials: number, opt: CellOpts & { armor?: ArmorId; hp?: 300 | 400 | 500 } = {}): { t: number; mode: 'hip' | 'ads'; cell: CellResult } {
  const armor = opt.armor ?? 'none';
  const k = `${armor}_hs20_${opt.hp ?? 400}`;
  const o = { ...opt, armors: opt.armors ?? ([armor] as ArmorId[]) };
  const h = runCell(id, d, skillName, 'hip', trials, o);
  const a = runCell(id, d, skillName, 'ads', trials, o);
  return a.t[k] <= h.t[k] ? { t: a.t[k], mode: 'ads', cell: a } : { t: h.t[k], mode: 'hip', cell: h };
}

/** Touch + aim assist: the better of hip / ADS with each mode's own assist (spec C9). */
export function touchTtk(id: string, d: number, trials: number): number {
  const h = runCell(id, d, 'mid', 'hip', trials, { armors: ['none'], touch: true, skill: touchSkill(d, 'hip') });
  const a = runCell(id, d, 'mid', 'ads', trials, { armors: ['none'], touch: true, skill: touchSkill(d, 'ads') });
  return Math.min(h.t.none_hs20_400, a.t.none_hs20_400);
}

/** Perfect aim at a rooted target's chest: seconds from the first shot until `hp` (the model's version of D2). */
export function calibTtk(id: string, d: number, mode: 'hip' | 'ads', hp = 400): number {
  const w = WEAPON_BY_ID[id];
  const ts: number[] = [];
  seed(99 + d);
  for (let i = 0; i < 40; i++) {
    const r = engage(w, d, SKILLS.good, mode, 'full', { calib: true, armors: ['none'], hpX: hp });
    ts.push(r.variants[0].tX ?? Infinity);
  }
  const m = quant(ts, 0.5);
  return m > CAP ? Infinity : m;
}

/** Every player weapon (lootable + signatures), the model's rows. */
export const MODEL_WEAPONS = WEAPONS.filter((w) => !w.melee && !w.id.startsWith('troop_') && !w.id.startsWith('npc_') && w.id !== 'turret_smg').map((w) => w.id);
