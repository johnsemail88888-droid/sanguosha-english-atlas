// Bespoke VFX for the 魏 Wei abilities (sim/abilities/wei/*). The integrator
// calls registerWeiAbilityVfx() once, after the renderer's built-in table
// (each entry replaces the generic / built-in flavour).
//
// These draw the *cast* (and the passive procs the sim emits as ability
// events: 奸雄 shield, 反馈 theft, 天妒 windfall). Follow-ups come from the sim
// as ordinary events: 独目怒冲's impact and 虎卫猛击's landing are 'melee'
// events, 遗计's landing a 'holy' explosion + 'airdropLand' sfx, 神速's volley
// 'shot' events; 鬼才's dome, 凌波微步's frost and 遗计's smoke are hazards.
//
// Until docs/SIM_REQUESTS.md WEI-3 (SHU-3) lands, ev.pos is the raw crosshair
// point (up to 60 m away), so geometry comes from the ability data instead.
import * as THREE from 'three';
import { ABILITY_BY_ID } from '../../data';
import { PT } from '../core/textures';
import { registerAbilityVfx, type AbilityVfxContext, type AbilityVfxFn } from './abilities';
import { FX_COLORS } from './effects';

const C = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);

const WEI_BLUE = C(0.55, 0.95, 2.4);
const STEEL = C(1.3, 1.45, 1.8);
const GOLD = C(2.2, 1.6, 0.5);
const BLOOD = C(2.4, 0.3, 0.2);
const VIOLET = C(1.4, 0.6, 2.4);
const WOLF = C(1.1, 0.5, 2.6);
const PLUM = C(2.4, 0.85, 1.3);
const FROST = C(0.8, 1.6, 2.4);
const EMBER = C(2.6, 1.0, 0.25);
const WHITE = C(2, 2, 2);

/** Tunable of an ability from the data (the VFX mirrors the sim's numbers). */
const P = (id: string, key: string, fallback: number): number => ABILITY_BY_ID[id]?.params[key] ?? fallback;

/** Point on the ground under p (+ lift). */
function ground(ctx: AbilityVfxContext, p: THREE.Vector3, lift = 0.08): THREE.Vector3 {
  return new THREE.Vector3(p.x, ctx.fx.groundY(p.x, p.z) + lift, p.z);
}

/** Flat, normalised aim direction. */
function flatDir(ctx: AbilityVfxContext): THREE.Vector3 {
  const d = new THREE.Vector3(ctx.dir.x, 0, ctx.dir.z);
  return d.lengthSq() > 1e-6 ? d.normalize() : new THREE.Vector3(0, 0, -1);
}

/** `dist` m ahead of the caster's chest along the flat aim. */
function ahead(ctx: AbilityVfxContext, dist: number): THREE.Vector3 | null {
  return ctx.srcPos ? ctx.srcPos.clone().addScaledVector(flatDir(ctx), dist) : null;
}

/** ev.pos when it is plausibly the real effect point (within `range` of the caster), else clamped to `range`. */
function clampedPoint(ctx: AbilityVfxContext, range: number): THREE.Vector3 | null {
  const p = ctx.point;
  const s = ctx.srcPos;
  if (!p) return s ? ahead(ctx, range) : null;
  if (!s) return p.clone();
  const dx = p.x - s.x;
  const dz = p.z - s.z;
  const d = Math.hypot(dx, dz);
  if (d <= range + 0.5 || d < 1e-3) return p.clone();
  const x = s.x + (dx / d) * range;
  const z = s.z + (dz / d) * range;
  return new THREE.Vector3(x, ctx.fx.groundY(x, z) + 1, z);
}

const yawOf = (d: THREE.Vector3): number => Math.atan2(-d.x, -d.z);

// ── building blocks ─────────────────────────────────────────────────────────
/** Expanding double ring on the ground. */
function shockRing(ctx: AbilityVfxContext, at: THREE.Vector3, radius: number, color: THREE.Color, life = 0.5): void {
  const g = ground(ctx, at, 0.1);
  ctx.fx.fx.ring(g, { color, radius0: 0.5, radius1: radius, life, inner: 0.75, alpha: 1.2 });
  ctx.fx.fx.ring(g, { color: WHITE, radius0: 0.3, radius1: radius * 0.7, life: life * 0.7, inner: 0.9, alpha: 0.7 });
}

