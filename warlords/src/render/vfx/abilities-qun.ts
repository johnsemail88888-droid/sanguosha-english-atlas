// Bespoke VFX for the 群 Qun abilities (华佗 吕布 貂蝉 张角 袁绍 孟获).
// The integrator calls registerQunAbilityVfx() once, after the renderer's
// built-in table (each entry replaces the generic / built-in flavour).
//
// These draw the *cast*. The sim emits the follow-up visuals itself: each
// 雷击 / 太平要术 bolt is a 'thunder' explosion event, 方天画戟 a 360° 'melee'
// event, 辕门射戟 a 'shot' event, 麻沸散's impact a 'gas' explosion, and the
// storm cloud / arrow rain / gas are hazard entities with their own look.
import * as THREE from 'three';
import { ABILITY_BY_ID } from '../../data';
import { PT } from '../core/textures';
import { registerAbilityVfx, type AbilityVfxContext, type AbilityVfxFn } from './abilities';
import { FX_COLORS } from './effects';

const C = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);

const PINK = C(2.4, 0.55, 1.2);
const VIOLET = C(1.3, 0.7, 2.4);
const IRON = C(0.9, 0.9, 1.1);
const HALBERD_RED = C(2.6, 0.35, 0.2);
const GOLD = C(2.2, 1.6, 0.45);
const YELLOW_TURBAN = C(2.4, 1.9, 0.3);
const HERB = C(0.45, 1.9, 0.8);
const GAS = C(0.55, 1.0, 0.35);
const EARTH = C(1.6, 0.8, 0.35);
const EMBER = C(2.6, 0.9, 0.2);

/** Ground-level copy of a point (+ lift). */
function ground(ctx: AbilityVfxContext, p: THREE.Vector3, lift = 0.08): THREE.Vector3 {
  return new THREE.Vector3(p.x, ctx.fx.groundY(p.x, p.z) + lift, p.z);
}

/** Caster feet position (view entity), falling back to the chest anchor. */
function feet(ctx: AbilityVfxContext): THREE.Vector3 | null {
  if (ctx.src) return new THREE.Vector3(ctx.src.x, ctx.src.y, ctx.src.z);
  return ctx.srcPos ? ctx.srcPos.clone().setY(ctx.srcPos.y - 1) : null;
}

/**
 * The effect point clamped to the ability's range from the caster: until the
 * host sends the resolved point, the event carries the raw crosshair point,
 * which may lie beyond where a range-limited point ability actually lands.
 */
function landing(ctx: AbilityVfxContext, abilityId: string): THREE.Vector3 | null {
  const p = ctx.point;
  const f = feet(ctx);
  if (!p) return null;
  const range = ABILITY_BY_ID[abilityId]?.params.range;
  if (!f || range === undefined) return p.clone();
  const dx = p.x - f.x;
  const dz = p.z - f.z;
  const d = Math.hypot(dx, dz);
  if (d <= range || d < 1e-3) return p.clone();
  const x = f.x + (dx / d) * range;
  const z = f.z + (dz / d) * range;
  return new THREE.Vector3(x, ctx.fx.groundY(x, z), z);
}

// ── 华佗 ────────────────────────────────────────────────────────────────────
/** 急救: a quick green-cross pulse on the rescued hero. */
const jijiu: AbilityVfxFn = (ctx) => {
  const p = ctx.targetPos ?? ctx.point ?? ctx.srcPos;
  if (!p) return;
  const g = ground(ctx, p);
  ctx.fx.fx.pillar(g, HERB, 0.6, 3.2, 0.7, 0.8);
  ctx.fx.fx.ring(g, { color: HERB, radius0: 0.3, radius1: 2.2, life: 0.6, inner: 0.8 });
  ctx.fx.heal(p, 180);
  ctx.fx.burst(p, { count: 8, tex: PT.star, color: C(2, 2, 1.6), speed: [0.5, 2], up: 0.9, life: [0.6, 1], size: [0.14, 0.03], gravity: -1 });
};

