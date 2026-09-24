// 张角 Zhang Jiao ★ — 鬼道 (passive), 雷击 (Q), 太平要术 (E), 黄天 (lord, G).
import type { Vec3 } from '../../../core/math';
import type { DamageType, EntityId } from '../../../core/types';
import type { SimApi } from '../../api';
import { circleAttack, crosshairEnemy, crosshairPoint, param, summonTroops } from '../common';
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

/**
 * One lightning bolt: a 'thunder' explosion event (sky-to-ground bolt VFX) and
 * the damage to every enemy of the caster within the radius. Strikes that were
 * already called keep falling if Zhang Jiao is downed or killed meanwhile.
 */
function bolt(sim: SimApi, casterId: EntityId, at: Vec3, o: BoltSpec): void {
  const caster = sim.get(casterId);
  if (!caster) return;
  // keep the point's own height: SimApi.groundHeight is the top-most surface (a roof above it)
  const p = { x: at.x, y: at.y, z: at.z };
  circleAttack(sim, caster, p, o.radius, {
    damage: o.damage,
    dtype: o.dtype,
    abilityId: o.abilityId,
    vfx: 'thunder',
    status: o.stun > 0 ? { id: 'stun', duration: Math.min(MAX_HERO_STUN, o.stun) } : undefined,
  });
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
// If the target dies the cloud lingers where it fell and keeps striking there.
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
    const strikes = Math.floor(duration / interval + 1e-6);
    for (let i = 1; i <= strikes; i++) {
      sim.schedule(interval * i, () => {
        const c = sim.get(cloudId);
        if (!c || !c.alive || !c.hazard) return;
        bolt(sim, casterId, c.pos, spec);
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
