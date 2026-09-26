// Bespoke VFX for the 蜀 Shu abilities (sim/abilities/shu/*). The integrator
// calls registerShuAbilityVfx() once at renderer start-up; every function
// reacts to a { t: 'ability' } event through the shared AbilityVfxContext.
//
// Geometry comes from the ability data (dash lengths, radii) rather than
// ev.pos / ev.target, which until docs/SIM_REQUESTS.md SHU-3 lands are the raw
// crosshair point (up to 60 m away) and the raw aimed entity — see `near()`,
// `within()` and `along()`. Direction dashes never trust ev.pos (a crosshair on
// the ground 3 m ahead is not where a 7 m dash ends). Once SHU-3 lands, ev.pos
// and ev.target are the real cast point / resolved hero and `near()` /
// `within()` pick them up unchanged; only 青龙斩's stop point is estimated.
import * as THREE from 'three';
import { ABILITY_BY_ID } from '../../data';
import { PT } from '../core/textures';
import { registerAbilityVfx, type AbilityVfxContext, type AbilityVfxFn } from './abilities';
import { FX_COLORS } from './effects';

const C = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);

const SHU_RED = C(2.4, 0.55, 0.4);
const GOLD = C(2.2, 1.6, 0.55);
const JADE = C(0.45, 2.3, 0.95);
const SILVER = C(1.7, 1.85, 2.3);
const STEEL = C(1.3, 1.4, 1.6);
const STARLIGHT = C(0.9, 1.3, 2.6);
const STONE = C(0.55, 0.5, 0.44);

/** Tunable of an ability from the data (VFX mirrors the sim's numbers). */
const P = (id: string, key: string, fallback: number): number => ABILITY_BY_ID[id]?.params[key] ?? fallback;

/** Flat, normalised aim direction. */
function flatDir(ctx: AbilityVfxContext): THREE.Vector3 {
  const d = new THREE.Vector3(ctx.dir.x, 0, ctx.dir.z);
  return d.lengthSq() > 1e-6 ? d.normalize() : new THREE.Vector3(0, 0, -1);
}

/** Point on the ground (a hair above it). */
function ground(ctx: AbilityVfxContext, p: THREE.Vector3, lift = 0.08): THREE.Vector3 {
  return new THREE.Vector3(p.x, ctx.fx.groundY(p.x, p.z) + lift, p.z);
}

/** `dist` m ahead of the caster along the flat aim direction (chest height). */
function along(ctx: AbilityVfxContext, dist: number): THREE.Vector3 | null {
  if (!ctx.srcPos) return null;
  return ctx.srcPos.clone().addScaledVector(flatDir(ctx), dist);
}

/** ev.pos when it is plausibly the real effect point (within `maxDist` of the caster), else a fallback. */
function near(ctx: AbilityVfxContext, maxDist: number, fallback: () => THREE.Vector3 | null): THREE.Vector3 | null {
  const p = ctx.point;
  if (p && (!ctx.srcPos || p.distanceTo(ctx.srcPos) <= maxDist + 0.5)) return p;
  return fallback();
}

/** `p` if it lies within `maxDist` of the caster (or the caster is unknown), else null. */
function within(ctx: AbilityVfxContext, p: THREE.Vector3 | null, maxDist: number): THREE.Vector3 | null {
  if (!p) return null;
  return !ctx.srcPos || p.distanceTo(ctx.srcPos) <= maxDist ? p : null;
}

const yawOf = (d: THREE.Vector3): number => Math.atan2(-d.x, -d.z);