/** Streak + afterimage glows along a dash / blink path. */
function trail(ctx: AbilityVfxContext, from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, n = 5): void {
  ctx.fx.beams.beam(from, to, color, 0.45, 0.4, 0.7);
  ctx.fx.beams.beam(from.clone().setY(from.y + 0.3), to.clone().setY(to.y + 0.3), WHITE, 0.14, 0.25, 0.8);
  for (let i = 0; i < n; i++) {
    const p = from.clone().lerp(to, (i + 0.5) / n);
    ctx.fx.burst(p, { count: 1, tex: PT.glow, color, speed: [0, 0], life: [0.25 + i * 0.05, 0.3 + i * 0.05], size: [1, 1.4], alpha: 0.5 });
  }
}

/** Kicked-up dust along the ground. */
function dust(ctx: AbilityVfxContext, from: THREE.Vector3, to: THREE.Vector3, n: number): void {
  const back = to.clone().sub(from).setY(0).normalize().negate();
  for (let i = 0; i < n; i++) {
    const g = ground(ctx, from.clone().lerp(to, i / Math.max(1, n - 1)), 0.2);
    ctx.fx.burst(g, { count: 4, tex: PT.dust, color: FX_COLORS.dust, dir: back, spread: 0.7, speed: [1.5, 4], up: 0.5, life: [0.5, 1], size: [0.4, 1.3], additive: false, alpha: 0.5, drag: 2, flat: true });
  }
}

// ── 曹操 ────────────────────────────────────────────────────────────────────
/** 奸雄 (proc): the blows harden into a steel-blue shell. */
const jianxiong: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  ctx.fx.fx.sphere(p, WEI_BLUE, 0.5, 1.3, 0.45, 0.8);
  ctx.fx.burst(p, { count: 10, tex: PT.shard, color: STEEL, speed: [1, 3], life: [0.3, 0.6], size: [0.12, 0.05], radius: 0.6, spin: 6, drag: 2 });
};

/** 宁教我负天下人: a blood-red command — war-cry ring, and a line of intent to the target. */
const ningjiao: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  shockRing(ctx, p, 7, BLOOD, 0.6);
  ctx.fx.burst(p, { count: 16, tex: PT.flame, color: BLOOD, color1: C(0.5, 0.05, 0.05), speed: [1, 3], up: 0.8, life: [0.4, 0.8], size: [0.3, 0.9], gravity: -2, radius: 0.6 });
  const t = ctx.targetPos;
  if (t && t.distanceTo(p) <= P('caocao_ningjiao', 'range', 60) + 1) {
    ctx.fx.beams.beam(p, t, BLOOD, 0.1, 0.6, 0.8);
    ctx.fx.fx.ring(ground(ctx, t), { color: BLOOD, radius0: 2.5, radius1: 0.8, life: 0.8, inner: 0.8, alpha: 1.1 });
  }
  ctx.fx.lights.flash(p, C(1, 0.25, 0.2), 10, 14, 0.3);
};

/** 望梅止渴: plum blossoms burst over the squad, green relief rings. */
const wangmei: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const g = ground(ctx, p);
  ctx.fx.burst(p.clone().setY(p.y + 1.2), { count: 30, tex: PT.petal, color: PLUM, color1: C(2.2, 1.6, 1.6), speed: [2, 5], up: 0.5, life: [1, 1.8], size: [0.14, 0.09], gravity: 1.2, drag: 1.5, spin: 5, radius: 1 });
  ctx.fx.fx.ring(g, { color: FX_COLORS.heal, radius0: 0.5, radius1: 10, life: 0.9, inner: 0.9, alpha: 1 });
  ctx.fx.heal(p, P('caocao_wangmei', 'selfHeal', 50));
};

