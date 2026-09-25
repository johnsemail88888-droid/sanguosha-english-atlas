// 张角 Zhang Jiao ★ — 鬼道 (passive), 雷击 (Q), 太平要术 (E), 黄天 (lord, G).
import type { Vec3 } from '../../../core/math';
import type { DamageType, Entity, EntityId } from '../../../core/types';
import { SIM_DT } from '../../../core/types';
import type { DamageResult, SimApi } from '../../api';
import { UNIT_KINDS, crosshairEnemy, crosshairPoint, param, summonTroops } from '../common';
import { registerAbility } from '../registry';
import { canAct, chestOf, setCastEvent } from './util';

/** hard CC on heroes never exceeds this (data/heroes.ts header) */
const MAX_HERO_STUN = 1.5;

interface BoltSpec {
  abilityId: string;
  dtype: DamageType;
  damage: number;
  radius: number;
  stun: number;
}

/** The hit reached the end of the damage pipeline, so a 'chained' target spread it (combat.ts step 9). */
const passedThrough = (r: DamageResult): boolean => r.blocked === undefined || r.blocked === 'shield';

/** Anything a landed hit changes on a unit (HP, shield, bleed-out clock, death). */
const hurtMark = (e: Entity): string => `${e.hp}|${e.shield}|${e.hero?.downed ? e.hero.downedUntil : '-'}|${e.alive}`;

/**
 * One lightning bolt: a 'thunder' explosion event (sky-to-ground bolt VFX) and
 * the damage (+ optional stun) to every enemy of the caster within the radius.
 *
 * 铁索连环: a thunder hit on one 'chained' unit already spreads to every chained
 * unit (combat.ts step 9), so the bolt strikes the unchained enemies directly and
 * only ONE chained enemy — the spread covers the others, and every chained unit
 * takes each bolt exactly once (not once per chained unit inside the circle).
 * Chained enemies inside the circle that the spread reached are stunned like the
 * directly struck ones. If the chosen link's hit is dodged / nullified / negated
 * (no spread), the next chained enemy inside is struck instead.
 *
 * Strikes that were already called keep falling if Zhang Jiao is downed or killed meanwhile.
 */
function bolt(sim: SimApi, casterId: EntityId, at: Vec3, o: BoltSpec): void {
  const caster = sim.get(casterId);
  if (!caster) return;
  // keep the point's own height: SimApi.groundHeight is the top-most surface (a roof above it)
  const p = { x: at.x, y: at.y, z: at.z };
  sim.emit({ t: 'explosion', pos: { ...p }, radius: o.radius, kind: 'thunder' });
  const inside = sim
    .queryRadius(p, o.radius, { kinds: UNIT_KINDS, notFriendlyTo: caster.id, exclude: [caster.id] })
    .filter((t) => !t.hero?.dead);
  const stun = (t: Entity): void => {
    if (o.stun > 0 && t.alive) sim.applyStatus(t.id, 'stun', t.kind === 'hero' ? Math.min(MAX_HERO_STUN, o.stun) : o.stun, { sourceId: casterId });
  };
  const strike = (t: Entity): DamageResult => {
    const r = sim.dealDamage({ targetId: t.id, sourceId: casterId, amount: o.damage, type: o.dtype, abilityId: o.abilityId });
    // dodged, immune or cancelled by 无懈可击: the bolt's stun misses too (same rule as circleAttack)
    if (r.blocked !== 'dodge' && r.blocked !== 'invuln' && r.blocked !== 'nullify') stun(t);
    return r;
  };
  const spreads = o.dtype === 'fire' || o.dtype === 'thunder';
  const chained = spreads ? inside.filter((t) => sim.hasStatus(t.id, 'chained')) : [];
  for (const t of inside) if (t.alive && !chained.includes(t)) strike(t);
  if (chained.length === 0) return;
  const before = new Map(chained.map((t) => [t.id, hurtMark(t)]));
  let spread = false;
  for (const t of chained) {
    if (!spread) {
      if (t.alive && !t.hero?.dead && passedThrough(strike(t))) spread = true;
    } else if (hurtMark(t) !== before.get(t.id)) {
      stun(t); // reached by the spread of this very bolt
    }
  }
}

// 鬼道 (passive): thunder damage you deal (tesla staff arcs, 雷击, the storm cloud) +30 %.
registerAbility({
  id: 'zhangjiao_guidao',
  modifyOutgoing(ctx, amount) {
    return ctx.req.type === 'thunder' ? amount * param(ctx, 'mul', 1.3) : amount;
  },
});