// ── building blocks ─────────────────────────────────────────────────────────
/** A row of fading "ghost" bursts + streaks along a dash path (afterimages). */
function afterimages(ctx: AbilityVfxContext, from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, n: number, width = 0.45): void {
  const fx = ctx.fx;
  fx.beams.beam(from, to, color, width, 0.4, 0.7);
  fx.beams.beam(from.clone().setY(from.y + 0.35), to.clone().setY(to.y + 0.35), C(2, 2, 2), width * 0.35, 0.25, 0.8);
  for (let i = 0; i < n; i++) {
    const p = from.clone().lerp(to, (i + 0.5) / n);
    fx.burst(p, { count: 1, tex: PT.glow, color, speed: [0, 0], life: [0.25 + i * 0.05, 0.3 + i * 0.05], size: [1.1, 1.6], alpha: 0.55 });
    fx.burst(p, { count: 4, tex: PT.spark, color: C(2, 2.1, 2.4), speed: [1, 3], life: [0.2, 0.4], size: [0.05, 0.02], stretch: 0.03 });
  }
}

/** Kicked-up dust along a path (hooves / charges). */
function dustTrail(ctx: AbilityVfxContext, from: THREE.Vector3, to: THREE.Vector3, n: number): void {
  const d = to.clone().sub(from).setY(0).normalize().negate();
  for (let i = 0; i < n; i++) {
    const g = ground(ctx, from.clone().lerp(to, i / Math.max(1, n - 1)), 0.2);
    ctx.fx.burst(g, { count: 5, tex: PT.dust, color: FX_COLORS.dust, dir: d, spread: 0.7, speed: [1.5, 4], up: 0.5, life: [0.5, 1.1], size: [0.4, 1.4], additive: false, alpha: 0.55, drag: 2, flat: true });
  }
}

/** Expanding shockwave rings on the ground. */
function shockwave(ctx: AbilityVfxContext, at: THREE.Vector3, radius: number, color: THREE.Color, yaw?: number, arc?: number): void {
  const g = ground(ctx, at, 0.1);
  ctx.fx.fx.ring(g, { color, radius0: 0.6, radius1: radius, life: 0.5, inner: 0.72, alpha: 1.3, yaw, arc });
  ctx.fx.fx.ring(g, { color: C(2.2, 2, 1.6), radius0: 0.3, radius1: radius * 0.75, life: 0.35, inner: 0.9, alpha: 0.8, yaw, arc });
}

// ── 刘备 ─────────────────────────────────────────────────────────────────────
/** 仁德·济民: a golden supply bundle arcs to the ally, who is showered in heal light. */
const jimin: AbilityVfxFn = (ctx) => {
  const range = P('liubei_jimin', 'range', 25) + 1.5;
  const to = within(ctx, ctx.targetPos, range) ?? near(ctx, range, () => null);
  if (ctx.srcPos && to) {
    const mid = ctx.srcPos.clone().lerp(to, 0.5);
    mid.y += Math.min(4, ctx.srcPos.distanceTo(to) * 0.2);
    ctx.fx.beams.beam(ctx.srcPos, mid, GOLD, 0.12, 0.45, 0.8);
    ctx.fx.beams.beam(mid, to, GOLD, 0.12, 0.55, 0.8);
    ctx.fx.burst(mid, { count: 8, tex: PT.star, color: GOLD, speed: [0.5, 2], life: [0.3, 0.6], size: [0.14, 0.04], spin: 6 });
  }
  if (to) {
    ctx.fx.heal(to, P('liubei_jimin', 'heal', 80));
    ctx.fx.sparkle(to, GOLD, 12);
  }
};