/** 护驾: gold-and-blue banner pillar, three guard beacons around Cao Cao, a gong flash. */
const hujia: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const g = ground(ctx, p);
  ctx.fx.fx.pillar(g, WEI_BLUE, 0.5, 9, 0.9, 1);
  ctx.fx.fx.pillar(g, GOLD, 0.2, 11, 0.7, 0.9);
  const n = Math.max(1, Math.round(P('caocao_hujia', 'count', 3)));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const q = ground(ctx, new THREE.Vector3(p.x + Math.cos(a) * 2.4, p.y, p.z + Math.sin(a) * 2.4));
    ctx.fx.fx.pillar(q, GOLD, 0.35, 4, 0.8, 0.8);
    ctx.fx.burst(q, { count: 8, tex: PT.dust, color: FX_COLORS.dust, speed: [1, 3], life: [0.5, 0.9], size: [0.4, 1.2], additive: false, alpha: 0.5, drag: 2, flat: true });
  }
  ctx.fx.fx.ring(g, { color: GOLD, radius0: 0.5, radius1: P('caocao_hujia', 'radius', 10), life: 0.9, inner: 0.93, alpha: 1 });
  ctx.fx.lights.flash(p, C(1, 0.8, 0.45), 16, 18, 0.45);
  ctx.fx.shakeAt(p, 0.2, 12);
};

// ── 司马懿 ──────────────────────────────────────────────────────────────────
/** 反馈 (proc): a violet thread yanks a card from the attacker to Sima Yi. */
const fankui: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const t = ctx.targetPos;
  if (t) {
    ctx.fx.beams.beam(t, p, VIOLET, 0.07, 0.45, 0.9);
    ctx.fx.burst(t, { count: 8, tex: PT.star, color: VIOLET, speed: [0.5, 2], life: [0.3, 0.6], size: [0.12, 0.03], spin: 6 });
  }
  ctx.fx.sparkle(p, GOLD, 8);
};

/** 鬼才: a violet mirror shell snaps shut (the follow-hazard draws the lasting dome). */
const guicai: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  ctx.fx.fx.sphere(p, VIOLET, 2.2, 1.5, 0.35, 1);
  ctx.fx.burst(ground(ctx, p, 0.15), { count: 1, tex: PT.bagua, color: VIOLET, speed: [0, 0], life: [0.8, 1], size: [3.2, 2.6], alpha: 0.9, spin: 2 });
  ctx.fx.burst(p, { count: 14, tex: PT.shard, color: C(1.8, 1.4, 2.6), speed: [2, 5], life: [0.3, 0.6], size: [0.12, 0.05], spin: 8, drag: 3 });
  ctx.fx.lights.flash(p, C(0.7, 0.4, 1), 8, 10, 0.25);
};

/** 狼顾: the wolf looks back — a thin violet pulse sweeps out to the reveal radius. */
const langgu: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const g = ground(ctx, p, 0.12);
  const r = P('simayi_langgu', 'radius', 40);
  ctx.fx.fx.ring(g, { color: WOLF, radius0: 1, radius1: r, life: 1.2, inner: 0.97, alpha: 1.1 });
  ctx.fx.fx.ring(g, { color: WOLF, radius0: 0.5, radius1: r * 0.4, life: 0.8, inner: 0.92, alpha: 0.7 });
  const eye = p.clone().setY(p.y + 0.6);
  ctx.fx.burst(eye, { count: 2, tex: PT.glow, color: WOLF, speed: [0, 0], life: [0.6, 0.7], size: [0.5, 0.2], alpha: 1 });
  ctx.fx.burst(p, { count: 12, tex: PT.smoke, color: C(0.25, 0.18, 0.35), speed: [0.5, 1.5], up: 0.4, life: [0.8, 1.3], size: [0.5, 1.4], additive: false, alpha: 0.45, drag: 1.5 });
};

// ── 夏侯惇 ──────────────────────────────────────────────────────────────────
/** 拔矢啖睛: a spray of ink-blood, then a crimson surge of rage. */
const bashi: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  ctx.fx.inkSplash(p.clone().setY(p.y + 0.3), 1.6, flatDir(ctx));
  ctx.fx.burst(p, { count: 18, tex: PT.flame, color: BLOOD, color1: EMBER, speed: [1, 3], up: 0.9, life: [0.4, 0.8], size: [0.3, 0.9], gravity: -3, radius: 0.5 });
  ctx.fx.heal(p, 90);
  ctx.fx.lights.flash(p, C(1, 0.2, 0.15), 10, 10, 0.3);
};

