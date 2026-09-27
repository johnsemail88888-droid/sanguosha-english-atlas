// How each weapon class aims and feels (shared by sim, render, input and HUD;
// no three.js, no DOM). Guns of different classes must not aim alike: a pistol
// raises its iron sights almost at once, a rifle looks through a holo sight, an
// LMG is slow and heavy to shoulder, a marksman rifle and a sniper look through
// a real scope (lens overlay, the weapon itself hidden) with a breathing sway
// that Shift steadies for a few seconds, a bow is drawn and held.
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
  | 'reddot' // reflex sight: a glowing dot in a thin glass (SMGs, LMGs)
  | 'holo' // holographic ring + dot (rifles)
  | 'marksman' // low-power scope: lens overlay, amber chevron + drop ticks (DMRs)
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
}

const P = (sight: SightKind, adsTime: number, crosshair: CrosshairStyle, extra: Partial<AimProfile> = {}): AimProfile => ({
  sight,
  adsTime,
  overlay: false,
  sway: 0,
  holdBreath: false,
  fatigueAfter: 0,
  crosshair,
  ...extra,
});

/** Per class. Aim times: pistol quickest, LMG slowest; scopes need a moment to settle. */
export const AIM_PROFILES: Readonly<Record<WeaponClass, AimProfile>> = {
  pistol: P('iron', 0.11, 'cross'),
  smg: P('reddot', 0.14, 'cross'),
  rifle: P('holo', 0.19, 'cross', { sway: 0.03 }),
  dmr: P('marksman', 0.24, 'cross', { overlay: true, sway: 0.1, holdBreath: true }),
  sniper: P('scope', 0.3, 'dot', { overlay: true, sway: 0.26, holdBreath: true }),
  lmg: P('reddot', 0.34, 'cross', { sway: 0.13 }),
  shotgun: P('ring', 0.15, 'circle'),
  bow: P('bow', 0.36, 'bow', { sway: 0.04, fatigueAfter: 2.5 }),
  crossbow: P('iron', 0.18, 'bow'),
  launcher: P('launcher', 0.26, 'launcher', { sway: 0.05 }),
  flamer: P('none', 0.12, 'flame'),
  melee: P('none', 0.1, 'melee'),
};

export function aimProfile(def: WeaponDef | undefined): AimProfile {
  return AIM_PROFILES[def?.class ?? 'rifle'] ?? AIM_PROFILES.rifle;
}

/** Seconds of held breath (Shift while scoped) before you must breathe out. */
export const HOLD_BREATH_MAX = 4;
/** After running out of breath: seconds of heavier sway before it settles. */
export const BREATH_RECOVER = 1.6;

/**
 * Zoom steps while aiming (FOV divisors, first = default). Sniper scopes have
 * two (the wheel switches them while scoped): the data zoom and twice it.
 */
export function adsZooms(def: WeaponDef | undefined): readonly number[] {
  if (!def) return [1];
  const z = Math.max(1, def.adsZoom);
  return def.class === 'sniper' ? [z, z * 2] : [z];
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
 * Spread cone (degrees, half-angle) for this state: hip → aimed eased over the
 * aim time; moving widens hip fire by 35 % (none once aimed); airborne ×1.8;
 * +7 % per shot while the trigger stays busy, capped at +50 % (ramping guns and
 * flame streams don't bloom).
 */
export function spreadDeg(def: WeaponDef, s: SpreadState): number {
  const a = adsEase(s.adsT);
  let spread = def.spreadHip + (def.spreadAds - def.spreadHip) * a;
  if (s.moving) spread *= 1 + 0.35 * (1 - a);
  if (s.airborne) spread *= 1.8;
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
 * Look sensitivity multiplier while aiming: the ADS setting as it is up to a
 * 1.5× sight, then scaled with the view (tan of the half FOV), so a 4× / 8×
 * scope turns the reticle across the same share of the picture per mouse
 * inch as a red dot does.
 */
export function adsSensitivityMul(zoom: number, baseFov: number, adsSetting: number): number {
  if (zoom <= 1.001) return 1;
  const ref = tanHalf(zoomedFov(baseFov, 1.5));
  const now = tanHalf(zoomedFov(baseFov, zoom));
  return adsSetting * Math.min(1, now / ref);
}

// ── scope sway (breathing figure-eight) ─────────────────────────────────────

/**
 * Sway offset (radians) at time `t` for a half-amplitude of `ampDeg` degrees:
 * a slow figure-eight (breathing) with a faint faster tremor.
 */
export function swayOffset(t: number, ampDeg: number): { yaw: number; pitch: number } {
  const a = (ampDeg * Math.PI) / 180;
  if (a <= 0) return { yaw: 0, pitch: 0 };
  return {
    yaw: a * (Math.sin(t * 0.83) * 0.85 + Math.sin(t * 2.9 + 1.3) * 0.15),
    pitch: a * (Math.sin(t * 1.66 + 0.6) * 0.5 + Math.sin(t * 3.7) * 0.1),
  };
}

// ── weapon identity: stat bars ───────────────────────────────────────────────

export interface WeaponStat {
  key: 'damage' | 'rate' | 'range' | 'mag' | 'accuracy';
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
  range: { zh: '射程', en: 'Range' },
  mag: { zh: '弹匣', en: 'Magazine' },
  accuracy: { zh: '精准', en: 'Accuracy' },
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const round1 = (v: number): string => (Math.round(v * 10) / 10).toString();

/** Accuracy 0..1: mostly the aimed cone, a little of the hip cone. */
export function accuracyScore(def: WeaponDef): number {
  return clamp01(1 - 0.85 * clamp01(def.spreadAds / 4) - 0.15 * clamp01(def.spreadHip / 7));
}

/** The five bars of a weapon's stat card (伤害 / 射速 / 射程 / 弹匣 / 精准). */
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
