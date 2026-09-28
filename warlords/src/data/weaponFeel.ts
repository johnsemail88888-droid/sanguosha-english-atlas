// How each weapon class aims and feels (shared by sim, render, input and HUD;
// no three.js, no DOM). Guns of different classes must not aim alike: a pistol
// raises its iron sights almost at once, a rifle looks through a holo sight, an
// LMG is slow and heavy to shoulder, a marksman rifle and a sniper look through
// a real scope (lens overlay, the weapon itself hidden) with a breathing sway
// that Shift steadies for a few seconds, a bow is drawn and held. A few named
// weapons aim unlike their class (黄忠's 烈弓 is a scoped sniper bow):
// AIM_BY_WEAPON. Every class kicks differently too (recoil: the view climbs
// with each shot and settles back once the trigger rests — game/aimFeel.ts).
//
// The simulation uses adsTime + spreadDeg (sim/combat.ts currentSpread): spread
// eases from hip to aimed over the class's ADS time, so a sniper cannot shoot
// with its zero aimed spread the instant the right button goes down. Everything
// else here (sight kind, zoom steps, sway, hold breath) is the local player's
// view and aim (game/aimFeel.ts, render, HUD).
import type { WeaponClass, WeaponDef } from './types';
import { weaponShotDamage } from './weapons';

/** What you look through while aiming. */
export type SightKind =
  | 'iron' // notch + post, a tiny centre dot (pistols, crossbows)
  | 'reddot' // reflex sight: a glowing dot in a thin glass (SMGs)
  | 'holo' // holographic ring + dot (rifles)
  | 'reflex' // wide reflex window, a green chevron over a range bar (LMGs)
  | 'marksman' // low-power near sight: a round window, amber chevron + ranging stadia; the weapon stays in view (DMRs)
  | 'scope' // sniper scope: black overlay, mil-dot reticle, 2 zoom steps (snipers)
  | 'bow' // drawn to the cheek: a draw ring that fills (bows)
  | 'ring' // the pellet cone as a ring (shotguns)
  | 'launcher' // range ladder for lobbed rounds
  | 'none';

/** Hip-fire crosshair look (the HUD's data-style). */
export type CrosshairStyle = 'cross' | 'circle' | 'dot' | 'launcher' | 'bow' | 'flame' | 'melee';

export interface AimProfile {
  sight: SightKind;
  /** seconds from hip to fully aimed (sim spread, camera zoom, viewmodel) */
  adsTime: number;
  /** a lens overlay fills the screen once aimed (the viewmodel is hidden) */
  overlay: boolean;
  /** breathing sway half-amplitude while aimed and still (degrees) */
  sway: number;
  /** Shift holds the breath (sway almost gone for HOLD_BREATH_MAX s) */
  holdBreath: boolean;
  /** bows: held at full draw longer than this the arm starts to shake (s) */
  fatigueAfter: number;
  crosshair: CrosshairStyle;
  /** zoom steps while aiming, as multiples of the weapon's data zoom (scopes: [1, 2] — the wheel switches) */
  zoomSteps: readonly number[];
  /**
   * Recoil: degrees the view climbs per shot per unit of the weapon's data
   * `recoil` (so 吕布's heavy rifle kicks harder than the carbine, 吕蒙's
   * suppressed DMR less than 青釭). The shots follow the view.
   */
  kick: number;
  /** sideways kick per shot: ± degrees per unit of data recoil (random each shot) */
  kickYaw: number;
  /** the kick once fully aimed, as a fraction of the hip kick (a braced LMG steadies most) */
  kickAds: number;
  /** seconds (time constant) the view takes to settle back once the trigger rests */
  recover: number;
  /**
   * Share of the climb still outstanding that the settle returns (1: all the way
   * back; an LMG's 0.7 leaves 30 % of a long burst for you to pull down). What
   * you pulled down yourself is not returned twice (game/aimFeel.ts absorbPitch).
   */
  recoverFrac: number;
  /** Kick multiplier by shot of a held burst: shots 1…`shots` × `first`, then × `after` (the LMG's jumpy start) */
  kickCurve?: { shots: number; first: number; after: number };
  /** Walk-speed multiplier while aimed (sim/physics.ts MoveMods.adsMul; the old ADS_MUL was 0.6 for all) */
  adsMove: number;
  /** Seconds out of a sprint before the weapon fires (and aims): the raise out of a run */
  sprintOut: number;
  /** Sway half-amplitude (degrees) per zoom step when it differs from `sway` (the sniper: 0.22 at 4×, 0.26 at 8×) */
  swaySteps?: readonly number[];
}

