// Bespoke VFX for the 吴 Wu abilities (孙权 甘宁 吕蒙 黄盖 周瑜 大乔 陆逊 孙尚香).
// The integrator calls registerWuAbilityVfx() once, after the renderer's
// built-in table (each entry replaces the generic / built-in flavour).
//
// These draw the *cast*. The sim emits the follow-up visuals itself: 火烧赤壁's
// five bombs and 诈降火船's blast are 'fire' explosion events, 弓腰姬's arrows
// are projectiles with their own blasts, and every burning field (luxun_fire,
// chibi_napalm, huochuan_fire) is a hazard entity drawn as fire. Passives that
// announce themselves with an 'ability' event (流离, 连营, 枭姬, 克己) get one too.
import * as THREE from 'three';
import { ABILITY_BY_ID } from '../../data';
import { PT, type ParticleTex } from '../core/textures';
import { registerAbilityVfx, type AbilityVfxContext, type AbilityVfxFn } from './abilities';
import { FX_COLORS } from './effects';

const C = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);

const WU_GREEN = C(0.5, 2.1, 1.0);
const JADE = C(0.4, 1.9, 1.4);
const GOLD = C(2.2, 1.6, 0.45);
const EMBER = C(2.6, 0.9, 0.2);
const NAPALM = C(2.8, 0.55, 0.12);
const WARN_RED = C(2.6, 0.35, 0.15);
const EMP = C(0.7, 1.6, 2.8);
const PETAL_PINK = C(2.3, 0.9, 1.3);
const CHARM_PINK = C(2.4, 0.55, 1.2);
const MIND_VIOLET = C(1.4, 0.6, 2.4);
const MIST = C(0.85, 0.9, 0.92);
const BLOOD = C(0.55, 0.03, 0.03);
const ROYAL_RED = C(2.4, 0.4, 0.35);

// ── helpers ─────────────────────────────────────────────────────────────────
/** Ground-level copy of a point (+ lift). */
function ground(ctx: AbilityVfxContext, p: THREE.Vector3, lift = 0.08): THREE.Vector3 {
  return new THREE.Vector3(p.x, ctx.fx.groundY(p.x, p.z) + lift, p.z);
}

/** Caster feet (view entity), falling back to the chest anchor. */
function feet(ctx: AbilityVfxContext): THREE.Vector3 | null {
  if (ctx.src) return new THREE.Vector3(ctx.src.x, ctx.src.y, ctx.src.z);
  return ctx.srcPos ? ctx.srcPos.clone().setY(ctx.srcPos.y - 1) : null;
}

/** Horizontal unit direction of the cast (aim yaw). */
function flatDir(ctx: AbilityVfxContext): THREE.Vector3 {
  const d = new THREE.Vector3(ctx.dir.x, 0, ctx.dir.z);
  if (d.lengthSq() < 1e-6) {
    const yaw = ctx.src?.yaw ?? 0;
    d.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  }
  return d.normalize();
}

const yawOf = (d: THREE.Vector3): number => Math.atan2(-d.x, -d.z);

/** Ability tunable from the data (VFX follows the numbers the sim uses). */
function p(id: string, key: string, fallback: number): number {
  const v = ABILITY_BY_ID[id]?.params[key];
  return v === undefined || !Number.isFinite(v) ? fallback : v;
}

/** The unit the cast resolved to, else the crosshair point. */
const targetOrPoint = (ctx: AbilityVfxContext): THREE.Vector3 | null => ctx.targetPos ?? ctx.point;

/** Stream of particles along a segment (charm tethers, petal swirls). */
function streamAlong(ctx: AbilityVfxContext, a: THREE.Vector3, b: THREE.Vector3, n: number, color: THREE.Color, tex: ParticleTex, size: number): void {
  const d = b.clone().sub(a);
  const len = d.length();
  if (len < 1e-3) return;
  d.divideScalar(len);
  for (let i = 0; i < n; i++) {
    const at = a.clone().addScaledVector(d, (len * (i + 0.5)) / n);
    ctx.fx.burst(at, { count: 1, tex, color, dir: d, spread: 0.25, speed: [0.5, 1.5], life: [0.5, 0.9], size: [size, size * 0.4], gravity: -0.6, spin: 4 });
  }
}

