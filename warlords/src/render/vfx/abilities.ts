// Ability VFX registry. The renderer calls the registered function for every
// { t: 'ability' } event; unknown ids get a kingdom-coloured generic flourish.
// Wave-2 engineers add bespoke effects with registerAbilityVfx(id, fn).
import * as THREE from 'three';
import type { EntityId, GameEvent, ViewEntity } from '../../core/types';
import { PT } from '../core/textures';
import { FX_COLORS, type Effects } from './effects';

export type AbilityEvent = Extract<GameEvent, { t: 'ability' }>;

export interface AbilityVfxContext {
  fx: Effects;
  /** caster view entity (may be missing: out of view / already removed) */
  src: ViewEntity | undefined;
  /** caster chest position */
  srcPos: THREE.Vector3 | null;
  /** muzzle of the caster's held weapon (world; null when none is shown), on demand: where a shot-like ability leaves the barrel */
  muzzle?: () => THREE.Vector3 | null;
  /** target entity chest position, if ev.target is visible */
  targetPos: THREE.Vector3 | null;
  /** ev.pos (or target / caster position fallback) */
  point: THREE.Vector3 | null;
  /** ev.dir normalised, or the caster facing */
  dir: THREE.Vector3;
  /** caster kingdom colour (HDR-boosted) */
  color: THREE.Color;
  localId: EntityId | null;
}

export type AbilityVfxFn = (ctx: AbilityVfxContext, ev: AbilityEvent) => void;

const registry = new Map<string, AbilityVfxFn>();

/** Register (or replace) the VFX for an ability id. Returns an unregister function. */
export function registerAbilityVfx(id: string, fn: AbilityVfxFn): () => void {
  registry.set(id, fn);
  return () => {
    if (registry.get(id) === fn) registry.delete(id);
  };
}

export function getAbilityVfx(id: string): AbilityVfxFn | undefined {
  return registry.get(id);
}

/** Default effect for abilities without a registered VFX. */
export const genericAbilityVfx: AbilityVfxFn = (ctx) => {
  const p = ctx.point ?? ctx.srcPos;
  if (p) ctx.fx.genericAbility(p, ctx.color, 3);
  if (ctx.srcPos && ctx.point && ctx.srcPos.distanceTo(ctx.point) > 2) ctx.fx.genericAbility(ctx.srcPos, ctx.color, 1.5);
};

// ── reusable flavours ───────────────────────────────────────────────────────
const C = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);

const sweep = (color: THREE.Color, arcDeg: number, range: number): AbilityVfxFn => (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const yaw = Math.atan2(-ctx.dir.x, -ctx.dir.z);
  ctx.fx.slash(p.clone().setY(p.y - 0.3), yaw, range, arcDeg, color);
  ctx.fx.slash(p.clone().setY(p.y + 0.1), yaw, range * 0.8, arcDeg * 0.9, C(2, 2, 2));
  ctx.fx.burst(p, { count: 18, tex: PT.glow, color, dir: ctx.dir, spread: 0.9, speed: [3, 8], life: [0.3, 0.6], size: [0.14, 0.04], drag: 3 });
};

const shout = (color: THREE.Color, range: number): AbilityVfxFn => (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const g = p.clone();
  g.y = ctx.fx.groundY(p.x, p.z) + 0.1;
  const yaw = Math.atan2(-ctx.dir.x, -ctx.dir.z);
  ctx.fx.fx.ring(g, { color, radius0: 0.5, radius1: range, life: 0.5, inner: 0.7, arc: 1.0, yaw, alpha: 1.2 });
  ctx.fx.fx.sphere(p, color, 0.5, range * 0.6, 0.35, 0.6);
  ctx.fx.burst(g, { count: 14, tex: PT.dust, color: FX_COLORS.dust, dir: ctx.dir, spread: 0.6, speed: [4, 9], life: [0.5, 1], size: [0.5, 1.6], additive: false, alpha: 0.6, drag: 2, flat: true });
  ctx.fx.shakeAt(p, 0.25, range);
};