const P = (sight: SightKind, adsTime: number, crosshair: CrosshairStyle, extra: Partial<AimProfile> = {}): AimProfile => ({
  sight,
  adsTime,
  overlay: false,
  sway: 0,
  holdBreath: false,
  fatigueAfter: 0,
  crosshair,
  zoomSteps: [1],
  kick: 0.3,
  kickYaw: 0.08,
  kickAds: 0.8,
  recover: 0.14,
  recoverFrac: 1,
  adsMove: 0.6,
  sprintOut: 0.15,
  ...extra,
});

/**
 * Per class (weapons spec C1). Aim times: pistol = flamer (0.12) < SMG (0.15) < shotgun (0.18)
 * < crossbow (0.20) < rifle (0.22) < DMR (0.28) < launcher (0.30) < sniper = LMG (0.40) < bow
 * (0.45, the draw). Recoil (degrees per shot at the class's typical data recoil): pistol ≈ 0.6
 * (snappy, one shot at a time), SMG ≈ 0.15 but ± 0.14 sideways (it dances), rifle ≈ 0.25 (a
 * steady climb), LMG 0.31 for the first 8 shots then 0.12 (braced), DMR ≈ 1, sniper 3 (the scope
 * jumps and settles), shotgun ≈ 2.2, launcher ≈ 1.6; autos settle back 80–90 % of the climb, the
 * LMG 70 %. The DMR is a near sight (no lens overlay: the gun stays in view, no scope glint).
 */
export const AIM_PROFILES: Readonly<Record<WeaponClass, AimProfile>> = {
  pistol: P('iron', 0.12, 'cross', { kick: 0.75, kickYaw: 0.1, kickAds: 0.85, recover: 0.12, recoverFrac: 0.9, adsMove: 0.75, sprintOut: 0.1 }),
  smg: P('reddot', 0.15, 'cross', { kick: 0.3, kickYaw: 0.23, kickAds: 0.75, recover: 0.12, recoverFrac: 0.85, adsMove: 0.72, sprintOut: 0.12 }),
  rifle: P('holo', 0.22, 'cross', { sway: 0.03, kick: 0.36, kickYaw: 0.07, kickAds: 0.75, recover: 0.15, recoverFrac: 0.8, adsMove: 0.6, sprintOut: 0.18 }),
  dmr: P('marksman', 0.28, 'cross', { sway: 0.1, holdBreath: true, kick: 0.5, kickYaw: 0.06, kickAds: 1, recover: 0.15, recoverFrac: 0.95, adsMove: 0.52, sprintOut: 0.22 }),
  sniper: P('scope', 0.4, 'dot', { overlay: true, sway: 0.22, swaySteps: [0.22, 0.26], holdBreath: true, zoomSteps: [1, 2], kick: 0.5, kickYaw: 0.04, kickAds: 1, recover: 0.17, adsMove: 0.42, sprintOut: 0.3 }),
  lmg: P('reflex', 0.4, 'cross', { sway: 0.13, kick: 0.4, kickYaw: 0.12, kickAds: 0.6, recover: 0.16, recoverFrac: 0.7, kickCurve: { shots: 8, first: 1.5, after: 0.6 }, adsMove: 0.45, sprintOut: 0.28 }),
  shotgun: P('ring', 0.18, 'circle', { kick: 0.63, kickYaw: 0.1, kickAds: 0.9, recover: 0.2, adsMove: 0.68, sprintOut: 0.15 }),
  bow: P('bow', 0.45, 'bow', { sway: 0.04, fatigueAfter: 2.5, kick: 0.4, kickYaw: 0.05, kickAds: 1, recover: 0.2, adsMove: 0.55, sprintOut: 0.2 }),
  crossbow: P('iron', 0.2, 'bow', { kick: 0.5, kickYaw: 0.08, kickAds: 0.85, recover: 0.15, recoverFrac: 0.95, adsMove: 0.6, sprintOut: 0.18 }),
  launcher: P('launcher', 0.3, 'launcher', { sway: 0.05, kick: 0.5, kickYaw: 0.08, kickAds: 1, recover: 0.25, adsMove: 0.5, sprintOut: 0.25 }),
  flamer: P('none', 0.12, 'flame', { kick: 0.2, kickYaw: 0.1, kickAds: 1, recover: 0.1, adsMove: 0.7, sprintOut: 0.12 }),
  melee: P('none', 0.1, 'melee', { kick: 0, kickYaw: 0, sprintOut: 0 }),
};