// ── 孙权 ────────────────────────────────────────────────────────────────────
/** 制衡: the hand is reshuffled — a whirl of gold cards around him, green seal ring. */
const zhiheng: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  ctx.fx.burst(c, { count: 14, tex: PT.square, color: GOLD, color1: C(2.4, 2.1, 1.2), speed: [2, 4], up: 0.5, life: [0.5, 0.9], size: [0.22, 0.12], drag: 2.5, radius: 0.6, spin: 9 });
  ctx.fx.fx.ring(ground(ctx, c), { color: WU_GREEN, radius0: 0.3, radius1: 2.2, life: 0.5, inner: 0.78, alpha: 1.1 });
  ctx.fx.sparkle(c, GOLD, 10);
};

/** 坐断东南: Jiefan marksmen rally — a green standard pillar and a dust ring. */
const zuoduan: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const g = ground(ctx, f);
  ctx.fx.fx.pillar(g, WU_GREEN, 0.5, 5, 0.8, 0.8);
  ctx.fx.fx.ring(g, { color: WU_GREEN, radius0: 0.5, radius1: 4, life: 0.7, inner: 0.85 });
  ctx.fx.burst(g, { count: 12, tex: PT.dust, color: FX_COLORS.dust, speed: [3, 6], life: [0.6, 1], size: [0.5, 1.5], additive: false, alpha: 0.55, drag: 3, flat: true, radius: 1 });
};

/** 救援: a jade dome spreads over the Wu line (15 m) with rising motes. */
const jiuyuan: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const r = p('sunquan_jiuyuan', 'radius', 15);
  const g = ground(ctx, f);
  ctx.fx.fx.ring(g, { color: JADE, radius0: 1, radius1: r, life: 1.1, inner: 0.93, alpha: 1.2 });
  ctx.fx.fx.ring(g, { color: GOLD, radius0: 0.5, radius1: r * 0.55, life: 0.8, inner: 0.9, alpha: 0.8 });
  ctx.fx.fx.sphere(g, JADE, 1, r * 0.45, 0.6, 0.35);
  ctx.fx.burst(g, { count: 26, tex: PT.glow, color: JADE, color1: GOLD, speed: [0.5, 2], up: 1, life: [1, 1.8], size: [0.18, 0.05], gravity: -1.4, radius: r * 0.5, flat: true });
};

// ── 甘宁 ────────────────────────────────────────────────────────────────────
/** 奇袭: a crackling EMP bolt from his crossbow to the target, sparks and a shock ring there. */
const qixi: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const b = targetOrPoint(ctx);
  if (a && b) {
    ctx.fx.beams.lightning(a, b, EMP, 0.18, 0.3);
    ctx.fx.beams.beam(a, b, C(1.6, 2, 2.6), 0.05, 0.25, 0.9);
  }
  if (b) {
    ctx.fx.burst(b, { count: 22, tex: PT.spark, color: EMP, color1: C(2, 2, 2.6), speed: [4, 10], life: [0.2, 0.45], size: [0.06, 0.02], stretch: 0.04, gravity: 6 });
    ctx.fx.fx.sphere(b, EMP, 0.2, 1.6, 0.3, 0.8);
    ctx.fx.lights.flash(b, C(0.5, 0.8, 1.2), 10, 10, 0.2);
  }
};

/** 百骑劫营: he (and his riders) melt into river mist, bells glinting. */
const jieying: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  ctx.fx.burst(c, { count: 16, tex: PT.smoke, color: MIST, speed: [0.5, 2.2], life: [0.9, 1.6], size: [0.7, 2.2], additive: false, alpha: 0.55, drag: 2, radius: 1.2 });
  ctx.fx.burst(c, { count: 8, tex: PT.star, color: GOLD, speed: [0.5, 1.5], up: 0.6, life: [0.4, 0.8], size: [0.1, 0.02], spin: 6, radius: 0.5 });
};

// ── 吕蒙 ────────────────────────────────────────────────────────────────────
/** 白衣渡江: a swirl of white robes and mist as he vanishes. */
const baiyi: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  ctx.fx.burst(c, { count: 14, tex: PT.smoke, color: C(0.95, 0.96, 0.98), speed: [0.6, 2], life: [0.8, 1.4], size: [0.6, 1.9], additive: false, alpha: 0.6, drag: 2, radius: 0.6 });
  ctx.fx.fx.ring(ground(ctx, c), { color: C(1.6, 1.7, 1.7), radius0: 0.3, radius1: 2.4, life: 0.5, inner: 0.8, alpha: 0.7 });
};

/** 克己 (private: only he sees it): a faint wisp as he fades out. */
const keji: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (c) ctx.fx.burst(c, { count: 6, tex: PT.smoke, color: MIST, speed: [0.3, 1], life: [0.6, 1], size: [0.5, 1.3], additive: false, alpha: 0.35, drag: 2, radius: 0.4 });
};