// 雷击 (Q): 3 bolts on the point chosen at cast time, 0.6 s apart: 55 thunder each within 3 m;
// only the first bolt stuns (0.5 s), so targets can still walk out of the later ones.
registerAbility({
  id: 'zhangjiao_leiji',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self)) return false;
    const point = crosshairPoint(ctx, param(ctx, 'range', 50));
    const bolts = Math.max(1, Math.floor(param(ctx, 'bolts', 3)));
    const interval = Math.max(0.05, param(ctx, 'interval', 0.6));
    const stunBolts = Math.floor(param(ctx, 'stunBolts', 1));
    const base = {
      abilityId: ctx.def.id,
      dtype: ctx.def.dtype ?? 'thunder',
      damage: param(ctx, 'damage', 55),
      radius: param(ctx, 'radius', 3),
    };
    const stun = param(ctx, 'stun', 0.5);
    const casterId = self.id;
    for (let i = 0; i < bolts; i++) {
      const spec: BoltSpec = { ...base, stun: i < stunBolts ? stun : 0 };
      if (i === 0) bolt(sim, casterId, point, spec);
      else sim.schedule(interval * i, () => bolt(sim, casterId, point, spec));
    }
    setCastEvent(ctx, { pos: point });
    return true;
  },
});

// 太平要术 (E): a storm cloud follows the crosshair enemy for 8 s and strikes every 1.5 s
// (first strike after one interval): 35 thunder to every enemy within 2.5 m of the cloud.
// If the target dies the cloud lingers where it fell and keeps striking there. While the
// target is stealthed the cloud stops where it lost it (the cloud is visible to everyone —
// following would give the hidden unit away) and picks it up again once it is visible.
// The storm is Zhang Jiao's sorcery: it disperses the moment he dies (a downed Zhang Jiao
// keeps it; 雷击's bolts, once called, still fall).
registerAbility({
  id: 'zhangjiao_taiping',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self)) return false;
    const target = crosshairEnemy(ctx, param(ctx, 'range', 50));
    if (!target || target.hero?.dead) return false;
    const duration = Math.max(0.1, param(ctx, 'duration', 8));
    const interval = Math.max(0.1, param(ctx, 'interval', 1.5));
    const spec: BoltSpec = {
      abilityId: ctx.def.id,
      dtype: ctx.def.dtype ?? 'thunder',
      damage: param(ctx, 'damage', 35),
      radius: param(ctx, 'radius', 2.5),
      stun: 0,
    };
    // the hazard is the visible, following cloud; its strikes are scheduled below (a discrete
    // lightning strike is an ability hit: 无懈可击 cancels one strike, unlike field ticks)
    const cloud = sim.spawnHazard({
      kind: 'lightningCloud',
      ownerId: self.id,
      pos: { ...target.pos },
      radius: spec.radius,
      duration: duration + 0.1,
      tickEvery: interval,
      params: {},
      dtype: spec.dtype,
      followId: target.id,
    });
    const cloudId = cloud.id;
    const casterId = self.id;
    const targetId = target.id;
    /** the live cloud while Zhang Jiao lives; disperses it once he is dead */
    const liveCloud = (): Entity | undefined => {
      const c = sim.get(cloudId);
      if (!c || !c.alive || !c.hazard) return undefined;
      const caster = sim.get(casterId);
      if (!caster || !caster.alive || caster.hero?.dead) {
        sim.removeEntity(cloudId);
        return undefined;
      }
      return c;
    };
    const steer = (): void => {
      const c = liveCloud();
      if (!c) return;
      const t = sim.get(targetId);
      const trackable = !!t && t.alive && !t.hero?.dead && !sim.hasStatus(t.id, 'stealth');
      c.hazard!.followId = trackable ? targetId : undefined;
      sim.schedule(SIM_DT, steer);
    };
    sim.schedule(SIM_DT, steer);
    const strikes = Math.floor(duration / interval + 1e-6);
    for (let i = 1; i <= strikes; i++) {
      sim.schedule(interval * i, () => {
        const c = liveCloud();
        if (c) bolt(sim, casterId, c.pos, spec);
      });
    }
    setCastEvent(ctx, { target: target.id, pos: chestOf(target) });
    return true;
  },
});

// 黄天 (lord skill, G): summon 5 Yellow Turban Warriors (黄巾力士) that fight for you for 30 s.
// Only the real Lord has it (the world strips lord skills from everyone else; checked again here).
registerAbility({
  id: 'zhangjiao_huangtian',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self) || sim.roleOf(self) !== 'lord') return false;
    const count = Math.max(0, Math.floor(param(ctx, 'count', 5)));
    const spawned = summonTroops(ctx, 'yellowTurbanWarrior', count, param(ctx, 'lifetime', 30));
    setCastEvent(ctx, { pos: { ...self.pos } });
    return spawned.length > 0;
  },
});