/**
 * Weapons that aim unlike their class. 黄忠's 烈弓 is a 复合狙击弓 built for 远程狙击:
 * it looks through a real scope (2.5× / 5×, the wheel switches) with the draw ring
 * inside the lens, sways less than a rifle scope and Shift holds the breath.
 * 刘备 / 貂蝉's 雌雄双股剑 (a pair of automatic pistols, primary only) handles like an
 * SMG — its raise, its dancing kick, its aimed walk and sprint-out — but keeps the
 * pistols' iron sights.
 */
export const AIM_BY_WEAPON: Readonly<Record<string, Partial<AimProfile>>> = {
  liegong: { sight: 'scope', overlay: true, holdBreath: true, sway: 0.16, zoomSteps: [1, 2] },
  cixiong: { adsTime: 0.15, kick: 0.3, kickYaw: 0.23, kickAds: 0.75, recover: 0.12, recoverFrac: 0.85, adsMove: 0.72, sprintOut: 0.12 },
};

/** Sway half-amplitude (degrees) of this profile at zoom step `step` (0 = the first). */
export function swayAt(p: AimProfile, step: number): number {
  const s = p.swaySteps;
  return s && s.length ? s[Math.max(0, Math.min(s.length - 1, step))]! : p.sway;
}

/** Kick multiplier of the `n`-th shot (1-based) of a held burst (AimProfile.kickCurve). */
export function kickCurveMul(p: AimProfile, n: number): number {
  const c = p.kickCurve;
  if (!c) return 1;
  return n <= c.shots ? c.first : c.after;
}

/** Aim progress from which the sights count as fully up: a little under 1 absorbs 30 Hz host / client jitter. */
export const AIMED_AT = 0.92;

const MERGED = new Map<string, AimProfile>();

export function aimProfile(def: WeaponDef | undefined): AimProfile {
  const base = AIM_PROFILES[def?.class ?? 'rifle'] ?? AIM_PROFILES.rifle;
  const over = def ? AIM_BY_WEAPON[def.id] : undefined;
  if (!over || !def) return base;
  let m = MERGED.get(def.id);
  if (!m) MERGED.set(def.id, (m = { ...base, ...over }));
  return m;
}

/** A drawn bow through a scope (烈弓): the draw ring shows inside the lens. */
export function isScopedBow(def: WeaponDef | undefined): boolean {
  return !!def && def.class === 'bow' && aimProfile(def).overlay;
}

/** Recoil of one shot (degrees): the view's climb and the ± sideways range, at aim blend `blend` (0 hip … 1 aimed). */
export function shotKick(def: WeaponDef, blend: number): { pitch: number; yaw: number } {
  const p = aimProfile(def);
  const b = blend <= 0 ? 0 : blend >= 1 ? 1 : blend;
  const r = Math.max(0, def.recoil) * (1 + (p.kickAds - 1) * b);
  return { pitch: p.kick * r, yaw: p.kickYaw * r };
}