/** 独目怒冲: steel-blue afterimages and dust along the 12 m charge lane. */
const charge: AbilityVfxFn = (ctx) => {
  const from = ctx.srcPos;
  const to = ahead(ctx, P('xiahoudun_charge', 'dash', 12));
  if (!from || !to) return;
  trail(ctx, from, to, WEI_BLUE, 6);
  dust(ctx, from, to, 5);
  const f = flatDir(ctx);
  ctx.fx.fx.ring(ground(ctx, from), { color: WEI_BLUE, radius0: 0.6, radius1: 2.2, life: 0.35, inner: 0.6, arc: Math.PI / 3, yaw: yawOf(f), alpha: 1.2 });
};

// ── 张辽 ────────────────────────────────────────────────────────────────────
/** 突袭: a blue blink streak to the target and a flicker where he reappears behind it. */
const tuxi: AbilityVfxFn = (ctx) => {
  const from = ctx.srcPos;
  if (!from) return;
  const to = ctx.targetPos ?? clampedPoint(ctx, P('zhangliao_tuxi', 'range', 12));
  if (!to) return;
  trail(ctx, from, to, WEI_BLUE, 4);
  ctx.fx.burst(from, { count: 12, tex: PT.spark, color: STEEL, speed: [2, 6], life: [0.2, 0.4], size: [0.05, 0.02], stretch: 0.03 });
  ctx.fx.fx.ring(ground(ctx, to), { color: WEI_BLUE, radius0: 0.5, radius1: P('zhangliao_tuxi', 'radius', 6), life: 0.45, inner: 0.9, alpha: 0.9 });
  ctx.fx.burst(to, { count: 10, tex: PT.star, color: GOLD, speed: [1, 3], life: [0.3, 0.6], size: [0.12, 0.03], spin: 6 });
};

/** 威震逍遥津: the name alone terrifies — a thundering blue shout wave. */
const weizhen: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const r = P('zhangliao_weizhen', 'radius', 10);
  shockRing(ctx, p, r, WEI_BLUE, 0.55);
  ctx.fx.fx.sphere(p, WEI_BLUE, 0.6, r * 0.6, 0.35, 0.6);
  ctx.fx.burst(ground(ctx, p, 0.2), { count: 16, tex: PT.dust, color: FX_COLORS.dust, speed: [4, 9], life: [0.5, 1], size: [0.5, 1.6], additive: false, alpha: 0.55, drag: 2, flat: true });
  ctx.fx.shakeAt(p, 0.3, r);
};

// ── 许褚 ────────────────────────────────────────────────────────────────────
/** 裸衣: armor off — a flare of heat and embers around the tiger fool. */
const luoyi: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  ctx.fx.burst(p, { count: 22, tex: PT.flame, color: EMBER, color1: C(0.8, 0.15, 0.02), speed: [1, 3.5], up: 0.9, life: [0.4, 0.9], size: [0.3, 1], gravity: -3, radius: 0.6 });
  ctx.fx.burst(p, { count: 12, tex: PT.spark, color: GOLD, speed: [3, 7], up: 0.6, life: [0.2, 0.5], size: [0.05, 0.02], stretch: 0.03, gravity: 6 });
  ctx.fx.fx.ring(ground(ctx, p), { color: EMBER, radius0: 0.4, radius1: 3, life: 0.4, inner: 0.7, alpha: 1 });
  ctx.fx.lights.flash(p, C(1, 0.5, 0.15), 10, 10, 0.3);
};