/** 青囊: a herb-green tether to the patient, leaves swirling up and a cleansing flash. */
const qingnang: AbilityVfxFn = (ctx) => {
  const p = ctx.targetPos ?? ctx.srcPos;
  if (!p) return;
  if (ctx.srcPos && ctx.srcPos.distanceTo(p) > 1) ctx.fx.beams.beam(ctx.srcPos, p, HERB, 0.07, 0.5, 0.9);
  ctx.fx.heal(p, 150);
  ctx.fx.burst(p, { count: 14, tex: PT.petal, color: HERB, color1: C(0.9, 1.6, 0.5), speed: [0.8, 2.2], up: 1, life: [1.2, 2.2], size: [0.14, 0.08], gravity: -0.6, spin: 5, radius: 0.6 });
  ctx.fx.burst(p, { count: 10, tex: PT.star, color: C(2.2, 2.2, 2), speed: [2, 5], life: [0.3, 0.5], size: [0.12, 0.02] });
  ctx.fx.lights.flash(p, C(0.5, 1, 0.6), 6, 8, 0.35);
};

/** 麻沸散: the throw puff + a faint warning ring where the flask will burst. */
const mafei: AbilityVfxFn = (ctx) => {
  if (ctx.srcPos) ctx.fx.burst(ctx.srcPos, { count: 5, tex: PT.smoke, color: GAS, dir: ctx.dir, spread: 0.4, speed: [1, 3], life: [0.4, 0.8], size: [0.2, 0.6], additive: false, alpha: 0.45, drag: 2 });
  const p = landing(ctx, 'huatuo_mafei');
  if (!p) return;
  const radius = ABILITY_BY_ID.huatuo_mafei?.params.radius ?? 5;
  ctx.fx.fx.ring(ground(ctx, p), { color: GAS, radius0: radius * 0.9, radius1: radius, life: 0.9, inner: 0.9, alpha: 0.5 });
};

// ── 吕布 ────────────────────────────────────────────────────────────────────
/** 方天画戟: a blood-red spinning halberd ring with a golden edge and a dust shockwave. */
const fangtian: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const radius = ABILITY_BY_ID.lubu_fangtian?.params.radius ?? 5;
  const yaw = Math.atan2(-ctx.dir.x, -ctx.dir.z);
  const chest = p.clone().setY(p.y - 0.2);
  // two counter-rotated full sweeps: red body + white-gold edge
  ctx.fx.fx.ring(chest, { color: HALBERD_RED, radius0: radius * 0.3, radius1: radius, life: 0.3, inner: 0.55, innerEnd: 0.82, alpha: 1.3, soft: 0.2, yaw });
  ctx.fx.fx.ring(chest.clone().setY(chest.y + 0.25), { color: GOLD, radius0: radius * 0.5, radius1: radius * 1.05, life: 0.22, inner: 0.9, alpha: 1.1, yaw: yaw + Math.PI });
  const g = ground(ctx, p);
  ctx.fx.fx.ring(g, { color: C(1.4, 0.35, 0.2), radius0: 0.5, radius1: radius + 1, life: 0.5, inner: 0.85 });
  ctx.fx.burst(g, { count: 22, tex: PT.dust, color: FX_COLORS.dust, speed: [4, 9], life: [0.5, 1], size: [0.5, 1.8], additive: false, alpha: 0.55, drag: 2.5, flat: true, radius: 1 });
  ctx.fx.burst(chest, { count: 24, tex: PT.spark, color: HALBERD_RED, color1: GOLD, speed: [6, 12], life: [0.2, 0.45], size: [0.07, 0.02], stretch: 0.04, radius: radius * 0.6, flat: true });
  ctx.fx.shakeAt(p, 0.35, radius * 2);
};

/** 辕门射戟: a golden muzzle bloom and a heavy lingering streak to the impact. */
const sheji: AbilityVfxFn = (ctx) => {
  const from = ctx.srcPos;
  if (!from) return;
  const to = ctx.point ?? from.clone().addScaledVector(ctx.dir, 120);
  const muzzle = from.clone().addScaledVector(ctx.dir, 0.9);
  ctx.fx.burst(muzzle, { count: 1, tex: PT.star, color: GOLD, speed: [0, 0], life: [0.12, 0.16], size: [1.2, 0.4] });
  ctx.fx.burst(muzzle, { count: 10, tex: PT.spark, color: GOLD, dir: ctx.dir, spread: 0.15, speed: [8, 16], life: [0.1, 0.25], size: [0.05, 0.02], stretch: 0.04 });
  ctx.fx.beams.beam(muzzle, to, GOLD, 0.09, 0.45, 0.9);
  ctx.fx.beams.tracer(muzzle, to, C(2.6, 2.2, 1.4), 0.12, 600, 16);
  ctx.fx.burst(to, { count: 12, tex: PT.spark, color: GOLD, speed: [3, 9], life: [0.2, 0.4], size: [0.06, 0.02], stretch: 0.03 });
  ctx.fx.lights.flash(muzzle, C(1, 0.8, 0.4), 6, 10, 0.12);
};

