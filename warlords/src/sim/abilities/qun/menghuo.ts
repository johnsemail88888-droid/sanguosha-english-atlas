// 孟获 Meng Huo — 祸首 (passive), 再起 (passive), 南蛮入侵 (Q), 象兵 (E).
import type { Vec3 } from '../../../core/math';
import type { DamageType, EntityId } from '../../../core/types';
import { SIM_DT } from '../../../core/types';
import { BARBARIAN_TROOP_IDS } from '../../../data';
import type { SimApi } from '../../api';
import { crosshairPoint, flatAimDir, getState, param, setState, summonNpcs, unitsAlongLine } from '../common';
import { registerAbility } from '../registry';
import { canAct, chestOf, flatDirTo, setCastEvent } from './util';

const BARBARIANS: readonly string[] = [...BARBARIAN_TROOP_IDS];
const isBarbarianType = (t: string | undefined): boolean => t !== undefined && BARBARIANS.includes(t);

// 祸首 (passive): 南蛮 units (anyone's 南蛮入侵 warriors, war elephants) never pick you (or
// your soldiers) as a target, and anything they still land on you is negated.
registerAbility({
  id: 'menghuo_huoshou',
  modifiers() {
    return { npcImmune: BARBARIANS as string[] };
  },
  modifyIncoming(ctx, amount) {
    const src = ctx.other;
    return src?.kind === 'npc' && isBarbarianType(src.npc?.npcType) ? 0 : amount;
  },
});

// 再起 (passive): once per match, the moment you would be downed you get back up with 50 % HP.
registerAbility({
  id: 'menghuo_zaiqi',
  onDowned(ctx) {
    const { sim, self } = ctx;
    if (!self.hero || self.hero.dead || !self.alive) return false;
    const used = getState(ctx, 'used');
    if (used >= Math.max(0, Math.floor(param(ctx, 'uses', 1)))) return false;
    setState(ctx, 'used', used + 1);
    self.hp = Math.max(1, Math.min(self.maxHp, Math.round(self.maxHp * param(ctx, 'hpFrac', 0.5))));
    // passives have no activation event: announce the resurgence (VFX / audio / kill feed)
    sim.emit({ t: 'ability', src: self.id, ability: ctx.def.id, pos: chestOf(self) });
    sim.emit({ t: 'revived', target: self.id, by: self.id });
    return true;
  },
});

// 南蛮入侵 (Q): 5 南蛮勇士 (20 s) burst out beside you and rush the crosshair point (≤ 50 m),
// attacking everything that is not on your side on the way.
registerAbility({
  id: 'menghuo_nanman',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self)) return false;
    const point = crosshairPoint(ctx, param(ctx, 'range', 50));
    const dir = flatDirTo(self.pos, point, flatAimDir(ctx));
    const at = { x: self.pos.x + dir.x * 2.5, y: self.pos.y, z: self.pos.z + dir.z * 2.5 };
    const count = Math.max(0, Math.floor(param(ctx, 'count', 5)));
    const npcs = summonNpcs(ctx, 'barbarian', count, param(ctx, 'lifetime', 20), at, point);
    setCastEvent(ctx, { pos: point, dir });
    return npcs.length > 0;
  },
});

interface TrampleSpec {
  abilityId: string;
  dtype: DamageType;
  damage: number;
  /** half-width of the trample corridor (data/heroes.ts convention) */
  width: number;
  knockback: number;
  endAt: number;
  /** where Meng Huo stood and the charge direction: nothing behind him is ever trampled */
  origin: Vec3;
  dir: Vec3;
}

/**
 * Per-tick trample while the elephant charges: every enemy within `width` of the
 * path it covered since the last tick takes the hit once. Stops early if the
 * elephant dies. Units behind Meng Huo (negative offset along the charge) are
 * skipped: the path segment's rounded end must not reach back past him.
 */
function trample(sim: SimApi, eleId: EntityId, last: Vec3, hit: Set<EntityId>, o: TrampleSpec): void {
  const ele = sim.get(eleId);
  if (!ele || !ele.alive) return;
  const cur = { ...ele.pos };
  for (const t of unitsAlongLine(sim, ele, last, cur, o.width)) {
    if (hit.has(t.id) || !t.alive) continue;
    if ((t.pos.x - o.origin.x) * o.dir.x + (t.pos.z - o.origin.z) * o.dir.z < 0) continue;
    hit.add(t.id);
    sim.dealDamage({
      targetId: t.id,
      sourceId: ele.id,
      amount: o.damage,
      type: o.dtype,
      abilityId: o.abilityId,
      knockback: o.knockback,
      pos: chestOf(t),
    });
  }
  if (sim.time + 1e-9 < o.endAt) sim.schedule(SIM_DT, () => trample(sim, eleId, cur, hit, o));
}

// 象兵 (E): a war elephant charges 30 m ahead over 2 s, trampling every enemy in its path once
// (100 melee + knockback) — the path is a 3 m half-width corridor (≈ 6 m wide, plus the unit's
// own radius) starting where the elephant appears, 2.5 m in front of Meng Huo — then it fights
// for you for 12 s.
registerAbility({
  id: 'menghuo_xiangbing',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self)) return false;
    const dir = flatAimDir(ctx);
    const distance = Math.max(0, param(ctx, 'distance', 30));
    const chargeTime = Math.max(0.2, param(ctx, 'chargeTime', 2));
    const start = { x: self.pos.x + dir.x * 2.5, y: self.pos.y, z: self.pos.z + dir.z * 2.5 };
    const ele = sim.spawnNpc('elephant', start, { summonerId: self.id, lifetime: chargeTime + Math.max(0, param(ctx, 'lifetime', 12)) });
    ele.yaw = Math.atan2(-dir.x, -dir.z);
    sim.dash(ele.id, dir, distance, chargeTime);
    const spec: TrampleSpec = {
      abilityId: ctx.def.id,
      dtype: ctx.def.dtype ?? 'melee',
      damage: param(ctx, 'damage', 100),
      width: param(ctx, 'width', 3),
      knockback: param(ctx, 'knockback', 10),
      endAt: sim.time + chargeTime,
      origin: { x: self.pos.x, y: self.pos.y, z: self.pos.z },
      dir: { x: dir.x, y: 0, z: dir.z },
    };
    // units standing right where it appears are trampled too (the path starts at its spawn point)
    trample(sim, ele.id, { ...ele.pos }, new Set<EntityId>(), spec);
    setCastEvent(ctx, { pos: { x: start.x + dir.x * distance, y: start.y, z: start.z + dir.z * distance }, dir });
    return true;
  },
});