/** 攻心: a violet mind-lance to the target, an ink burst where it strikes. */
const gongxin: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const b = targetOrPoint(ctx);
  if (a && b) ctx.fx.beams.beam(a, b, MIND_VIOLET, 0.07, 0.4, 0.9);
  if (b) {
    ctx.fx.inkSplash(b, 1.2);
    ctx.fx.burst(b, { count: 10, tex: PT.glow, color: MIND_VIOLET, speed: [1, 3], life: [0.3, 0.6], size: [0.15, 0.04], radius: 0.3 });
  }
};

// ── 黄盖 ────────────────────────────────────────────────────────────────────
/** 苦肉: the lash — a spray of blood-ink and embers around him. */
const kurou: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  ctx.fx.burst(c, { count: 14, tex: PT.ink, color: BLOOD, color1: C(0.25, 0.01, 0.01), speed: [1.5, 4], up: 0.3, life: [0.4, 0.7], size: [0.08, 0.04], gravity: 9, additive: false, alpha: 0.95, radius: 0.3 });
  ctx.fx.burst(c, { count: 10, tex: PT.flame, color: EMBER, color1: C(0.9, 0.2, 0.04), speed: [0.5, 2], up: 0.8, life: [0.4, 0.8], size: [0.25, 0.6], gravity: -2, radius: 0.5 });
};

/** 诈降火船: the burning drone launches — a flame gout and smoke along the launch line. */
const huochuan: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  const d = ctx.dir.clone().normalize();
  const muzzle = c.clone().addScaledVector(d, 0.8);
  ctx.fx.burst(muzzle, { count: 14, tex: PT.flame, color: EMBER, color1: C(0.9, 0.25, 0.05), dir: d, spread: 0.35, speed: [3, 7], life: [0.25, 0.5], size: [0.3, 0.8], drag: 3 });
  ctx.fx.burst(muzzle, { count: 8, tex: PT.smoke, color: FX_COLORS.smoke, dir: d.clone().negate(), spread: 0.5, speed: [0.5, 2], life: [0.8, 1.4], size: [0.5, 1.6], additive: false, alpha: 0.5, drag: 1.5 });
  ctx.fx.lights.flash(muzzle, C(1, 0.5, 0.2), 8, 10, 0.2);
};

// ── 周瑜 ────────────────────────────────────────────────────────────────────
/** 反间: a pink tether to the charmed enemy, then from it to whoever it turns on (event pos). */
const fanjian: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const t = ctx.targetPos ?? ctx.point;
  if (a && t) ctx.fx.beams.beam(a, t, CHARM_PINK, 0.06, 0.45, 0.9);
  if (t) ctx.fx.burst(t, { count: 12, tex: PT.heart, color: CHARM_PINK, speed: [0.5, 2], up: 0.8, life: [0.8, 1.3], size: [0.22, 0.12], gravity: -1, spin: 3 });
  const victim = ctx.targetPos && ctx.point && ctx.point.distanceTo(ctx.targetPos) > 1.5 ? ctx.point : null;
  if (t && victim) {
    ctx.fx.beams.beam(t, victim, C(2.6, 0.35, 0.3), 0.05, 0.9, 0.8);
    streamAlong(ctx, t, victim, 6, CHARM_PINK, PT.heart, 0.14);
  }
};

/**
 * 火烧赤壁: the 1.5 s warning — the five bomb marks along the 25 m line flare red and
 * burn down while embers drift; the sim's 'fire' explosions land on them.
 */
const chibi: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const d = flatDir(ctx);
  const n = Math.max(1, Math.round(p('zhouyu_chibi', 'blasts', 5)));
  const len = p('zhouyu_chibi', 'length', 25);
  const r = p('zhouyu_chibi', 'radius', 3.5);
  const delay = p('zhouyu_chibi', 'delay', 1.5);
  const yaw = yawOf(d);
  for (let i = 0; i < n; i++) {
    const at = f.clone().addScaledVector(d, n > 1 ? (i * len) / (n - 1) : len / 2);
    const g = ground(ctx, at, 0.1);
    ctx.fx.fx.ring(g, { color: WARN_RED, radius0: r, radius1: r * 0.25, life: delay, inner: 0.86, innerEnd: 0.5, alpha: 0.35, alphaEnd: 1.1 });
    ctx.fx.fx.ring(g, { color: NAPALM, radius0: 0.2, radius1: r, life: delay, inner: 0, alpha: 0.12, alphaEnd: 0.35, soft: 0.6 });
    ctx.fx.burst(g, { count: 4, tex: PT.flame, color: EMBER, speed: [0.2, 0.8], up: 1, life: [0.6, 1.2], size: [0.15, 0.3], gravity: -1.2, radius: r * 0.6, flat: true });
  }
  // a long red streak marks the whole corridor
  const a = ground(ctx, f, 0.12);
  const b = ground(ctx, f.clone().addScaledVector(d, len), 0.12);
  ctx.fx.beams.beam(a, b, WARN_RED, 0.25, delay, 0.45);
  ctx.fx.slash(ground(ctx, f, 0.1), yaw, 3, 40, NAPALM);
};