/** 蜀汉旌旗: the banner slams down — red-gold pillar, rally ring of the heal radius, petals. */
const banner: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const r = P('liubei_banner', 'radius', 8);
  const g = ground(ctx, p);
  ctx.fx.fx.pillar(g, SHU_RED, 0.35, 7, 0.9, 1);
  ctx.fx.fx.pillar(g, GOLD, 0.15, 9, 0.7, 0.9);
  ctx.fx.fx.ring(g, { color: SHU_RED, radius0: 0.5, radius1: r, life: 0.9, inner: 0.9, alpha: 1.2 });
  ctx.fx.fx.ring(g, { color: FX_COLORS.heal, radius0: r * 0.6, radius1: r, life: 1.2, inner: 0.95, alpha: 0.8 });
  ctx.fx.burst(g, { count: 26, tex: PT.petal, color: C(2.2, 0.8, 0.7), color1: GOLD, speed: [1, 4], up: 0.8, life: [1, 1.8], size: [0.12, 0.08], gravity: -0.4, drag: 1, spin: 4, radius: r * 0.5 });
  ctx.fx.burst(g, { count: 10, tex: PT.dust, color: FX_COLORS.dust, speed: [3, 7], life: [0.5, 1], size: [0.5, 1.5], additive: false, alpha: 0.5, drag: 3, flat: true });
  ctx.fx.lights.flash(p, C(1, 0.5, 0.35), 14, 16, 0.4);
};

/** 激将: war-drum shockwave calling the Shu to arms. */
const jijiang: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const r = P('liubei_jijiang', 'radius', 20);
  shockwave(ctx, p, r, SHU_RED);
  ctx.fx.fx.pillar(ground(ctx, p), GOLD, 0.6, 12, 0.8, 0.9);
  ctx.fx.fx.sphere(p, SHU_RED, 0.5, 4, 0.5, 0.7);
  ctx.fx.burst(p, { count: 20, tex: PT.chevron, color: GOLD, speed: [2, 6], up: 0.9, life: [0.6, 1], size: [0.25, 0.1], gravity: -1 });
  ctx.fx.lights.flash(p, C(1, 0.45, 0.3), 25, 30, 0.5);
  ctx.fx.shakeAt(p, 0.3, r);
};

// ── 关羽 ─────────────────────────────────────────────────────────────────────
/** 青龙斩: jade streak of the charge, then a green crescent sweep at its end. */
const qinglong: AbilityVfxFn = (ctx) => {
  const from = ctx.srcPos;
  if (!from) return;
  const d = flatDir(ctx);
  const end = from.clone().addScaledVector(d, qinglongReach(ctx, from, d));
  afterimages(ctx, from, end, JADE, 3, 0.4);
  const range = P('guanyu_qinglong', 'range', 4.5);
  const arc = P('guanyu_qinglong', 'arc', 110);
  const yaw = yawOf(d);
  ctx.fx.slash(end.clone().setY(end.y - 0.3), yaw, range, arc, JADE);
  ctx.fx.slash(end.clone().setY(end.y + 0.15), yaw, range * 0.85, arc * 0.9, C(2.2, 2.4, 2));
  ctx.fx.burst(end, { count: 22, tex: PT.glow, color: JADE, dir: d, spread: 0.9, speed: [3, 9], life: [0.3, 0.6], size: [0.15, 0.04], drag: 3 });
  ctx.fx.burst(end, { count: 8, tex: PT.petal, color: C(0.6, 2, 1), dir: d, spread: 1, speed: [2, 5], life: [0.5, 0.9], size: [0.14, 0.08], spin: 6, gravity: 1 });
  ctx.fx.shakeAt(end, 0.25, 8);
};

/**
 * How far 青龙斩 charged: the full dash, or — like the sim — stopped ~1.2 m
 * short of the aimed unit when it stands in the charge corridor ahead
 * (sim/abilities/shu/guanyu.ts; ev.target is the aimed entity before SHU-3).
 */
function qinglongReach(ctx: AbilityVfxContext, from: THREE.Vector3, d: THREE.Vector3): number {
  const dash = P('guanyu_qinglong', 'dash', 8);
  const t = ctx.targetPos;
  if (!t) return dash;
  const ax = t.x - from.x;
  const az = t.z - from.z;
  const ahead = ax * d.x + az * d.z;
  const side = Math.abs(ax * d.z - az * d.x);
  if (ahead <= 0.4 || ahead > dash + 1.8 || side > 1.4) return dash;
  const reach = ahead - 0.4 - 1.2;
  return reach < 0.5 ? 0 : Math.min(dash, reach);
}