// ── 貂蝉 ────────────────────────────────────────────────────────────────────
/** 离间: pink tether caster → target, and target ⇄ the hero it is turned on (event pos). */
const lijian: AbilityVfxFn = (ctx) => {
  const a = ctx.targetPos;
  if (ctx.srcPos && a) ctx.fx.beams.beam(ctx.srcPos, a, PINK, 0.05, 0.5, 0.7);
  const hearts = (p: THREE.Vector3): void =>
    ctx.fx.burst(p, { count: 9, tex: PT.heart, color: PINK, speed: [0.5, 2], up: 0.8, life: [0.9, 1.4], size: [0.22, 0.12], gravity: -1 });
  if (a) hearts(a);
  const b = ctx.point;
  if (a && b && a.distanceTo(b) > 1.5) {
    ctx.fx.beams.beam(a, b, PINK, 0.1, 1.2, 1);
    ctx.fx.beams.beam(a, b, C(2.4, 2, 2.2), 0.03, 1.0, 0.8);
    hearts(b);
  }
};

/** 连环计: iron-violet chain links flung at the target, then a ring marking the 8 m chain zone. */
const lianhuan: AbilityVfxFn = (ctx) => {
  const t = ctx.targetPos ?? ctx.point;
  if (!t) return;
  if (ctx.srcPos) {
    const d = t.clone().sub(ctx.srcPos);
    const n = Math.max(4, Math.min(14, Math.round(d.length() / 2)));
    for (let i = 0; i < n; i++) {
      const p = ctx.srcPos.clone().addScaledVector(d, (i + 0.5) / n);
      ctx.fx.burst(p, { count: 1, tex: PT.ring, color: i % 2 ? VIOLET : IRON, speed: [0, 0.2], life: [0.6, 0.8], size: [0.22, 0.16], spin: 2 });
    }
  }
  const radius = ABILITY_BY_ID.diaochan_lianhuan?.params.radius ?? 8;
  ctx.fx.fx.ring(ground(ctx, t), { color: VIOLET, radius0: 0.5, radius1: radius, life: 0.7, inner: 0.93, alpha: 0.8 });
  ctx.fx.burst(t, { count: 12, tex: PT.chevron, color: VIOLET, speed: [1, 3], life: [0.5, 0.9], size: [0.18, 0.1], spin: 4 });
};

// ── 张角 ────────────────────────────────────────────────────────────────────
/** 雷击: the staff calls the sky (bolt up from the caster) and marks the strike circle. */
const leiji: AbilityVfxFn = (ctx) => {
  if (ctx.srcPos) {
    const top = ctx.srcPos.clone().add(new THREE.Vector3(0, 14, 0));
    ctx.fx.beams.lightning(ctx.srcPos.clone().setY(ctx.srcPos.y + 0.8), top, FX_COLORS.thunder, 0.18, 0.3);
    ctx.fx.lights.flash(ctx.srcPos, C(0.5, 0.7, 1), 8, 10, 0.2);
  }
  const p = landing(ctx, 'zhangjiao_leiji');
  if (!p) return;
  const params = ABILITY_BY_ID.zhangjiao_leiji?.params;
  const radius = params?.radius ?? 3;
  const span = (params?.bolts ?? 3) * (params?.interval ?? 0.6);
  const g = ground(ctx, p);
  ctx.fx.fx.ring(g, { color: FX_COLORS.thunder, radius0: radius, radius1: radius, life: span, inner: 0.9, alpha: 0.7 });
  ctx.fx.burst(g, { count: 10, tex: PT.spark, color: FX_COLORS.thunder, speed: [1, 3], life: [0.3, 0.7], size: [0.05, 0.02], radius, flat: true, stretch: 0.03 });
};