// ── 大乔 ────────────────────────────────────────────────────────────────────
/** 国色: 乐不思蜀 thrown — a pink arc to the target, notes and petals around it. */
const guose: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const b = targetOrPoint(ctx);
  if (a && b) streamAlong(ctx, a, b, 8, PETAL_PINK, PT.petal, 0.14);
  if (!b) return;
  ctx.fx.burst(b, { count: 12, tex: PT.note, color: C(2, 1.6, 0.6), speed: [0.5, 2], up: 0.8, life: [0.9, 1.5], size: [0.24, 0.14], gravity: -1, spin: 3 });
  ctx.fx.burst(b, { count: 10, tex: PT.heart, color: PETAL_PINK, speed: [0.4, 1.6], up: 0.9, life: [0.8, 1.3], size: [0.18, 0.1], gravity: -0.8, spin: 3, radius: 0.4 });
  ctx.fx.fx.ring(ground(ctx, b), { color: PETAL_PINK, radius0: 0.3, radius1: 1.6, life: 0.7, inner: 0.7 });
};

/** 安娴: a calm pink-green circle (8 m) and drifting petals; the heals show their own motes. */
const anxian: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const r = p('daqiao_anxian', 'radius', 8);
  const g = ground(ctx, f);
  ctx.fx.fx.ring(g, { color: FX_COLORS.heal, radius0: 0.5, radius1: r, life: 0.9, inner: 0.9, alpha: 1 });
  ctx.fx.fx.ring(g, { color: PETAL_PINK, radius0: 0.3, radius1: r * 0.6, life: 0.7, inner: 0.85, alpha: 0.8 });
  ctx.fx.burst(g, { count: 22, tex: PT.petal, color: PETAL_PINK, color1: C(2, 1.6, 1.6), speed: [0.4, 1.4], up: 1, life: [1.2, 2], size: [0.14, 0.09], gravity: -0.4, drag: 0.8, spin: 5, radius: r * 0.6, flat: true });
  if (ctx.srcPos) ctx.fx.heal(ctx.srcPos, 80);
};

/** 流离: a swirl of petals whisks the bullet from her to the unit that takes it (event target). */
const liuli: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const b = ctx.targetPos ?? ctx.point;
  if (a) ctx.fx.burst(a, { count: 8, tex: PT.petal, color: PETAL_PINK, speed: [1, 3], life: [0.4, 0.8], size: [0.12, 0.06], spin: 8, radius: 0.5 });
  if (a && b && a.distanceTo(b) > 0.5) {
    ctx.fx.beams.beam(a, b, PETAL_PINK, 0.04, 0.3, 0.8);
    streamAlong(ctx, a, b, 5, PETAL_PINK, PT.petal, 0.12);
  }
};

// ── 陆逊 ────────────────────────────────────────────────────────────────────
/** 火烧连营: the camps ignite one after another along the line (the fields draw themselves). */
const huoshao: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const d = flatDir(ctx);
  const n = Math.max(1, Math.round(p('luxun_huoshao', 'count', 5)));
  const spacing = p('luxun_huoshao', 'spacing', 4);
  const r = p('luxun_huoshao', 'radius', 2.5);
  // the fire never jumps walls: when the host sends the last field (event pos), stop there
  const last = ctx.point && ctx.point.distanceTo(f) <= spacing * (n + 1) ? ctx.point.distanceTo(f) + 0.5 : Infinity;
  for (let i = 0; i < n; i++) {
    const dist = spacing * (0.75 + i);
    if (dist > last) break;
    const g = ground(ctx, f.clone().addScaledVector(d, dist), 0.1);
    ctx.fx.burst(g, { count: 8, tex: PT.flame, color: EMBER, color1: C(0.9, 0.2, 0.04), speed: [1, 3.5], up: 0.9, life: [0.4, 0.8], size: [0.4, 1.1], gravity: -2, radius: r * 0.5, flat: true });
    ctx.fx.fx.ring(g, { color: C(2.4, 0.9, 0.25), radius0: 0.3, radius1: r, life: 0.4, inner: 0.75 });
  }
};