/** 义绝: a green-gold severing line to the target, a seal ring on it. */
const yijue: AbilityVfxFn = (ctx) => {
  const range = P('guanyu_yijue', 'range', 30) + 2;
  const t = within(ctx, ctx.targetPos, range) ?? near(ctx, range, () => null);
  if (!t) return;
  if (ctx.srcPos) ctx.fx.beams.beam(ctx.srcPos, t, JADE, 0.07, 0.5, 0.9);
  ctx.fx.fx.ring(ground(ctx, t), { color: JADE, radius0: 1.6, radius1: 0.6, life: 0.6, inner: 0.8, alpha: 1.2 });
  ctx.fx.burst(t, { count: 10, tex: PT.shard, color: C(0.5, 1.8, 0.8), speed: [1, 3], life: [0.4, 0.7], size: [0.12, 0.05], spin: 5 });
};

// ── 张飞 ─────────────────────────────────────────────────────────────────────
/** 咆哮: a roaring shockwave around 张飞. */
const paoxiao: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const r = P('zhangfei_paoxiao', 'radius', 8);
  shockwave(ctx, p, r, C(2.4, 0.7, 0.25));
  ctx.fx.fx.sphere(p, C(2.2, 0.6, 0.25), 0.4, r * 0.55, 0.3, 0.7);
  ctx.fx.burst(ground(ctx, p), { count: 18, tex: PT.dust, color: FX_COLORS.dust, speed: [4, 9], life: [0.5, 1], size: [0.5, 1.6], additive: false, alpha: 0.6, drag: 2, flat: true });
  ctx.fx.shakeAt(p, 0.35, r * 1.5);
};

/** 据水断桥: a cone-shaped thunderclap of a shout. */
const duanqiao: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const d = flatDir(ctx);
  const r = P('zhangfei_duanqiao', 'range', 10);
  const arc = (P('zhangfei_duanqiao', 'arc', 70) * Math.PI) / 360;
  shockwave(ctx, p, r, C(2.3, 0.55, 0.3), yawOf(d), arc);
  ctx.fx.burst(p, { count: 24, tex: PT.dust, color: FX_COLORS.dust, dir: d, spread: 0.45, speed: [6, 12], life: [0.5, 0.9], size: [0.6, 1.8], additive: false, alpha: 0.6, drag: 2 });
  ctx.fx.burst(p, { count: 10, tex: PT.spark, color: C(2.4, 1.4, 0.5), dir: d, spread: 0.4, speed: [8, 16], life: [0.2, 0.4], size: [0.06, 0.02], stretch: 0.05 });
  ctx.fx.shakeAt(p, 0.45, r);
};

// ── 诸葛亮 ───────────────────────────────────────────────────────────────────
/** 观星 (private pulse): a faint star-map sweep out to the reveal radius. */
const guanxing: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const r = P('zhugeliang_guanxing', 'radius', 45);
  ctx.fx.fx.ring(ground(ctx, p, 0.15), { color: STARLIGHT, radius0: 1, radius1: r, life: 1.2, inner: 0.97, alpha: 0.6 });
  ctx.fx.burst(p.clone().setY(p.y + 1.2), { count: 12, tex: PT.star, color: STARLIGHT, speed: [0.3, 1.2], up: 1, life: [0.8, 1.4], size: [0.14, 0.04], gravity: -0.6, spin: 3 });
};

/**
 * 八阵图: stones erupt at the eight gates and light pillars rise there, gold
 * rings sweep the maze floor, a small bagua seal flares over its heart. (The
 * 8 s bagua ground decal itself is drawn by the hazard renderer for 'bazhen';
 * particles always face the camera, so the seal stays ~2 m — never a giant
 * upright glyph.)
 */