const healFlavour: AbilityVfxFn = (ctx) => {
  const p = ctx.targetPos ?? ctx.point ?? ctx.srcPos;
  if (p) ctx.fx.heal(p, 120);
  if (ctx.srcPos && p !== ctx.srcPos) ctx.fx.sparkle(ctx.srcPos, FX_COLORS.heal, 8);
};

const lightningFlavour: AbilityVfxFn = (ctx) => {
  if (ctx.srcPos) {
    ctx.fx.burst(ctx.srcPos.clone().setY(ctx.srcPos.y + 0.6), { count: 12, tex: PT.spark, color: FX_COLORS.thunder, speed: [2, 6], life: [0.2, 0.4], size: [0.05, 0.02], stretch: 0.04 });
    ctx.fx.lights.flash(ctx.srcPos, C(0.5, 0.7, 1), 8, 10, 0.2);
  }
  const p = ctx.point ?? ctx.targetPos;
  if (p) ctx.fx.fx.ring(p.clone().setY(ctx.fx.groundY(p.x, p.z) + 0.1), { color: FX_COLORS.thunder, radius0: 0.5, radius1: 4, life: 0.8, inner: 0.9 });
};

const fireFlavour: AbilityVfxFn = (ctx) => {
  const p = ctx.point ?? ctx.srcPos;
  if (!p) return;
  ctx.fx.burst(p, { count: 20, tex: PT.flame, color: FX_COLORS.fire, color1: C(0.7, 0.1, 0), speed: [1, 4], up: 0.8, life: [0.4, 0.9], size: [0.4, 1.2], radius: 1.5, drag: 2, gravity: -2 });
  ctx.fx.fx.ring(p.clone().setY(ctx.fx.groundY(p.x, p.z) + 0.1), { color: C(2, 0.7, 0.2), radius0: 0.5, radius1: 4, life: 0.6, inner: 0.8 });
};

const charmFlavour: AbilityVfxFn = (ctx) => {
  const p = ctx.targetPos ?? ctx.point;
  if (ctx.srcPos && p) ctx.fx.beams.beam(ctx.srcPos, p, C(2.2, 0.6, 1.2), 0.08, 0.5, 0.8);
  if (p) ctx.fx.burst(p, { count: 10, tex: PT.heart, color: C(2.2, 0.6, 1.0), speed: [0.5, 2], up: 0.8, life: [0.8, 1.3], size: [0.2, 0.12], gravity: -1 });
};

const danceFlavour: AbilityVfxFn = (ctx) => {
  const p = ctx.targetPos ?? ctx.point;
  if (p) ctx.fx.burst(p, { count: 10, tex: PT.note, color: C(2, 1.6, 0.6), speed: [0.5, 2], up: 0.8, life: [0.8, 1.3], size: [0.22, 0.14], gravity: -1, spin: 3 });
};

const stealthFlavour: AbilityVfxFn = (ctx) => {
  const p = ctx.srcPos;
  if (p) ctx.fx.burst(p, { count: 14, tex: PT.smoke, color: C(0.55, 0.6, 0.62), speed: [0.5, 2], life: [0.8, 1.4], size: [0.6, 1.8], additive: false, alpha: 0.55, drag: 2, radius: 0.5 });
};

const dashFlavour = (color: THREE.Color): AbilityVfxFn => (ctx) => {
  const p = ctx.srcPos;
  if (!p) return;
  const end = ctx.point ?? p.clone().addScaledVector(ctx.dir, 8);
  ctx.fx.beams.beam(p, end, color, 0.5, 0.35, 0.6);
  ctx.fx.burst(p, { count: 16, tex: PT.dust, color: FX_COLORS.dust, dir: ctx.dir.clone().negate(), spread: 0.5, speed: [2, 5], life: [0.4, 0.8], size: [0.4, 1.2], additive: false, alpha: 0.5, drag: 2 });
};