/** 燎原: a fire nova around him — every field he owns flares wider. */
const liaoyuan: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const g = ground(ctx, f);
  ctx.fx.fx.ring(g, { color: EMBER, radius0: 0.5, radius1: 7, life: 0.6, inner: 0.8, alpha: 1.2 });
  ctx.fx.burst(g, { count: 20, tex: PT.flame, color: EMBER, color1: C(0.8, 0.15, 0.03), speed: [3, 7], up: 0.3, life: [0.35, 0.7], size: [0.4, 1], drag: 3, flat: true, radius: 0.8 });
  ctx.fx.lights.flash(g.clone().setY(g.y + 1), C(1, 0.5, 0.2), 12, 14, 0.3);
};

/** 连营: a quick ember flick at his hands as half a magazine slams in. */
const lianying: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (c) ctx.fx.burst(c, { count: 8, tex: PT.spark, color: EMBER, speed: [1.5, 4], life: [0.15, 0.35], size: [0.05, 0.02], stretch: 0.03, radius: 0.2 });
};

// ── 孙尚香 ──────────────────────────────────────────────────────────────────
/** 枭姬: a red-gold rally flare and speed lines as she bounces back. */
const xiaoji: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  ctx.fx.fx.ring(ground(ctx, c), { color: ROYAL_RED, radius0: 0.4, radius1: 3, life: 0.5, inner: 0.8, alpha: 1.1 });
  ctx.fx.burst(c, { count: 12, tex: PT.star, color: GOLD, speed: [1, 3], up: 0.6, life: [0.4, 0.8], size: [0.14, 0.03], spin: 6, radius: 0.4 });
  ctx.fx.burst(c, { count: 8, tex: PT.chevron, color: ROYAL_RED, dir: ctx.dir.clone().negate(), spread: 0.3, speed: [3, 6], life: [0.25, 0.45], size: [0.25, 0.1] });
};

/** 结姻: a ribbon of hearts ties her to her husband; both glow with healing. */
const jieyin: AbilityVfxFn = (ctx) => {
  const a = ctx.srcPos;
  const b = ctx.targetPos ?? ctx.point;
  if (a && b) {
    ctx.fx.beams.beam(a, b, C(2.4, 1.2, 0.7), 0.05, 0.6, 0.8);
    streamAlong(ctx, a, b, 7, CHARM_PINK, PT.heart, 0.16);
  }
  if (a) ctx.fx.heal(a, 100);
  if (b) ctx.fx.heal(b, 100);
};

/** 弓腰姬: the bow snaps — a gold 30° fan flash in front of her. */
const gongyao: AbilityVfxFn = (ctx) => {
  const c = ctx.srcPos;
  if (!c) return;
  const d = flatDir(ctx);
  const fan = p('sunshangxiang_gongyao', 'spread', 30);
  ctx.fx.slash(c.clone().setY(c.y - 0.1), yawOf(d), 5, fan, GOLD);
  ctx.fx.burst(c.clone().addScaledVector(ctx.dir, 0.7), { count: 12, tex: PT.spark, color: GOLD, dir: ctx.dir, spread: 0.3, speed: [5, 10], life: [0.15, 0.3], size: [0.05, 0.02], stretch: 0.04 });
};

const WU_VFX: Record<string, AbilityVfxFn> = {
  sunquan_zhiheng: zhiheng,
  sunquan_zuoduan: zuoduan,
  sunquan_jiuyuan: jiuyuan,
  ganning_qixi: qixi,
  ganning_jieying: jieying,
  lumeng_baiyi: baiyi,
  lumeng_keji: keji,
  lumeng_gongxin: gongxin,
  huanggai_kurou: kurou,
  huanggai_huochuan: huochuan,
  zhouyu_fanjian: fanjian,
  zhouyu_chibi: chibi,
  daqiao_guose: guose,
  daqiao_anxian: anxian,
  daqiao_liuli: liuli,
  luxun_huoshao: huoshao,
  luxun_liaoyuan: liaoyuan,
  luxun_lianying: lianying,
  sunshangxiang_xiaoji: xiaoji,
  sunshangxiang_jieyin: jieyin,
  sunshangxiang_gongyao: gongyao,
};

/** Register the bespoke Wu ability effects (idempotent; replaces built-in flavours). */
export function registerWuAbilityVfx(): void {
  for (const [id, fn] of Object.entries(WU_VFX)) registerAbilityVfx(id, fn);
}

/** Ability ids with a bespoke Wu effect (tests / dev harness). */
export const WU_VFX_IDS: readonly string[] = Object.keys(WU_VFX);
