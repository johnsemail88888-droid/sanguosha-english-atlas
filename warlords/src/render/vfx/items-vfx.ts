// Bespoke VFX for playing 三国杀 cards (items). One flourish per card at the
// moment it is used ({ t: 'itemUse' }); what the card leaves behind (grenades,
// fields, traps, clouds, summons) is drawn by its own entities / explosions.
// Registered by registerAll.ts (export name must match /^register\w*Vfx$/).
import * as THREE from 'three';
import { PT, type ParticleTex } from '../core/textures';
import { FX_COLORS } from './effects';
import { setItemVfx, type ItemVfxContext, type ItemVfxFn } from './itemRegistry';

const C = (r: number, g: number, b: number): THREE.Color => new THREE.Color(r, g, b);
const PEACH = C(2.2, 0.9, 1.1);
const WINE = C(2.4, 0.5, 0.2);
const GOLD = FX_COLORS.gold;
const STEEL = C(1.3, 1.4, 1.6);

const ground = (ctx: ItemVfxContext, p: THREE.Vector3): THREE.Vector3 => p.clone().setY(ctx.fx.groundY(p.x, p.z) + 0.08);

/** A tether / rope between the user and the target (steal, duel, chains, hack). */
const tether = (color: THREE.Color, width: number, life: number, burstTex: ParticleTex = PT.star) => (ctx: ItemVfxContext): void => {
  const a = ctx.userPos;
  const b = ctx.targetPos ?? ctx.point;
  if (a && b) ctx.fx.beams.beam(a, b, color, width, life, 1);
  if (b) ctx.fx.burst(b, { count: 12, tex: burstTex, color, speed: [0.8, 3], up: 0.5, life: [0.4, 0.8], size: [0.14, 0.04], gravity: -0.5, spin: 4, radius: 0.3 });
  if (a) ctx.fx.sparkle(a, color, 6);
};

