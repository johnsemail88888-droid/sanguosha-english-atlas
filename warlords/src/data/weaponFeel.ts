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
  ...extra,
});

/**
 * Per class. Aim times: pistol quickest, LMG slowest; scopes need a moment to settle.
 * Recoil (degrees per shot at the class's typical data recoil): pistol ≈ 0.9 (snappy, one
 * shot at a time), SMG ≈ 0.18 but ± 0.14 sideways (it dances), rifle ≈ 0.3 (a steady
 * climb), LMG ≈ 0.28 (× 0.6 once braced on the sights), DMR ≈ 1.1, sniper ≈ 3 (the scope
 * jumps and settles), shotgun ≈ 2.2, launcher ≈ 2.
 */
export const AIM_PROFILES: Readonly<Record<WeaponClass, AimProfile>> = {
  pistol: P('iron', 0.11, 'cross', { kick: 0.75, kickYaw: 0.1, kickAds: 0.85, recover: 0.12 }),
  smg: P('reddot', 0.14, 'cross', { kick: 0.3, kickYaw: 0.23, kickAds: 0.75, recover: 0.12 }),
  rifle: P('holo', 0.19, 'cross', { sway: 0.03, kick: 0.36, kickYaw: 0.07, kickAds: 0.75, recover: 0.15 }),
  dmr: P('marksman', 0.24, 'cross', { overlay: true, sway: 0.1, holdBreath: true, kick: 0.5, kickYaw: 0.06, kickAds: 1, recover: 0.15 }),
  sniper: P('scope', 0.3, 'dot', { overlay: true, sway: 0.26, holdBreath: true, zoomSteps: [1, 2], kick: 0.5, kickYaw: 0.04, kickAds: 1, recover: 0.17 }),
  lmg: P('reflex', 0.34, 'cross', { sway: 0.13, kick: 0.4, kickYaw: 0.12, kickAds: 0.6, recover: 0.16 }),
  shotgun: P('ring', 0.15, 'circle', { kick: 0.63, kickYaw: 0.1, kickAds: 0.9, recover: 0.2 }),
  bow: P('bow', 0.36, 'bow', { sway: 0.04, fatigueAfter: 2.5, kick: 0.4, kickYaw: 0.05, kickAds: 1, recover: 0.2 }),
  crossbow: P('iron', 0.18, 'bow', { kick: 0.5, kickYaw: 0.08, kickAds: 0.85, recover: 0.15 }),
  launcher: P('launcher', 0.26, 'launcher', { sway: 0.05, kick: 0.5, kickYaw: 0.08, kickAds: 1, recover: 0.25 }),
  flamer: P('none', 0.12, 'flame', { kick: 0.2, kickYaw: 0.1, kickAds: 1, recover: 0.1 }),
  melee: P('none', 0.1, 'melee', { kick: 0, kickYaw: 0 }),
};

/**
 * Weapons that aim unlike their class. 黄忠's 烈弓 is a 复合狙击弓 built for 远程狙击:
 * it looks through a real scope (2.5× / 5×, the wheel switches) with the draw ring
 * inside the lens, sways less than a rifle scope and Shift holds the breath.
 */
export const AIM_BY_WEAPON: Readonly<Record<string, Partial<AimProfile>>> = {
  liegong: { sight: 'scope', overlay: true, holdBreath: true, sway: 0.16, zoomSteps: [1, 2] },
};

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
 * Look sensitivity multiplier while aiming: the ADS setting as it is up to a
 * 1.5× sight, then scaled with the view (tan of the half FOV), so a 4× / 8×
 * scope turns the reticle across the same share of the picture per mouse
 * inch as a red dot does.
 */
export function adsSensitivityMul(zoom: number, baseFov: number, adsSetting: number): number {
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
  // (full damage out to here, then down to 50 % at the maximum range — the help table shows both)
  range: { zh: '有效射程', en: 'Eff. range' },
  mag: { zh: '弹匣', en: 'Magazine' },
  accuracy: { zh: '精准', en: 'Accuracy' },
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const round1 = (v: number): string => (Math.round(v * 10) / 10).toString();

/**
 * Accuracy 0..1: the aimed cone alone (0° = 1, 3° or wider = 0) — a sniper ranks
 * first even though it is wild from the hip; the hip cone is on the aim line
 * (aimSummary: 腰射 ±6°).
 */
export function accuracyScore(def: WeaponDef): number {
  return clamp01(1 - clamp01(def.spreadAds / 3));
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

/**
 * The weapon slot a picked-up weapon lands in (sim/inventory.ts pickUp): pistols beside a primary
 * go to slot 2 — except a primaryOnly pistol (雌雄 akimbo), which replaces the primary.
 */
export function pickupSlot(def: WeaponDef, primaryId: string | null | undefined): number {
  return def.class === 'pistol' && !def.primaryOnly && primaryId && primaryId !== def.id ? 1 : 0;
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