/**
 * Seconds after a shot before the view starts settling back: a little more than
 * the gap between shots, so a held trigger keeps climbing (you pull down against
 * it), but never long — a sniper's scope settles between its slow shots.
 */
export function recoilSettleDelay(def: WeaponDef): number {
  return Math.min(1 / Math.max(0.1, def.fireRate) + 0.04, 0.24);
}

/** The view never climbs further than this from recoil (degrees). */
export const RECOIL_MAX_DEG = 9;

/** Bows: damage of a hip (undrawn) shot as a fraction of a full draw — the draw ring filling is the damage. */
export const BOW_HIP_DAMAGE = 0.65;

/** Damage multiplier of a bow shot at aim progress `adsT` (1 at full draw; other classes 1). */
export function drawDamageMul(def: WeaponDef, adsT: number): number {
  if (def.class !== 'bow') return 1;
  return BOW_HIP_DAMAGE + (1 - BOW_HIP_DAMAGE) * adsEase(adsT);
}

/** Seconds of held breath (Shift while scoped) before you must breathe out. */
export const HOLD_BREATH_MAX = 4;
/** After running out of breath: seconds of heavier sway before it settles. */
export const BREATH_RECOVER = 1.6;

/**
 * Zoom steps while aiming (FOV divisors, first = default). Scopes have two
 * (the wheel switches them while scoped): the data zoom and twice it.
 */
export function adsZooms(def: WeaponDef | undefined): readonly number[] {
  if (!def) return [1];
  const z = Math.max(1, def.adsZoom);
  return aimProfile(def).zoomSteps.map((m) => z * m);
}

