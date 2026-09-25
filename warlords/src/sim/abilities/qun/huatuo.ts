// 华佗 Hua Tuo — 急救 (passive), 青囊 (Q), 麻沸散 (E).
import { ITEM_BY_ID } from '../../../data';
import type { EntityId } from '../../../core/types';
import type { SimApi } from '../../api';
import { ext } from '../../ext';
import { alive, crosshairAlly, crosshairPoint, healOverTime, param } from '../common';
import { registerAbility } from '../registry';
import { canAct, chestOf, exposedTo, hostileUnitsNear, lobVisual, setCastEvent, standing } from './util';

/** Base revive channel of a 桃 (the F-revive uses the same 1.5 s). */
const TAO_REVIVE_TIME = ITEM_BY_ID.tao?.params.reviveTime ?? 1.5;
/** 麻沸散: the gas cloud lingers this long (visual only; the stun/slow land once on impact) */
const GAS_LINGER = 1.6;
/** hard CC on heroes never exceeds this (data/heroes.ts header) */
const MAX_HERO_STUN = 1.5;

// 急救 (passive): revives take 0.5 s and give +80 HP; once every 30 s a revive needs no 桃.
// The free-revive timer lives in hero.cooldowns[huatuo_jijiu] so the HUD shows it
// (ui/hud/logic.ts canReviveFree reads exactly that).
// A ready free revive is used FIRST, even when Hua Tuo carries a 桃: the world
// (inventory.ts updateChannel) still spends a carried 桃 before asking canReviveFree
// (docs/SIM_REQUESTS.md QUN-6), so onRevive(free = false) with the free revive ready gives
// that 桃 back and starts the 30 s timer instead — the same outcome, and redundant (never
// taken) once QUN-6 lands.
registerAbility({
  id: 'huatuo_jijiu',
  modifiers(ctx) {
    return {
      reviveTimeMul: Math.max(0.05, param(ctx, 'reviveTime', 0.5) / TAO_REVIVE_TIME),
      reviveHpBonus: param(ctx, 'reviveHpBonus', 80),
    };
  },
  canReviveFree(ctx) {
    return canAct(ctx.self) && ctx.sim.cooldownLeft(ctx.self.id, ctx.def.id) <= 0;
  },
  onRevive(ctx, target, free) {
    const { sim, self } = ctx;
    const ready = canAct(self) && sim.cooldownLeft(self.id, ctx.def.id) <= 0;
    // the 桃 was spent although no 桃 was needed: give it back (a full bag drops it at his feet)
    if (!free && ready && !sim.giveItem(self.id, 'tao')) sim.spawnLoot({ ...self.pos }, { itemId: 'tao', count: 1 });
    if (free || ready) sim.setCooldown(self.id, ctx.def.id, param(ctx, 'freeReviveCd', 30));
    // the passive has no activation: announce the (fast / free) rescue for VFX + audio
    sim.emit({ t: 'ability', src: self.id, ability: ctx.def.id, target: target.id, pos: chestOf(target) });
  },
});

// 青囊 (Q): the hero under the crosshair (or yourself) heals 150 over 3 s and is cleansed.
registerAbility({
  id: 'huatuo_qingnang',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self)) return false;
    let target = crosshairAlly(ctx, param(ctx, 'range', 25), true, ['hero']);
    // a downed (or vanished) hero can't be treated with herbs — fall back to yourself
    if (!standing(target)) target = self;
    ext(sim).cleanse(target.id);
    healOverTime(sim, target.id, param(ctx, 'heal', 150), param(ctx, 'duration', 3), self.id);
    setCastEvent(ctx, { target: target.id, pos: chestOf(target) });
    return true;
  },
});

// 麻沸散 (E): lob an anesthetic flask at the crosshair (≤ 30 m); on impact every enemy
// within 5 m is stunned 1.2 s and then slowed 40 % for 4 s.
registerAbility({
  id: 'huatuo_mafei',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self)) return false;
    const point = crosshairPoint(ctx, param(ctx, 'range', 30));
    const flight = lobVisual(ctx, 'mafeiGasGrenade', point);
    const casterId = self.id;
    const o = {
      radius: param(ctx, 'radius', 5),
      stun: param(ctx, 'stun', 1.2),
      slow: param(ctx, 'slow', 0.4),
      slowTime: param(ctx, 'slowTime', 4),
    };
    // the flask is in the air: it lands even if Hua Tuo falls meanwhile
    sim.schedule(flight, () => gasBurst(sim, casterId, point, o));
    setCastEvent(ctx, { pos: point });
    return true;
  },
});

function gasBurst(
  sim: SimApi,
  casterId: EntityId,
  point: { x: number; y: number; z: number },
  o: { radius: number; stun: number; slow: number; slowTime: number },
): void {
  const caster = sim.get(casterId);
  if (!caster) return;
  // the crosshair point is on a surface already (SimApi.groundHeight would pick a roof above it)
  const p = { x: point.x, y: point.y, z: point.z };
  sim.emit({ t: 'explosion', pos: { ...p }, radius: o.radius, kind: 'gas' });
  // lingering green cloud for the renderer ('mafei' → gas style); it has no periodic effect
  sim.spawnHazard({ kind: 'mafeiGas', ownerId: casterId, pos: p, radius: o.radius, duration: GAS_LINGER, tickEvery: GAS_LINGER, params: {} });
  for (const u of hostileUnitsNear(sim, caster, p, o.radius)) {
    if (!alive(u) || !exposedTo(sim, p, u)) continue;
    const stun = u.kind === 'hero' ? Math.min(MAX_HERO_STUN, o.stun) : o.stun;
    // one cast: if 无懈可击 cancels the stun, the slow of the same cast is cancelled with it
    sim.applyStatus(u.id, 'stun', stun, { sourceId: casterId });
    if (u.alive && o.slow > 0) sim.applyStatus(u.id, 'slow', stun + o.slowTime, { sourceId: casterId, params: { amount: o.slow } });
  }
}