const bazhen: AbilityVfxFn = (ctx) => {
  const r = P('zhugeliang_bazhen', 'radius', 7);
  const range = P('zhugeliang_bazhen', 'range', 30);
  const p = near(ctx, range, () => along(ctx, range));
  if (!p) return;
  const g = ground(ctx, p, 0.15);
  ctx.fx.fx.ring(g, { color: GOLD, radius0: r * 0.2, radius1: r, life: 0.9, inner: 0.9, alpha: 1.1 });
  ctx.fx.fx.ring(g, { color: C(1.4, 1.1, 0.5), radius0: r, radius1: r * 0.35, life: 1.3, inner: 0.94, alpha: 0.7 });
  ctx.fx.burst(g.clone().setY(g.y + 1.3), { count: 1, tex: PT.bagua, color: GOLD, speed: [0, 0], life: [0.9, 1.1], size: [1.6, 2.2], alpha: 0.85, spin: 1.2 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const s = ground(ctx, new THREE.Vector3(g.x + Math.cos(a) * r, g.y, g.z + Math.sin(a) * r), 0.1);
    ctx.fx.fx.pillar(s, GOLD, 0.25, 3.2, 0.9, 0.7);
    ctx.fx.burst(s, { count: 5, tex: PT.square, color: STONE, color1: C(0.35, 0.32, 0.3), speed: [2, 5], up: 1, life: [0.8, 1.3], size: [0.35, 0.2], gravity: 12, additive: false, spin: 5 });
    ctx.fx.burst(s, { count: 3, tex: PT.dust, color: FX_COLORS.dust, speed: [1, 3], up: 0.6, life: [0.8, 1.4], size: [0.6, 1.6], additive: false, alpha: 0.5, drag: 2 });
  }
  ctx.fx.shakeAt(g, 0.2, r * 2);
};

/** 空城: a golden guqin aura — notes drift, a calm ring spreads to the aggro radius. */
const kongcheng: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const r = P('zhugeliang_kongcheng', 'radius', 15);
  ctx.fx.fx.sphere(p, GOLD, 0.6, 1.5, P('zhugeliang_kongcheng', 'duration', 3), 0.55);
  ctx.fx.fx.ring(ground(ctx, p), { color: GOLD, radius0: 1, radius1: r, life: 1.5, inner: 0.96, alpha: 0.7 });
  ctx.fx.burst(p, { count: 16, tex: PT.note, color: C(2.2, 1.8, 0.8), speed: [0.4, 1.6], up: 0.9, life: [1.2, 2.2], size: [0.24, 0.14], gravity: -0.6, spin: 2, radius: 0.8 });
  ctx.fx.lights.flash(p, C(1, 0.8, 0.4), 10, 12, 0.8);
};

// ── 赵云 ─────────────────────────────────────────────────────────────────────
/** 龙胆 (after a dodge): silver dragon-gall glint on 赵云. */
const longdan: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  ctx.fx.burst(p, { count: 10, tex: PT.chevron, color: SILVER, speed: [0.5, 2], up: 1, life: [0.4, 0.7], size: [0.2, 0.08], gravity: -2 });
  ctx.fx.fx.sphere(p, C(0.8, 1.1, 2.2), 0.4, 1.1, 0.3, 0.6);
};

/** 七进七出: silver afterimage dash. */
const qijin: AbilityVfxFn = (ctx) => {
  const from = ctx.srcPos;
  if (!from) return;
  // a direction dash always covers its full length (walls aside): never ev.pos
  const to = along(ctx, P('zhaoyun_qijin', 'dash', 7))!;
  afterimages(ctx, from, to, SILVER, 5, 0.5);
};