/** 虎卫猛击: a leap arc and a telegraph ring where he will crash down (the sim's 'melee' event is the impact). */
const slam: AbilityVfxFn = (ctx) => {
  const from = ctx.srcPos;
  const land = ahead(ctx, P('xuchu_slam', 'leap', 6));
  if (!from || !land) return;
  const mid = from.clone().lerp(land, 0.5);
  mid.y += 1.4;
  ctx.fx.beams.beam(from, mid, EMBER, 0.3, 0.45, 0.6);
  ctx.fx.beams.beam(mid, land, EMBER, 0.3, 0.55, 0.6);
  const g = ground(ctx, land, 0.1);
  const r = P('xuchu_slam', 'radius', 6);
  // shrinking telegraph that closes as he lands (leapTime)
  ctx.fx.fx.ring(g, { color: EMBER, radius0: r, radius1: r * 0.92, life: P('xuchu_slam', 'leapTime', 0.5) + 0.15, inner: 0.9, alpha: 0.9, alphaEnd: 0.6 });
  dust(ctx, from, from.clone().addScaledVector(flatDir(ctx), 1.5), 2);
};

// ── 郭嘉 ────────────────────────────────────────────────────────────────────
/** 天妒 (proc): heaven's envy repaid — a golden windfall glint. */
const tiandu: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  ctx.fx.sparkle(p, GOLD, 14);
  ctx.fx.fx.pillar(ground(ctx, p), GOLD, 0.35, 3, 0.5, 0.7);
};

/** 遗计: a signal flare arcs to the (range-clamped) drop point; a light beam marks the landing for the delay. */
const yiji: AbilityVfxFn = (ctx) => {
  const from = ctx.srcPos;
  const at = clampedPoint(ctx, P('guojia_yiji', 'range', 40));
  if (!at) return;
  const g = ground(ctx, at);
  const delay = P('guojia_yiji', 'delay', 3);
  if (from) {
    const top = from.clone().lerp(g, 0.5);
    top.y = Math.max(from.y, g.y) + 8;
    ctx.fx.beams.beam(from, top, C(2.6, 0.7, 0.3), 0.08, 0.6, 0.9);
    ctx.fx.beams.beam(top, g, C(2.6, 0.7, 0.3), 0.08, 0.8, 0.9);
  }
  ctx.fx.fx.pillar(g, GOLD, 0.6, 30, delay, 0.55);
  ctx.fx.fx.ring(g, { color: GOLD, radius0: 2.4, radius1: 1.2, life: delay, inner: 0.85, alpha: 1, alphaEnd: 0.7 });
  ctx.fx.lights.flash(g.clone().setY(g.y + 1), C(1, 0.4, 0.2), 10, 14, 0.5);
};

/** 鬼谋: a ghost-blue sigil brands the target. */
const guimou: AbilityVfxFn = (ctx) => {
  const src = ctx.srcPos;
  const t = ctx.targetPos;
  if (!t) return;
  if (src) ctx.fx.beams.beam(src, t, C(0.6, 1.2, 2.4), 0.05, 0.5, 0.8);
  ctx.fx.burst(ground(ctx, t, 0.12), { count: 1, tex: PT.bagua, color: C(0.6, 1.2, 2.4), speed: [0, 0], life: [1, 1.2], size: [2.4, 2], alpha: 0.9, spin: -2 });
  ctx.fx.burst(t.clone().setY(t.y + 1.2), { count: 1, tex: PT.ring, color: C(1.6, 1.8, 2.6), speed: [0, 0], life: [0.8, 1], size: [0.5, 0.9], alpha: 1 });
  ctx.fx.burst(t, { count: 10, tex: PT.smoke, color: C(0.3, 0.4, 0.6), speed: [0.4, 1.2], up: 0.6, life: [0.8, 1.4], size: [0.4, 1.2], additive: false, alpha: 0.4, drag: 1 });
};

// ── 甄姬 ────────────────────────────────────────────────────────────────────
/** 洛神: ripples spread on unseen water; motes of the goddess rise. */
const luoshen: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const g = ground(ctx, p);
  for (let i = 0; i < 3; i++) ctx.fx.fx.ring(g, { color: FROST, radius0: 0.3 + i * 0.4, radius1: 2.5 + i * 1.5, life: 0.8 + i * 0.25, inner: 0.93, alpha: 0.9 - i * 0.2 });
  ctx.fx.burst(g, { count: 18, tex: PT.snow, color: C(1.5, 1.8, 2.2), speed: [0.5, 1.8], up: 1, life: [1, 1.8], size: [0.12, 0.06], gravity: -0.8, drag: 1, radius: 1.2 });
  ctx.fx.burst(p, { count: 6, tex: PT.petal, color: C(1.6, 1.8, 2.4), speed: [0.4, 1.2], up: 1, life: [1, 1.6], size: [0.12, 0.08], gravity: -0.6, spin: 4, radius: 0.6 });
};