/** Smoothstep: the ease every aim transition uses (sim spread and camera alike). */
export function adsEase(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** One step of the aim progress (0 hip … 1 aimed): in over adsTime, out in 60 % of it. */
export function stepAdsT(t: number, aiming: boolean, adsTime: number, dt: number): number {
  const at = Math.max(0.01, adsTime);
  if (aiming) return Math.min(1, t + dt / at);
  return Math.max(0, t - dt / (at * 0.6));
}

// ── spread (the sim's own formula; the HUD crosshair draws the same number) ──

/** spread bloom per consecutive shot and its cap (fractions of the base spread) */
export const BLOOM_PER_SHOT = 0.07;
export const BLOOM_MAX = 0.5;

export interface SpreadState {
  /** aim progress 0 (hip) … 1 (aimed) */
  adsT: number;
  /** moving faster than a shuffle */
  moving: boolean;
  airborne: boolean;
  /** consecutive shots */
  burst: number;
}

/**
 * Degrees added to the aimed cone while moving: a scope is only steady standing
 * still (a sniper that strafes misses), a rifle's sights barely care.
 */
export const MOVE_AIMED: Readonly<Partial<Record<WeaponClass, number>>> = { sniper: 2.5, dmr: 1.2, bow: 1 };
const MOVE_AIMED_OTHER = 0.4;
/** Mid-air nothing is accurate: the cone is at least this wide (degrees). */
export const AIRBORNE_MIN_SPREAD = 4;

/**
 * Spread cone (degrees, half-angle) for this state: hip → aimed eased over the
 * aim time; moving widens hip fire by 35 % and adds MOVE_AIMED's degrees to the
 * aimed cone; airborne ×1.8 and never under AIRBORNE_MIN_SPREAD (a scoped
 * sniper is not a laser mid-jump); +7 % per shot while the trigger stays busy,
 * capped at +50 % (ramping guns and flame streams don't bloom).
 */
export function spreadDeg(def: WeaponDef, s: SpreadState): number {
  const a = adsEase(s.adsT);
  let spread = def.spreadHip + (def.spreadAds - def.spreadHip) * a;
  if (s.moving) {
    spread *= 1 + 0.35 * (1 - a);
    if (!def.melee) spread += (MOVE_AIMED[def.class] ?? MOVE_AIMED_OTHER) * a;
  }
  if (s.airborne && !def.melee) spread = Math.max(spread * 1.8, AIRBORNE_MIN_SPREAD);
  if (def.special !== 'rapid' && def.class !== 'flamer') spread *= 1 + Math.min(BLOOM_MAX, Math.max(0, s.burst) * BLOOM_PER_SHOT);
  return Math.max(0, spread);
}

// ── mouse sensitivity scaled by zoom ─────────────────────────────────────────

/** Vertical FOV (degrees) at a zoom factor (as the camera rig applies it). */
export function zoomedFov(baseFov: number, zoom: number): number {
  return Math.min(110, Math.max(8, baseFov / Math.max(1, zoom)));
}

const tanHalf = (fovDeg: number): number => Math.tan((fovDeg * Math.PI) / 360);

/**
 * Look sensitivity multiplier at a zoom (weapons spec C2): `rel` (the relative
 * ADS setting, 1 = matched) × the change of the view, so every sight — a 1.25×
 * dot as much as an 8× scope — turns the reticle across the same share of the
 * picture per mouse inch as the hip view does. `coef` 0 matches at the
 * crosshair (tan of the half FOVs); a monitor-distance coefficient (1.33: the
 * edge of a 4:3 box) matches that far out instead (atan form). At vertical FOV
 * 75 and coef 0: 1.25× 0.752, 1.5× 0.608, 2.5× 0.349, 4× 0.215, 8× 0.107.
 */
export function adsSensitivityMul(zoom: number, baseFov: number, rel: number, coef = 0): number {
  const t1 = tanHalf(zoomedFov(baseFov, 1));
  const tz = tanHalf(zoomedFov(baseFov, zoom));
  const ratio = coef > 0 ? Math.atan(coef * tz) / Math.atan(coef * t1) : tz / t1;
  return rel * ratio;
}

// ── holdover (drop) for lobbed rounds and arrows ────────────────────────────

/**
 * Angle (radians) above the line of sight a round of speed `v` (m/s) under
 * gravity `g` (m/s²) must leave at to come down on a point `d` metres away on
 * the level: the flat solution of tan θ = (v² − √(v⁴ − g²d²)) / (g·d). NaN when
 * the round cannot reach that far.
 */
export function ballisticHold(v: number, g: number, d: number): number {
  if (!(d > 0) || !(g > 0)) return 0;
  const v2 = v * v;
  const disc = v2 * v2 - g * g * d * d;
  if (!(v > 0) || disc < 0) return Number.NaN;
  return Math.atan((v2 - Math.sqrt(disc)) / (g * d));
}

/** Screen pixels below the crosshair of an angle `theta` (radians) at a zoom (screen height `h` px, vertical FOV `fov`). */
export function holdPx(theta: number, fov: number, zoom: number, h: number): number {
  return (Math.tan(theta) / tanHalf(zoomedFov(fov, zoom))) * (h / 2);
}

/** Pixels per milliradian at a zoom (the sniper reticle's mil-dots: 3.27 at 4×, 6.59 at 8× on 1080p, FOV 75). */
export function pxPerMil(fov: number, zoom: number, h: number): number {
  return holdPx(0.001, fov, zoom, h);
}

/**
 * Brightness of another hero's scope glint by the zoom he looks through: a
 * bigger lens flashes brighter (2.5× 0.4, 4× 0.6, 5× 0.7, 8× 1.0).
 */
export function glintBrightness(zoom: number): number {
  if (zoom <= 2.5) return 0.4;
  if (zoom <= 4) return 0.4 + ((zoom - 2.5) / 1.5) * 0.2;
  if (zoom <= 5) return 0.6 + (zoom - 4) * 0.1;
  return Math.min(1, 0.7 + ((zoom - 5) / 3) * 0.3);
}

// ── scope sway (breathing figure-eight) ─────────────────────────────────────

/** Yaw rate of the sway's figure-eight (rad/s); the pitch runs at twice it. */
export const SWAY_YAW_RATE = 1.6;

/**
 * Sway offset (radians) at time `t` for a half-amplitude of `ampDeg` degrees:
 * a figure-eight (breathing: yaw at SWAY_YAW_RATE, pitch twice as fast, one
 * loop in about 3.9 s) with a faint faster tremor.
 */
export function swayOffset(t: number, ampDeg: number): { yaw: number; pitch: number } {
  const a = (ampDeg * Math.PI) / 180;
  if (a <= 0) return { yaw: 0, pitch: 0 };
  return {
    yaw: a * (Math.sin(t * SWAY_YAW_RATE) * 0.85 + Math.sin(t * 5.1 + 1.3) * 0.15),
    pitch: a * (Math.sin(t * SWAY_YAW_RATE * 2 + 0.6) * 0.5 + Math.sin(t * 6.7) * 0.1),
  };
}

// ── weapon identity: stat bars ───────────────────────────────────────────────

export interface WeaponStat {
  key: 'damage' | 'rate' | 'range' | 'mag' | 'accuracy' | 'handling';
  /** 0..1 bar */
  bar: number;
  /** short value text (language-neutral) */
  value: string;
  /** raw number for comparisons (bigger is better) */
  raw: number;
}

export const STAT_LABEL: Readonly<Record<WeaponStat['key'], { zh: string; en: string }>> = {
  damage: { zh: '伤害', en: 'Damage' },
  rate: { zh: '射速', en: 'Fire rate' },
  // (full damage out to here, then down to 50 % at the maximum range — the help table shows both)
  range: { zh: '有效射程', en: 'Eff. range' },
  mag: { zh: '弹匣', en: 'Magazine' },
  accuracy: { zh: '精准', en: 'Accuracy' },
  // how quickly it comes up and moves while aimed (ADS time, aimed walk, sprint-out)
  handling: { zh: '操控', en: 'Handling' },
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const round1 = (v: number): string => (Math.round(v * 10) / 10).toString();
const fmtS = (v: number): string => (Math.round(v * 100) / 100).toString();

/**
 * Accuracy 0..1: the aimed cone alone (0° = 1, 3° or wider = 0) — a sniper ranks
 * first even though it is wild from the hip; the hip cone is on the aim line
 * (aimSummary: 腰射 ±6°).
 */
export function accuracyScore(def: WeaponDef): number {
  return clamp01(1 - clamp01(def.spreadAds / 3));
}

/**
 * Handling 0..1 (操控): half the aim time (0.12 s = 1 … 0.45 s = 0), 30 % the walk
 * while aimed (0.75 = 1 … 0.42 = 0), 20 % the sprint-out (0.10 s = 1 … 0.30 s = 0):
 * a pistol tops it, a sniper and a bow sit at the bottom.
 */
export function handlingScore(def: WeaponDef): number {
  const p = aimProfile(def);
  const ads = clamp01((0.45 - p.adsTime) / (0.45 - 0.12));
  const move = clamp01((p.adsMove - 0.42) / (0.75 - 0.42));
  const out = clamp01((0.3 - p.sprintOut) / (0.3 - 0.1));
  return clamp01(0.5 * ads + 0.3 * move + 0.2 * out);
}

/** The six bars of a weapon's stat card (伤害 / 射速 / 射程 / 弹匣 / 精准 / 操控). */
export function weaponStats(def: WeaponDef): WeaponStat[] {
  const shot = weaponShotDamage(def);
  const dmgText = def.pellets > 1 ? `${def.damage}×${def.pellets}` : String(Math.round(shot));
  const melee = !!def.melee;
  const range = melee ? def.melee!.range : def.falloffStart;
  return [
    { key: 'damage', bar: clamp01(Math.sqrt(shot / 150)), value: dmgText, raw: shot },
    { key: 'rate', bar: clamp01(0.06 + (0.94 * def.fireRate) / 15), value: `${round1(def.fireRate)}/s`, raw: def.fireRate },
    { key: 'range', bar: clamp01(Math.log(Math.max(1, range) / 5) / Math.log(30)), value: `${Math.round(range)} m`, raw: range },
    { key: 'mag', bar: melee ? 1 : clamp01(Math.log(1 + def.magSize) / Math.log(101)), value: melee ? '∞' : String(def.magSize), raw: melee ? 999 : def.magSize },
    { key: 'accuracy', bar: accuracyScore(def), value: String(Math.round(accuracyScore(def) * 100)), raw: accuracyScore(def) },
    // (the value: the aim time, the part of handling you feel first)
    { key: 'handling', bar: melee ? 1 : handlingScore(def), value: melee ? '—' : `${fmtS(aimProfile(def).adsTime)}s`, raw: melee ? 1 : handlingScore(def) },
  ];
}

/** The weapon slot a picked-up weapon lands in (sim/inventory.ts pickUp): pistols beside a primary go to slot 2. */
export function pickupSlot(def: WeaponDef, primaryId: string | null | undefined): number {
  return def.class === 'pistol' && primaryId && primaryId !== def.id ? 1 : 0;
}

/** The sight named for the stat card / help. */
export const SIGHT_LABEL: Readonly<Record<SightKind, { zh: string; en: string }>> = {
  iron: { zh: '机械瞄具', en: 'Iron sights' },
  reddot: { zh: '红点', en: 'Red dot' },
  holo: { zh: '全息', en: 'Holo sight' },
  reflex: { zh: '宽框反射镜', en: 'Wide reflex' },
  marksman: { zh: '射手镜', en: 'Marksman scope' },
  scope: { zh: '狙击镜', en: 'Sniper scope' },
  bow: { zh: '拉弓瞄准', en: 'Drawn bow' },
  ring: { zh: '散布环', en: 'Spread ring' },
  launcher: { zh: '抛射标尺', en: 'Range ladder' },
  none: { zh: '无', en: 'None' },
};

/** "1.5×" / "4× / 8×" */
export function zoomLabel(def: WeaponDef): string {
  return adsZooms(def)
    .map((z) => `${Math.round(z * 10) / 10}×`)
    .join(' / ');
}

const fmt = (v: number): string => (Math.round(v * 100) / 100).toString();

/**
 * How this weapon aims, in both languages (stat card, pickup comparison, hero
 * detail, help): "狙击镜 4× / 8× · 开镜 0.3 秒 · 腰射 ±6° · Shift 屏息". No sight
 * name for weapons without one (the flamer), no zoom under 1.05×.
 */
export function aimSummary(def: WeaponDef): { zh: string; en: string } {
  const p = aimProfile(def);
  const sight = p.sight === 'none' ? null : SIGHT_LABEL[p.sight];
  const zoom = sight && def.adsZoom > 1.05 ? zoomLabel(def) : '';
  const head = (lang: 'zh' | 'en'): string => [sight?.[lang] ?? '', zoom].filter(Boolean).join(' ');
  const secs = fmt(p.adsTime);
  const hip = `±${Math.round(def.spreadHip * 10) / 10}°`;
  const zh: string[] = [];
  const en: string[] = [];
  if (head('zh')) zh.push(head('zh'));
  if (head('en')) en.push(head('en'));
  zh.push(`开镜 ${secs} 秒`, `腰射 ${hip}`);
  en.push(`aim ${secs} s`, `hip ${hip}`);
  if (p.holdBreath) {
    zh.push('Shift 屏息');
    en.push('Shift: hold breath');
  }
  if (def.class === 'bow') {
    zh.push(`满弦伤害（腰射 ×${BOW_HIP_DAMAGE}）`);
    en.push(`full draw = full damage (hip ×${BOW_HIP_DAMAGE})`);
  }
  return { zh: zh.join(' · '), en: en.join(' · ') };
}