/** 太平要术: a jagged arc from the staff to the cursed target and a dark swirl gathering over it. */
const taiping: AbilityVfxFn = (ctx) => {
  const t = ctx.targetPos ?? ctx.point;
  if (!t) return;
  if (ctx.srcPos) {
    const d = t.clone().sub(ctx.srcPos);
    const segs = Math.max(4, Math.min(12, Math.round(d.length() / 3)));
    let prev = ctx.srcPos.clone();
    for (let i = 1; i <= segs; i++) {
      const p = ctx.srcPos.clone().addScaledVector(d, i / segs);
      if (i < segs) p.add(new THREE.Vector3((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2));
      ctx.fx.beams.beam(prev, p, FX_COLORS.thunder, 0.12, 0.25);
      prev = p;
    }
  }
  const sky = t.clone().setY(t.y + 5);
  ctx.fx.burst(sky, { count: 12, tex: PT.smoke, color: C(0.18, 0.2, 0.28), speed: [0.5, 1.5], life: [1.2, 2], size: [1.2, 3], additive: false, alpha: 0.7, radius: 1.5, drag: 1 });
  ctx.fx.burst(t, { count: 12, tex: PT.spark, color: FX_COLORS.thunder, speed: [2, 6], life: [0.2, 0.4], size: [0.05, 0.02], stretch: 0.04 });
};

/** 黄天: a golden heaven-pillar and a wide turban-yellow ring as the warriors rise. */
const huangtian: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const g = ground(ctx, f);
  ctx.fx.fx.pillar(g, YELLOW_TURBAN, 1.2, 16, 1.2, 0.9);
  ctx.fx.fx.ring(g, { color: YELLOW_TURBAN, radius0: 1, radius1: 9, life: 0.9, inner: 0.85, alpha: 1.2 });
  ctx.fx.fx.ring(g, { color: C(2, 1.2, 0.3), radius0: 0.5, radius1: 5, life: 0.6, inner: 0.7 });
  ctx.fx.burst(g.clone().setY(g.y + 1), { count: 30, tex: PT.glow, color: YELLOW_TURBAN, color1: GOLD, speed: [1, 5], up: 0.9, life: [0.8, 1.6], size: [0.18, 0.04], gravity: -1.5, radius: 3 });
  ctx.fx.lights.flash(g.clone().setY(g.y + 3), C(1, 0.85, 0.3), 14, 20, 0.6);
  ctx.fx.shakeAt(g, 0.3, 12);
};

// ── 袁绍 ────────────────────────────────────────────────────────────────────
/** 乱击: arrows loosed skyward around the caster and a gold ring on the killing ground. */
const luanji: AbilityVfxFn = (ctx) => {
  const src = ctx.srcPos;
  if (src) {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const from = src.clone().add(new THREE.Vector3(Math.cos(a) * 1.2, 0.3, Math.sin(a) * 1.2));
      const to = from.clone().add(new THREE.Vector3(ctx.dir.x * 6, 18, ctx.dir.z * 6));
      ctx.fx.beams.tracer(from, to, C(0.95, 0.85, 0.65), 0.03, 90, 2.5, 0.8);
    }
  }
  const p = landing(ctx, 'yuanshao_luanji');
  if (!p) return;
  const radius = ABILITY_BY_ID.yuanshao_luanji?.params.radius ?? 10;
  ctx.fx.fx.ring(ground(ctx, p), { color: GOLD, radius0: radius * 0.4, radius1: radius, life: 0.8, inner: 0.94, alpha: 0.9 });
};

/** 四世三公: noble gold banner flash around Yuan Shao as the crossbowmen muster. */
const sishi: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const g = ground(ctx, f);
  ctx.fx.fx.ring(g, { color: GOLD, radius0: 0.5, radius1: 4, life: 0.7, inner: 0.8 });
  ctx.fx.burst(g.clone().setY(g.y + 1.2), { count: 16, tex: PT.star, color: GOLD, speed: [1, 3], up: 0.8, life: [0.6, 1.1], size: [0.14, 0.03], gravity: -0.5, radius: 2.5 });
};