/** 长坂救主: a blue lance of light to the rescued hero, shields on both. */
const jiuzhu: AbilityVfxFn = (ctx) => {
  const blue = C(0.6, 1.2, 2.4);
  // (a target beyond the rescue range cannot be the hero he dashed to)
  const t = within(ctx, ctx.targetPos, P('zhaoyun_jiuzhu', 'range', 20) + 1.5);
  if (ctx.srcPos && t && ctx.srcPos.distanceTo(t) > 1) afterimages(ctx, ctx.srcPos, t, blue, 4, 0.35);
  if (t) ctx.fx.fx.sphere(t, blue, 0.4, 1.4, 0.6, 1);
  if (ctx.srcPos) ctx.fx.fx.sphere(ctx.srcPos, blue, 0.4, 1.3, 0.5, 0.8);
  else if (!t) return;
  ctx.fx.burst(t ?? ctx.srcPos!, { count: 10, tex: PT.chevron, color: blue, speed: [0.5, 2], up: 1, life: [0.4, 0.7], size: [0.2, 0.08], gravity: -2 });
};

// ── 马超 ─────────────────────────────────────────────────────────────────────
/** 铁骑: steel sparks and a hard silver pulse. */
const tieji: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  ctx.fx.fx.sphere(p, STEEL, 0.5, 1.8, 0.35, 0.9);
  ctx.fx.burst(p, { count: 24, tex: PT.spark, color: C(2.2, 1.9, 1.4), speed: [3, 8], life: [0.25, 0.5], size: [0.06, 0.02], stretch: 0.04, gravity: 6 });
  ctx.fx.fx.ring(ground(ctx, p), { color: C(2.3, 0.5, 0.4), radius0: 0.4, radius1: 3, life: 0.45, inner: 0.85, alpha: 1 });
};

/** 西凉冲锋: a thundering gallop — dust trail and a hoof-strike ring at the end. */
const xiliang: AbilityVfxFn = (ctx) => {
  const from = ctx.srcPos;
  if (!from) return;
  // a direction dash always covers its full length (walls aside): never ev.pos
  const end = along(ctx, P('machao_charge', 'dash', 15))!;
  ctx.fx.beams.beam(from, end, STEEL, 0.9, 0.45, 0.45);
  dustTrail(ctx, from, end, 7);
  shockwave(ctx, end, 3.5, C(1.8, 1.5, 1.2));
  ctx.fx.shakeAt(from, 0.3, 14);
};

// ── 黄月英 ───────────────────────────────────────────────────────────────────
/** 集智: brass gear-sparkle on 黄月英. */
const jizhi: AbilityVfxFn = (ctx) => {
  if (ctx.srcPos) ctx.fx.sparkle(ctx.srcPos, GOLD, 14);
};

/** 木牛流马: workshop sparks and sawdust where the turret unfolds. */
const muniu: AbilityVfxFn = (ctx) => {
  const range = P('huangyueying_muniu', 'range', 6);
  // the turret stands at the crosshair clamped to `range` (ev.target is no help: an aimed enemy before SHU-3)
  const p = near(ctx, range + 1, () => along(ctx, Math.min(3, range)));
  if (!p) return;
  const g = ground(ctx, p, 0.3);
  ctx.fx.burst(g, { count: 18, tex: PT.spark, color: C(2.4, 1.7, 0.6), speed: [2, 6], up: 0.8, life: [0.3, 0.7], size: [0.05, 0.02], stretch: 0.03, gravity: 9 });
  ctx.fx.burst(g, { count: 8, tex: PT.square, color: C(0.7, 0.5, 0.3), speed: [1.5, 4], up: 0.9, life: [0.6, 1], size: [0.1, 0.06], gravity: 12, additive: false, spin: 8 });
  ctx.fx.burst(g, { count: 6, tex: PT.star, color: GOLD, speed: [0.3, 1.2], up: 1, life: [0.6, 1], size: [0.14, 0.04], gravity: -0.5, spin: 5 });
  ctx.fx.fx.ring(ground(ctx, p), { color: GOLD, radius0: 0.2, radius1: 1.6, life: 0.5, inner: 0.8 });
};