const ITEMS: Record<string, ItemVfxFn> = {
  // 杀: ammo box — brass casings and a gold glint
  sha: (ctx) => {
    const p = ctx.userPos;
    if (!p) return;
    ctx.fx.burst(p, { count: 10, tex: PT.square, color: C(1.8, 1.3, 0.45), speed: [1.5, 3.5], up: 0.8, life: [0.5, 0.8], size: [0.06, 0.05], gravity: 12, additive: false, spin: 12 });
    ctx.fx.sparkle(p, GOLD, 8);
  },
  // 闪: +1 dodge — pale blue afterimage ring at the feet
  shan: (ctx) => {
    const p = ctx.userPos;
    if (!p) return;
    const g = ground(ctx, p);
    ctx.fx.fx.ring(g, { color: C(0.8, 1.3, 2.2), radius0: 0.3, radius1: 1.6, life: 0.5, inner: 0.85, alpha: 1 });
    ctx.fx.burst(p, { count: 14, tex: PT.glow, color: C(0.7, 1.2, 2.2), speed: [1, 3], up: 0.2, life: [0.3, 0.6], size: [0.1, 0.03], drag: 3, radius: 0.4 });
  },
  // 桃: heal / revive — peach blossoms, green motes, a rope of light to the patient
  tao: (ctx) => {
    const t = ctx.targetPos ?? ctx.userPos;
    if (!t) return;
    ctx.fx.heal(t, 150);
    ctx.fx.burst(t, { count: 14, tex: PT.petal, color: PEACH, speed: [0.6, 2], up: 0.9, life: [1, 1.6], size: [0.14, 0.09], gravity: -0.6, spin: 5, radius: 0.5 });
    if (ctx.userPos && ctx.targetPos && ctx.userPos.distanceTo(ctx.targetPos) > 0.8) ctx.fx.beams.beam(ctx.userPos, ctx.targetPos, FX_COLORS.heal, 0.06, 0.6, 0.8);
  },
  // 酒: next hit ×2 / self-revive — a warm flare
  jiu: (ctx) => {
    const p = ctx.userPos;
    if (!p) return;
    ctx.fx.burst(p, { count: 16, tex: PT.flame, color: WINE, color1: C(0.8, 0.15, 0.05), speed: [0.5, 2], up: 0.9, life: [0.4, 0.8], size: [0.25, 0.5], gravity: -2, radius: 0.35 });
    ctx.fx.fx.ring(ground(ctx, p), { color: WINE, radius0: 0.3, radius1: 1.4, life: 0.5, inner: 0.8, alpha: 0.9 });
    ctx.fx.lights.flash(p, C(1, 0.4, 0.15), 6, 8, 0.3);
  },
  // 无中生有: two cards out of nothing — golden card shower
  wuzhong: (ctx) => {
    const p = ctx.userPos;
    if (!p) return;
    ctx.fx.burst(p.clone().setY(p.y + 0.6), { count: 12, tex: PT.square, color: GOLD, speed: [1.5, 3.5], up: 1, life: [0.7, 1.1], size: [0.16, 0.12], gravity: 3, spin: 8 });
    ctx.fx.sparkle(p, GOLD, 14);
  },
  // 过河拆桥: EMP grenade thrown (the pulse itself is the 'emp' explosion)
  guohe: (ctx) => {
    const p = ctx.userPos;
    if (p) ctx.fx.burst(p, { count: 10, tex: PT.spark, color: C(0.9, 1.4, 2.8), speed: [2, 5], life: [0.15, 0.3], size: [0.04, 0.02], stretch: 0.04 });
  },
  // 顺手牵羊: grapple — golden rope to the victim
  shunshou: tether(GOLD, 0.05, 0.45),
  // 决斗: tether duel — blood-red bond and rings on both
  juedou: (ctx) => {
    const red = C(2.4, 0.3, 0.2);
    tether(red, 0.09, 0.9)(ctx);
    for (const p of [ctx.userPos, ctx.targetPos]) if (p) ctx.fx.fx.ring(ground(ctx, p), { color: red, radius0: 0.4, radius1: 1.3, life: 0.7, inner: 0.8, alpha: 1.1 });
  },
  // 借刀杀人: hack their troops — violet signal
  jiedao: (ctx) => {
    const violet = C(1.6, 0.5, 2.2);
    tether(violet, 0.05, 0.6, PT.glow)(ctx);
    const t = ctx.targetPos ?? ctx.point;
    if (t) ctx.fx.fx.ring(ground(ctx, t), { color: violet, radius0: 0.5, radius1: 4, life: 0.6, inner: 0.9 });
  },
  // 无懈可击: nullify — golden bagua ward
  wuxie: (ctx) => {
    const p = ctx.userPos;
    if (!p) return;
    ctx.fx.fx.sphere(p, C(2, 1.7, 0.8), 0.4, 1.3, 0.6, 0.8);
    ctx.fx.burst(ground(ctx, p).setY(ground(ctx, p).y + 0.05), { count: 1, tex: PT.bagua, color: C(2, 1.7, 0.8), speed: [0, 0], life: [0.8, 0.9], size: [2.6, 3.2], alpha: 0.9, spin: 1.5 });
  },
  // 南蛮入侵: war horn — brown shock ring + dust
  nanman: (ctx) => {
    const p = ctx.userPos ?? ctx.point;
    if (!p) return;
    const g = ground(ctx, p);
    ctx.fx.fx.ring(g, { color: C(1.6, 0.9, 0.4), radius0: 0.5, radius1: 7, life: 0.7, inner: 0.9, alpha: 1 });
    ctx.fx.burst(g, { count: 14, tex: PT.dust, color: FX_COLORS.dust, speed: [3, 7], life: [0.6, 1.1], size: [0.5, 1.6], additive: false, alpha: 0.55, drag: 2.5, flat: true });
    ctx.fx.shakeAt(p, 0.2, 6);
  },
  // 万箭齐发: the volley goes up (the rain is the hazard)
  wanjian: (ctx) => {
    const a = ctx.userPos;
    const b = ctx.point;
    if (a) {
      for (let i = 0; i < 6; i++) {
        const up = a.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 14 + Math.random() * 6, (Math.random() - 0.5) * 3));
        ctx.fx.beams.tracer(a, up, C(1.8, 1.4, 0.8), 0.04, 60, 3, 0.9);
      }
    }
    if (b) ctx.fx.fx.ring(ground(ctx, b), { color: C(2.2, 0.6, 0.3), radius0: 1, radius1: 8, life: 1.2, inner: 0.93, alpha: 1 });
  },
  // 桃园结义: blossoms for everyone within 15 m (the heal burst is its own 'heal' explosion)
  taoyuan: (ctx) => {
    const p = ctx.userPos ?? ctx.point;
    if (!p) return;
    ctx.fx.burst(p.clone().setY(p.y + 1), { count: 40, tex: PT.petal, color: PEACH, color1: C(2, 1.6, 1.4), speed: [2, 7], up: 0.6, life: [1.4, 2.4], size: [0.16, 0.1], gravity: -0.2, drag: 1.2, spin: 4, radius: 1 });
    ctx.fx.fx.ring(ground(ctx, p), { color: PEACH, radius0: 1, radius1: 15, life: 1.1, inner: 0.95, alpha: 0.9 });
  },
  // 五谷丰登: a harvest burst
  wugu: (ctx) => {
    const p = ctx.userPos;
    if (!p) return;
    ctx.fx.burst(p.clone().setY(p.y + 0.4), { count: 26, tex: PT.petal, color: C(2, 1.6, 0.4), color1: C(1.2, 1.4, 0.3), speed: [2, 5], up: 0.8, life: [0.8, 1.3], size: [0.1, 0.07], gravity: 6, spin: 6 });
    ctx.fx.fx.ring(ground(ctx, p), { color: GOLD, radius0: 0.4, radius1: 4, life: 0.6, inner: 0.85 });
  },
  // 火攻: incendiary grenade thrown — ember spark at the hand
  huogong: (ctx) => {
    const p = ctx.userPos;
    if (p) ctx.fx.burst(p, { count: 10, tex: PT.flame, color: FX_COLORS.fire, speed: [1, 3], up: 0.6, life: [0.25, 0.5], size: [0.15, 0.3], gravity: -1 });
  },
  // 铁索连环: iron chains — steel links to the target
  tiesuo: tether(STEEL, 0.07, 0.8, PT.square),
  // 乐不思蜀 trap: musical notes where it is laid
  lebusishu: (ctx) => {
    const p = ctx.point ?? ctx.userPos;
    if (!p) return;
    ctx.fx.burst(p, { count: 10, tex: PT.note, color: C(2, 1.6, 0.6), speed: [0.5, 1.8], up: 0.9, life: [0.8, 1.3], size: [0.22, 0.14], gravity: -1, spin: 3 });
    ctx.fx.fx.ring(ground(ctx, p), { color: C(2, 1.4, 0.5), radius0: 0.3, radius1: 2.5, life: 0.6, inner: 0.85 });
  },
  // 兵粮寸断 trap: spilled grain
  bingliang: (ctx) => {
    const p = ctx.point ?? ctx.userPos;
    if (!p) return;
    ctx.fx.burst(ground(ctx, p).setY(ground(ctx, p).y + 0.3), { count: 18, tex: PT.square, color: C(1.4, 1.1, 0.5), speed: [1, 3], up: 0.7, life: [0.5, 0.9], size: [0.05, 0.04], gravity: 10, additive: false, spin: 8 });
    ctx.fx.fx.ring(ground(ctx, p), { color: C(1.6, 1.2, 0.5), radius0: 0.3, radius1: 2.5, life: 0.6, inner: 0.85 });
  },
  // 闪电: the storm cloud is summoned — a warning flash
  shandian: (ctx) => {
    const p = ctx.point ?? ctx.userPos;
    if (!p) return;
    ctx.fx.beams.lightning(p.clone().setY(p.y + 18), p.clone().setY(p.y + 6), FX_COLORS.thunder, 0.2, 0.25);
    ctx.fx.lights.flash(p.clone().setY(p.y + 4), C(0.6, 0.75, 1), 10, 18, 0.2);
  },
  // 征兵令: recruits rally — banner-coloured ring
  zhengbing: (ctx) => {
    const p = ctx.userPos;
    if (!p) return;
    ctx.fx.fx.ring(ground(ctx, p), { color: C(2.2, 0.5, 0.3), radius0: 0.5, radius1: 3.5, life: 0.7, inner: 0.85 });
    ctx.fx.burst(ground(ctx, p), { count: 10, tex: PT.dust, color: FX_COLORS.dust, speed: [2, 5], life: [0.5, 0.9], size: [0.4, 1.2], additive: false, alpha: 0.5, drag: 2.5, flat: true });
  },
};

/** Register every bespoke item-card VFX (idempotent). */
export function registerItemsVfx(): void {
  for (const [id, fn] of Object.entries(ITEMS)) setItemVfx(id, fn);
}