/** 凌波微步: she glides 10 m over a frost-silver streak; ice shatters where she stood. */
const lingbo: AbilityVfxFn = (ctx) => {
  const from = ctx.srcPos;
  const to = ahead(ctx, P('zhenji_lingbo', 'blink', 10));
  if (!from || !to) return;
  trail(ctx, from, to, FROST, 5);
  ctx.fx.explosion(from, Math.min(3, P('zhenji_lingbo', 'radius', 4)), 'ice');
  ctx.fx.burst(to, { count: 12, tex: PT.snow, color: C(1.5, 1.8, 2.2), speed: [0.5, 2], life: [0.6, 1.1], size: [0.12, 0.06], gravity: 0.5, drag: 1.5, radius: 0.5 });
};

// ── 夏侯渊 ──────────────────────────────────────────────────────────────────
/** 神速: a lightning-fast dash streak to the (≤ 14 m) landing point; the volley draws its own tracers. */
const shensu: AbilityVfxFn = (ctx) => {
  const from = ctx.srcPos;
  const to = clampedPoint(ctx, P('xiahouyuan_shensu', 'range', 14));
  if (!from || !to) return;
  const land = to.clone().setY(Math.max(to.y, ctx.fx.groundY(to.x, to.z) + 1));
  trail(ctx, from, land, C(1.2, 1.5, 2.6), 6);
  dust(ctx, from, land, 4);
  ctx.fx.burst(land, { count: 14, tex: PT.spark, color: GOLD, speed: [3, 8], life: [0.15, 0.35], size: [0.05, 0.02], stretch: 0.03 });
};

/** 虎步关右: a gust of wind — streaks trailing off the legs and a low dust ring. */
const hubu: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const back = flatDir(ctx).negate();
  ctx.fx.burst(p.clone().setY(p.y - 0.5), { count: 16, tex: PT.spark, color: C(1.6, 1.8, 2.4), dir: back, spread: 0.5, speed: [4, 9], life: [0.2, 0.45], size: [0.06, 0.02], stretch: 0.05, drag: 2 });
  ctx.fx.fx.ring(ground(ctx, p), { color: C(1.2, 1.5, 2.2), radius0: 0.4, radius1: 3.5, life: 0.4, inner: 0.85, alpha: 0.9 });
  ctx.fx.burst(ground(ctx, p, 0.2), { count: 10, tex: PT.dust, color: FX_COLORS.dust, speed: [2, 5], life: [0.4, 0.8], size: [0.4, 1.2], additive: false, alpha: 0.5, drag: 2, flat: true });
};

const WEI_VFX: Record<string, AbilityVfxFn> = {
  caocao_jianxiong: jianxiong,
  caocao_ningjiao: ningjiao,
  caocao_wangmei: wangmei,
  caocao_hujia: hujia,
  simayi_fankui: fankui,
  simayi_guicai: guicai,
  simayi_langgu: langgu,
  xiahoudun_bashi: bashi,
  xiahoudun_charge: charge,
  zhangliao_tuxi: tuxi,
  zhangliao_weizhen: weizhen,
  xuchu_luoyi: luoyi,
  xuchu_slam: slam,
  guojia_tiandu: tiandu,
  guojia_yiji: yiji,
  guojia_guimou: guimou,
  zhenji_luoshen: luoshen,
  zhenji_lingbo: lingbo,
  xiahouyuan_shensu: shensu,
  xiahouyuan_hubu: hubu,
};

/** Register (or re-register: idempotent) every Wei ability VFX. */
export function registerWeiAbilityVfx(): void {
  for (const [id, fn] of Object.entries(WEI_VFX)) registerAbilityVfx(id, fn);
}