// ── 孟获 ────────────────────────────────────────────────────────────────────
/** 再起: the Nanman king roars back up in a burst of embers. */
const zaiqi: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const g = ground(ctx, f);
  ctx.fx.fx.pillar(g, EMBER, 0.9, 6, 0.8, 0.9);
  ctx.fx.fx.ring(g, { color: EMBER, radius0: 0.5, radius1: 6, life: 0.6, inner: 0.8, alpha: 1.2 });
  ctx.fx.burst(g.clone().setY(g.y + 1), { count: 26, tex: PT.flame, color: EMBER, color1: C(0.8, 0.15, 0.02), speed: [2, 6], up: 0.8, life: [0.4, 0.9], size: [0.3, 0.9], gravity: -2, drag: 2, radius: 0.8 });
  ctx.fx.lights.flash(g.clone().setY(g.y + 1.5), C(1, 0.5, 0.2), 14, 14, 0.5);
  ctx.fx.shakeAt(g, 0.35, 10);
};

/** 南蛮入侵: war-horn shock rings rolling out from Meng Huo, dust kicked up toward the target. */
const nanman: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const g = ground(ctx, f);
  ctx.fx.fx.ring(g, { color: EARTH, radius0: 0.5, radius1: 8, life: 0.45, inner: 0.9, alpha: 1.3 });
  ctx.fx.fx.ring(g, { color: C(1.9, 1.1, 0.4), radius0: 0.5, radius1: 13, life: 0.8, inner: 0.95, alpha: 0.9 });
  ctx.fx.fx.ring(g, { color: C(1.2, 0.5, 0.2), radius0: 0.5, radius1: 18, life: 1.2, inner: 0.97, alpha: 0.6 });
  ctx.fx.burst(g, { count: 24, tex: PT.dust, color: FX_COLORS.dust, dir: ctx.dir, spread: 0.6, speed: [3, 8], life: [0.6, 1.2], size: [0.6, 2], additive: false, alpha: 0.55, drag: 2, flat: true, radius: 1.5 });
  ctx.fx.shakeAt(g, 0.3, 16);
  const p = landing(ctx, 'menghuo_nanman');
  if (p) ctx.fx.fx.ring(ground(ctx, p), { color: EARTH, radius0: 0.5, radius1: 3, life: 1, inner: 0.85, alpha: 0.7 });
};

/** 象兵: trumpet blast and a dust wake down the charge lane. */
const xiangbing: AbilityVfxFn = (ctx) => {
  const f = feet(ctx);
  if (!f) return;
  const g = ground(ctx, f);
  const len = ABILITY_BY_ID.menghuo_xiangbing?.params.distance ?? 30;
  const dir = new THREE.Vector3(ctx.dir.x, 0, ctx.dir.z);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  dir.normalize();
  for (let i = 1; i <= 6; i++) {
    const p = g.clone().addScaledVector(dir, (i / 6) * len);
    p.y = ctx.fx.groundY(p.x, p.z) + 0.1;
    ctx.fx.burst(p, { count: 4, tex: PT.dust, color: FX_COLORS.dust, speed: [1, 3], up: 0.4, life: [0.8, 1.4], size: [0.8, 2.4], additive: false, alpha: 0.45, drag: 1.5, flat: true, radius: 1.2 });
  }
  ctx.fx.fx.ring(g, { color: EARTH, radius0: 0.5, radius1: 6, life: 0.5, inner: 0.85 });
  ctx.fx.shakeAt(g, 0.4, 14);
};

const QUN_VFX: Record<string, AbilityVfxFn> = {
  huatuo_jijiu: jijiu,
  huatuo_qingnang: qingnang,
  huatuo_mafei: mafei,
  lubu_fangtian: fangtian,
  lubu_sheji: sheji,
  diaochan_lijian: lijian,
  diaochan_lianhuan: lianhuan,
  zhangjiao_leiji: leiji,
  zhangjiao_taiping: taiping,
  zhangjiao_huangtian: huangtian,
  yuanshao_luanji: luanji,
  yuanshao_sishi: sishi,
  menghuo_zaiqi: zaiqi,
  menghuo_nanman: nanman,
  menghuo_xiangbing: xiangbing,
};

/** Register (or re-register: idempotent) every Qun ability VFX. */
export function registerQunAbilityVfx(): void {
  for (const [id, fn] of Object.entries(QUN_VFX)) registerAbilityVfx(id, fn);
}