/** 奇才: overclock — orange sparks crackle off 黄月英 and a quick ring. */
const qicai: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  ctx.fx.burst(p, { count: 22, tex: PT.spark, color: C(2.6, 1.4, 0.4), speed: [3, 7], life: [0.25, 0.5], size: [0.05, 0.02], stretch: 0.04 });
  ctx.fx.fx.ring(ground(ctx, p), { color: C(2.4, 1.3, 0.4), radius0: 0.4, radius1: 5, life: 0.5, inner: 0.9, alpha: 1 });
  ctx.fx.lights.flash(p, C(1, 0.6, 0.2), 10, 10, 0.3);
};

// ── 黄忠 ─────────────────────────────────────────────────────────────────────
/**
 * 百步穿杨: the bow-string release — a golden flash, a short release streak and
 * a spray of sparks along the shot. The arrow itself (and where walls stop it)
 * is the projectile renderer's job: the effect has no collision data, so it
 * never draws a long tracer that could pass through a wall.
 */
const chuanyang: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const d = ctx.dir.clone();
  if (d.lengthSq() < 1e-6) return;
  d.normalize();
  const tip = p.clone().addScaledVector(d, 0.8);
  ctx.fx.beams.beam(p, p.clone().addScaledVector(d, 3), GOLD, 0.08, 0.25, 0.8);
  ctx.fx.burst(tip, { count: 1, tex: PT.glow, color: C(2.6, 2.1, 1.2), speed: [0, 0], life: [0.15, 0.2], size: [0.9, 0.3], alpha: 0.9 });
  ctx.fx.burst(tip, { count: 14, tex: PT.spark, color: GOLD, dir: d, spread: 0.25, speed: [6, 14], life: [0.15, 0.3], size: [0.05, 0.02], stretch: 0.05 });
  ctx.fx.burst(p, { count: 6, tex: PT.dust, color: FX_COLORS.dust, dir: d.clone().negate(), spread: 0.8, speed: [1, 3], life: [0.3, 0.6], size: [0.3, 0.8], additive: false, alpha: 0.4, drag: 3 });
  ctx.fx.lights.flash(p, C(1, 0.8, 0.4), 8, 10, 0.15);
};

/** 老当益壮: a surge of vigor — heal motes and a gust of wind at the feet. */
const laodang: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  ctx.fx.heal(p, 100);
  ctx.fx.burst(ground(ctx, p, 0.2), { count: 12, tex: PT.dust, color: FX_COLORS.dust, speed: [3, 6], life: [0.4, 0.8], size: [0.4, 1.2], additive: false, alpha: 0.5, drag: 2, flat: true });
  ctx.fx.burst(p, { count: 8, tex: PT.chevron, color: C(1.8, 1.5, 0.6), speed: [0.5, 1.5], up: 1, life: [0.5, 0.8], size: [0.2, 0.08], gravity: -2 });
};

const SHU_VFX: Record<string, AbilityVfxFn> = {
  liubei_jimin: jimin,
  liubei_banner: banner,
  liubei_jijiang: jijiang,
  guanyu_qinglong: qinglong,
  guanyu_yijue: yijue,
  zhangfei_paoxiao: paoxiao,
  zhangfei_duanqiao: duanqiao,
  zhugeliang_guanxing: guanxing,
  zhugeliang_bazhen: bazhen,
  zhugeliang_kongcheng: kongcheng,
  zhaoyun_longdan: longdan,
  zhaoyun_qijin: qijin,
  zhaoyun_jiuzhu: jiuzhu,
  machao_tieji: tieji,
  machao_charge: xiliang,
  huangyueying_jizhi: jizhi,
  huangyueying_muniu: muniu,
  huangyueying_qicai: qicai,
  huangzhong_chuanyang: chuanyang,
  huangzhong_laodang: laodang,
};

/** Ability ids that get a bespoke Shu effect. */
export const SHU_VFX_IDS: readonly string[] = Object.keys(SHU_VFX);

/** Register the bespoke Shu effects (replacing the built-in generic flavours). Idempotent. */
export function registerShuAbilityVfx(): void {
  for (const [id, fn] of Object.entries(SHU_VFX)) registerAbilityVfx(id, fn);
}