const slamFlavour: AbilityVfxFn = (ctx) => {
  const p = ctx.point ?? ctx.srcPos;
  if (!p) return;
  ctx.fx.explosion(p, 3, 'frag');
  ctx.fx.fx.ring(p.clone().setY(ctx.fx.groundY(p.x, p.z) + 0.1), { color: ctx.color, radius0: 1, radius1: 6, life: 0.6, inner: 0.85 });
};

const baguaFlavour: AbilityVfxFn = (ctx) => {
  const p = ctx.point ?? ctx.srcPos;
  if (!p) return;
  ctx.fx.burst(p.clone().setY(ctx.fx.groundY(p.x, p.z) + 0.15), { count: 1, tex: PT.bagua, color: C(1.6, 1.3, 0.6), speed: [0, 0], life: [1.2, 1.4], size: [7, 7.5], alpha: 0.9, spin: 0.6 });
  ctx.fx.genericAbility(p, C(1.6, 1.3, 0.6), 7);
};

const shieldFlavour = (color: THREE.Color): AbilityVfxFn => (ctx) => {
  const p = ctx.targetPos ?? ctx.srcPos;
  if (p) ctx.fx.fx.sphere(p, color, 0.4, 1.4, 0.5, 1);
};

const BUILTIN: Record<string, AbilityVfxFn> = {
  guanyu_qinglong: sweep(C(0.5, 2.2, 0.9), 110, 4.5),
  lubu_fangtian: sweep(C(2.4, 0.5, 0.3), 359, 5),
  zhangfei_paoxiao: shout(C(2.2, 0.8, 0.3), 8),
  zhangfei_duanqiao: shout(C(2.2, 0.6, 0.3), 9),
  zhangliao_weizhen: shout(C(0.5, 0.8, 2.2), 10),
  xuchu_slam: slamFlavour,
  menghuo_xiangbing: slamFlavour,
  zhugeliang_bazhen: baguaFlavour,
  zhugeliang_kongcheng: shieldFlavour(C(2, 1.6, 0.6)),
  zhaoyun_qijin: dashFlavour(C(1.6, 1.8, 2.2)),
  zhaoyun_jiuzhu: shieldFlavour(C(0.6, 1.2, 2.4)),
  machao_charge: dashFlavour(C(1.6, 1.6, 1.8)),
  xiahoudun_charge: dashFlavour(C(0.6, 0.9, 2.2)),
  zhangliao_tuxi: dashFlavour(C(0.6, 0.9, 2.2)),
  xiahouyuan_shensu: dashFlavour(C(0.8, 1.0, 2.2)),
  zhenji_lingbo: (ctx) => {
    const p = ctx.point ?? ctx.srcPos;
    if (p) ctx.fx.explosion(p, 3, 'ice');
  },
  zhangjiao_leiji: lightningFlavour,
  zhangjiao_taiping: lightningFlavour,
  zhouyu_chibi: fireFlavour,
  luxun_huoshao: fireFlavour,
  luxun_liaoyuan: fireFlavour,
  huanggai_huochuan: fireFlavour,
  huanggai_kurou: fireFlavour,
  huatuo_qingnang: healFlavour,
  daqiao_anxian: healFlavour,
  liubei_rende: healFlavour,
  caocao_wangmei: healFlavour,
  huangzhong_laodang: healFlavour,
  sunshangxiang_jieyin: healFlavour,
  diaochan_lijian: charmFlavour,
  zhouyu_fanjian: charmFlavour,
  daqiao_guose: danceFlavour,
  ganning_jieying: stealthFlavour,
  lumeng_baiyi: stealthFlavour,
  simayi_guicai: shieldFlavour(C(1.4, 0.6, 2.2)),
  caocao_jianxiong: shieldFlavour(C(0.6, 0.9, 2.2)),
};
for (const [id, fn] of Object.entries(BUILTIN)) registry.set(id, fn);
