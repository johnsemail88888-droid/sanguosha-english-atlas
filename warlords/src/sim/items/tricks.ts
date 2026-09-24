// 锦囊 Tricks: 无中生有, 过河拆桥, 顺手牵羊, 决斗, 借刀杀人, 无懈可击, 南蛮入侵,
// 万箭齐发, 桃园结义, 五谷丰登, 火攻, 铁索连环 — plus the 征兵令 utility order.
// Tunables come from ItemDef.params (data/items.ts); every use() returns false
// (item kept) when it could not do anything, true when the card was spent.
import type { Vec3 } from '../../core/math';
import type { DamageType, Entity, EntityId, SquadOrder } from '../../core/types';
import { ITEM_BY_ID } from '../../data/items';
import { rollRewardItems } from '../../data/loot';
import type { SimApi } from '../api';
import { ext } from '../ext';
import { registerItem } from './registry';
import {
  UNIT_KINDS,
  botView,
  centerOf,
  clusterScore,
  flatDist,
  hostileHeroesNear,
  isAlive,
  isEnemyUnit,
  isStanding,
  itemParam,
  nullified,
  prm,
  resolveEnemyHero,
  ringSpots,
  spawnLockedLoot,
  spotAround,
  statusStacks,
  throwItem,
  troopsPerHero,
  unitsInBlast,
  vetoes,
} from './util';
import type { ThrowPlan } from './util';

const P = itemParam;

/**
 * A thrown item lands (visual projectile), lies on the ground as a visible
 * warning marker (hazard `kind`, radius = blast radius) and goes off `fuse`
 * seconds after the throw at the landing point.
 */
function armFuse(sim: SimApi, self: Entity, plan: ThrowPlan, kind: string, radius: number, fuse: number, detonate: (pos: Vec3) => void): void {
  const pos = { ...plan.land };
  const ownerId = self.id;
  const markerLife = Math.max(0.05, fuse - plan.flight);
  sim.schedule(plan.flight, () => {
    sim.spawnHazard({ kind, ownerId, pos, radius, duration: markerLife, tickEvery: 60, params: { fuse } });
  });
  sim.schedule(Math.max(plan.flight, fuse), () => detonate(pos));
}

// ── 无中生有: 2 random items ───────────────────────────────────────────────────
registerItem({
  id: 'wuzhong',
  use(ctx) {
    const { sim, self } = ctx;
    const ids = rollRewardItems(sim.rng, Math.max(1, Math.round(prm(ctx, 'count', 2))));
    if (ids.length === 0) return false;
    const selfId = self.id;
    // after the world has taken this card out of its slot (so the slot is free for the draw)
    sim.schedule(0, () => {
      const e = sim.get(selfId);
      for (const id of ids) {
        if (e && sim.giveItem(selfId, id, 1)) continue;
        sim.spawnLoot(e ? { ...e.pos } : { ...self.pos }, { itemId: id, count: 1 });
      }
    });
    return true;
  },
  botShouldUse(sim, self) {
    const v = botView(sim, self);
    // pure card advantage: draw when not in the middle of a firefight
    return !v.target || (v.since > 4 && v.dist > 25);
  },
});

// ── 过河拆桥: thrown EMP — enemies drop armor and mount, shields vanish ───────
interface EmpOpts {
  radius: number;
  /** how far from its wearer the stripped gear is flung (m) */
  scatter: number;
  /** seconds before the victim may pick its own gear back up */
  lock: number;
}

/**
 * Knock `ids` (armor / mount) off `u`: flung `scatter` m away from the blast
 * (fanned out, pulled in by walls) and locked for `u` for `lock` s — anyone
 * else may grab them at once.
 */
function flingGear(sim: SimApi, u: Entity, blast: Vec3, ids: string[], o: EmpOpts): void {
  const dx = u.pos.x - blast.x;
  const dz = u.pos.z - blast.z;
  // straight away from the blast; a victim on top of it gets a fixed per-unit direction
  const base = Math.hypot(dx, dz) > 0.3 ? Math.atan2(dz, dx) : u.id * 2.399963;
  ids.forEach((itemId, i) => {
    const a = base + (i - (ids.length - 1) / 2) * 1.1;
    const spot = spotAround(sim, u.pos, a, o.scatter);
    spawnLockedLoot(sim, spot, { itemId }, { heroId: u.id, seconds: o.lock });
  });
}

function empBlast(sim: SimApi, selfId: EntityId, pos: Vec3, o: EmpOpts): void {
  const self = sim.get(selfId);
  sim.emit({ t: 'explosion', pos: { ...pos }, radius: o.radius, kind: 'emp' });
  if (!self) return;
  const x = ext(sim);
  for (const u of unitsInBlast(sim, pos, o.radius, (e) => e !== self && !sim.isOwnSide(self, e))) {
    const h = u.hero;
    const hasGear = !!(h && (h.armor || h.mount));
    if (!hasGear && !(u.shield > 0)) continue; // nothing to take: never wastes a 无懈可击
    if (nullified(sim, u, selfId)) continue;
    if (h && (h.armor || h.mount)) {
      const lost: string[] = [];
      if (h.armor) {
        lost.push(h.armor);
        x.stripArmor(u.id, false); // 白银狮子 still heals on removal; onEquipmentLost fires next tick
      }
      if (h.mount) {
        lost.push(h.mount);
        h.mount = null; // = dismount() without the drop at its feet
      }
      flingGear(sim, u, pos, lost, o);
    }
    if (u.shield > 0) {
      sim.removeStatus(u.id, 'shield');
      u.shield = 0;
    }
  }
}

registerItem({
  id: 'guohe',
  use(ctx) {
    const { sim, self } = ctx;
    const range = prm(ctx, 'range', ctx.def.range || 25);
    const fuse = prm(ctx, 'fuse', 1.2);
    const o: EmpOpts = { radius: prm(ctx, 'radius', 4), scatter: prm(ctx, 'scatter', 2.5), lock: prm(ctx, 'dropLock', 5) };
    const aim = ctx.point ?? sim.aimPoint(self, range);
    const plan = throwItem(sim, self, aim, 'grenadeEmp', fuse * 0.75);
    const selfId = self.id;
    armFuse(sim, self, plan, 'grenadeEmp', o.radius, fuse, (pos) => empBlast(sim, selfId, pos, o));
    return true;
  },
  botShouldUse(sim, self) {
    const v = botView(sim, self);
    const t = v.target;
    if (!t || !v.los || v.dist > P('guohe', 'range', 25)) return false;
    const r = P('guohe', 'radius', 4);
    // anyone around the target with gear or a fat shield worth stripping
    let value = 0;
    for (const e of sim.queryRadius(t.pos, r, { kinds: UNIT_KINDS, notFriendlyTo: self.id })) {
      if (!isAlive(e) || (e !== t && !sim.isHostileTo(self, e))) continue;
      if (e.hero?.armor) value += 2;
      if (e.hero?.mount) value += 1.5;
      value += Math.min(2, e.shield / 60);
    }
    return value >= 1.5;
  },
});

// ── 顺手牵羊: grapple-steal an item / piece of equipment ────────────────────────
registerItem({
  id: 'shunshou',
  use(ctx) {
    const { sim, self } = ctx;
    const range = prm(ctx, 'range', ctx.def.range || 8);
    const victim = resolveEnemyHero(ctx, range, { allowDowned: true });
    if (!victim?.hero) return false;
    const incl = prm(ctx, 'includeEquipment', 1) > 0;
    const vh = victim.hero;
    if (!vh.items.some(Boolean) && !(incl && (vh.armor || vh.mount))) return false; // nothing to take
    if (vetoes(sim, victim, 'steal', self.id)) return false; // 谦逊: cannot be targeted at all
    const before = statusStacks(victim, 'nullify', sim.time);
    const n = Math.max(1, Math.round(prm(ctx, 'count', 1)));
    let got = 0;
    for (let i = 0; i < n; i++) {
      if (!ext(sim).stealItem(self.id, victim.id, incl)) break;
      got++;
    }
    if (got > 0) return true;
    // cancelled by 无懈可击: the card is spent all the same
    return statusStacks(victim, 'nullify', sim.time) < before;
  },
  botShouldUse(sim, self) {
    const v = botView(sim, self);
    const t = v.target;
    if (!t?.hero || !v.los || v.dist > P('shunshou', 'range', 8) + 0.5) return false;
    const h = t.hero;
    if (!h.items.some(Boolean) && !h.armor && !h.mount) return false;
    return !vetoes(sim, t, 'steal', self.id);
  },
});

// ── 决斗: tethered duel ───────────────────────────────────────────────────────
const DUEL_VS = 'item:juedou:vs';
const DUEL_UNTIL = 'item:juedou:until';

function duelPool(e: Entity): number {
  return isStanding(e) ? e.hp + e.shield : 0;
}

function setDuelHud(e: Entity, vs: EntityId, until: number): void {
  if (!e.hero) return;
  e.hero.abilityState[DUEL_VS] = vs;
  e.hero.abilityState[DUEL_UNTIL] = until;
}

function clearDuelHud(e: Entity, vs: EntityId): void {
  const st = e.hero?.abilityState;
  if (!st || st[DUEL_VS] !== vs) return; // a newer duel owns the HUD now
  delete st[DUEL_VS];
  delete st[DUEL_UNTIL];
}

export function inDuel(sim: SimApi, e: Entity): boolean {
  return (e.hero?.abilityState[DUEL_UNTIL] ?? 0) > sim.time;
}

/** abilityId of the loser's penalty hit: a 'status:' id, so 无懈可击 cannot cancel it */
export const DUEL_PENALTY = 'status:juedou';

/**
 * Expire this duel's 'marked' on `e` (source `by`, running until `end`) right
 * away — other commanders' squad marks stay. tickStatuses removes it this tick,
 * with its 'off' event (a source-scoped removeStatus is ITEMS-5).
 */
function endDuelMark(sim: SimApi, e: Entity, by: EntityId, end: number): void {
  for (const s of e.statuses) {
    if (s.id === 'marked' && s.sourceId === by && Math.abs(s.until - end) < 1e-6) s.until = sim.time;
  }
}

registerItem({
  id: 'juedou',
  use(ctx) {
    const { sim, self } = ctx;
    const foe = resolveEnemyHero(ctx, prm(ctx, 'range', ctx.def.range || 20));
    if (!foe || inDuel(sim, self)) return false;
    if (nullified(sim, foe, self.id)) return true; // 无懈可击: the duel is refused, card spent
    const dur = prm(ctx, 'duration', 8);
    const breakDist = prm(ctx, 'breakDist', 35);
    const poll = Math.max(0.1, prm(ctx, 'pollEvery', 0.5));
    const penalty = prm(ctx, 'loserDamage', 80);
    const dtype: DamageType = ctx.def.dtype ?? 'normal';
    const a = self;
    const b = foe;
    const startA = duelPool(a);
    const startB = duelPool(b);
    const end = sim.time + dur;
    // each side's soldiers focus the other duelist
    sim.applyStatus(b.id, 'marked', dur, { sourceId: a.id });
    sim.applyStatus(a.id, 'marked', dur, { sourceId: b.id });
    setDuelHud(a, b.id, end);
    setDuelHud(b, a.id, end);
    const finish = (): void => {
      clearDuelHud(a, b.id);
      clearDuelHud(b, a.id);
      // ended early (too far apart, someone fell): the squads stop focusing each other now
      if (sim.time < end - 1e-6) {
        endDuelMark(sim, b, a.id, end);
        endDuelMark(sim, a, b.id, end);
      }
      const lostA = startA - duelPool(a);
      const lostB = startB - duelPool(b);
      if (Math.abs(lostA - lostB) < 0.5) return; // a tie punishes nobody
      const loser = lostA > lostB ? a : b;
      const winner = loser === a ? b : a;
      if (!isStanding(loser)) return; // already fell in the duel
      // the verdict of a duel both sides fought is not a fresh hostile effect: the target's
      // 无懈可击 was checked when the duel began, so neither side can cancel the penalty
      // ('status:*' hits are exempt from 无懈可击 — docs/SIM_REQUESTS.md ITEMS-8)
      sim.dealDamage({ targetId: loser.id, sourceId: winner.id, amount: penalty, type: dtype, canDodge: false, abilityId: DUEL_PENALTY, pos: centerOf(loser) });
    };
    const check = (): void => {
      const over = sim.time >= end - 1e-6 || !isStanding(a) || !isStanding(b) || flatDist(a.pos, b.pos) > breakDist;
      if (over) finish();
      else sim.schedule(Math.min(poll, Math.max(0, end - sim.time)), check);
    };
    sim.schedule(Math.min(poll, dur), check);
    return true;
  },
  botShouldUse(sim, self) {
    if (inDuel(sim, self)) return false;
    const v = botView(sim, self);
    const t = v.target;
    if (!t?.hero || t.hero.downed || !v.los || v.dist > P('juedou', 'range', 20)) return false;
    const mine = self.hp + self.shield;
    const theirs = t.hp + t.shield;
    const theirFrac = t.hp / Math.max(1, t.maxHp);
    // finish off a badly hurt foe
    if (v.hpFrac >= 0.3 && theirFrac < 0.35 && mine >= theirs) return true;
    // a healthy bot takes any fair fight: not clearly behind in HP + shield or in HP share
    return v.hpFrac >= 0.5 && mine >= theirs * 0.9 && v.hpFrac >= theirFrac - 0.15;
  },
});

// ── 借刀杀人: hack an enemy commander's troops / turrets ─────────────────────
function hasMinions(sim: SimApi, commander: Entity): boolean {
  const h = commander.hero;
  if (!h) return false;
  if (h.squad.some((id) => isAlive(sim.get(id)))) return true;
  return sim.queryRadius(commander.pos, 60, { kinds: ['turret'] }).some((t) => isAlive(t) && ext(sim).commanderOf(t) === commander);
}

/**
 * The hero the hacked squad turns on: the nearest standing hero ≠ user within
 * `radius` of their commander that the commander can see (an invisible hero is
 * never picked — the public squad order would give it away).
 */
function hackVictimTarget(sim: SimApi, victim: Entity, userId: EntityId, radius: number): Entity | undefined {
  const x = ext(sim);
  let best: Entity | undefined;
  let bd = radius;
  for (const e of sim.heroes()) {
    if (e === victim || e.id === userId || !isStanding(e) || !x.canSee(victim, e)) continue;
    const d = flatDist(e.pos, victim.pos);
    if (d <= bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

registerItem({
  id: 'jiedao',
  use(ctx) {
    const { sim, self } = ctx;
    const victim = resolveEnemyHero(ctx, prm(ctx, 'range', ctx.def.range || 40), { allowDowned: true, viaCommander: true });
    if (!victim?.hero || !hasMinions(sim, victim)) return false;
    const searchR = prm(ctx, 'searchRadius', 40);
    let prey = hackVictimTarget(sim, victim, self.id, searchR);
    if (!prey) return false; // nobody to turn them on: card kept
    if (nullified(sim, victim, self.id)) return true; // 无懈可击: hack refused, card spent
    const dur = prm(ctx, 'duration', 6);
    const poll = Math.max(0.1, prm(ctx, 'pollEvery', 0.5));
    const prev: SquadOrder = { ...victim.hero.order, point: victim.hero.order.point ? { ...victim.hero.order.point } : undefined };
    const end = sim.time + dur;
    const selfId = self.id;
    const hacked = (): boolean => {
      const o = victim.hero!.order;
      return o.kind === 'attack' && prey !== undefined && o.targetId === prey.id;
    };
    // no `point`: the order (a public 'command' event) must not broadcast where the prey stands;
    // the soldiers chase the target id itself
    const order = (): void => {
      if (prey) sim.setSquadOrder(victim.id, { kind: 'attack', targetId: prey.id });
    };
    const release = (): void => {
      if (isAlive(victim) && hacked()) sim.setSquadOrder(victim.id, prev.kind === 'attack' && prev.targetId === prey?.id ? { kind: 'follow' } : prev);
    };
    order();
    const tick = (): void => {
      if (!isAlive(victim)) return; // the squad disbands on its own
      if (sim.time >= end - 1e-6) {
        release();
        return;
      }
      if (!prey || !isStanding(prey) || flatDist(prey.pos, victim.pos) > searchR * 1.25 || !ext(sim).canSee(victim, prey)) {
        const next = hackVictimTarget(sim, victim, selfId, searchR);
        if (!next) {
          release();
          return;
        }
        prey = next;
      }
      if (!hacked()) order(); // the victim tried to countermand: the hack holds
      sim.schedule(Math.min(poll, Math.max(0, end - sim.time)), tick);
    };
    sim.schedule(Math.min(poll, dur), tick);
    return true;
  },
  botShouldUse(sim, self) {
    const v = botView(sim, self);
    const t = v.target;
    const cmd = t ? (t.kind === 'hero' ? t : ext(sim).commanderOf(t)) : undefined;
    if (!cmd?.hero || cmd === self || sim.isOwnSide(self, cmd) || flatDist(self.pos, cmd.pos) > P('jiedao', 'range', 40)) return false;
    const squad = cmd.hero.squad.filter((id) => isAlive(sim.get(id))).length;
    if (squad < 2) return false;
    return hackVictimTarget(sim, cmd, self.id, P('jiedao', 'searchRadius', 40)) !== undefined;
  },
});

// ── 无懈可击: next hostile status / ability effect on you is cancelled ─────────
registerItem({
  id: 'wuxie',
  use(ctx) {
    const { sim, self } = ctx;
    return sim.applyStatus(self.id, 'nullify', prm(ctx, 'duration', 20), { sourceId: self.id });
  },
  botShouldUse(sim, self) {
    if (sim.hasStatus(self.id, 'nullify')) return false;
    const v = botView(sim, self);
    if (v.target?.kind === 'hero' && v.dist < 35) return true;
    // shot at by a hero recently
    return ext(sim)
      .recentAttackers(self.id, 3)
      .some((id) => sim.get(id)?.kind === 'hero' && id !== self.id);
  },
});

// ── 南蛮入侵: barbarians rush the aim point and attack everyone but you ────────
const BARBARIAN = 'barbarian';

registerItem({
  id: 'nanman',
  use(ctx) {
    const { sim, self } = ctx;
    const range = prm(ctx, 'range', ctx.def.range || 50);
    const count = Math.max(1, Math.round(prm(ctx, 'count', 5)));
    const life = prm(ctx, 'lifetime', 20);
    const rush = ctx.point ?? sim.aimPoint(self, range);
    // they burst out just in front of you
    const fx = -Math.sin(self.yaw);
    const fz = -Math.cos(self.yaw);
    const chest = { x: self.pos.x, y: self.pos.y + 1, z: self.pos.z };
    let c = { x: self.pos.x + fx * 2.5, y: self.pos.y, z: self.pos.z + fz * 2.5 };
    if (!sim.lineOfSight(chest, { x: c.x, y: c.y + 1, z: c.z })) c = { ...self.pos };
    let n = 0;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const e = sim.spawnNpc(BARBARIAN, { x: c.x + Math.cos(a) * 1.6, y: c.y, z: c.z + Math.sin(a) * 1.6 }, { summonerId: self.id, lifetime: life });
      if (e.npc) {
        // fan out around the rush point instead of piling onto one spot
        e.npc.ai.goalX = rush.x + Math.cos(a) * 1.5;
        e.npc.ai.goalZ = rush.z + Math.sin(a) * 1.5;
      }
      n++;
    }
    return n > 0;
  },
  botShouldUse(sim, self) {
    const v = botView(sim, self);
    if (v.target?.kind === 'hero' && v.dist < 35) return true;
    // swarmed: several hostiles close by
    return clusterScore(sim, self, self.pos, 20, 2) >= 4;
  },
});

// ── 万箭齐发: arrow rain on a point ───────────────────────────────────────────
registerItem({
  id: 'wanjian',
  use(ctx) {
    const { sim, self } = ctx;
    const range = prm(ctx, 'range', ctx.def.range || 60);
    const at = ctx.point ?? sim.aimPoint(self, range);
    const delay = Math.max(0, prm(ctx, 'delay', 0.8));
    const hz = sim.spawnHazard({
      kind: 'wanjianArrows',
      ownerId: self.id,
      pos: at,
      radius: prm(ctx, 'radius', 8),
      duration: delay + prm(ctx, 'duration', 3),
      tickEvery: prm(ctx, 'tickEvery', 0.5),
      params: { damage: prm(ctx, 'damage', 18), delay },
      dtype: ctx.def.dtype ?? 'normal',
    });
    // the volley is in the air for `delay` s: the circle shows, the first arrows land after it
    if (hz.hazard) hz.hazard.nextTickAt = sim.time + delay;
    return true;
  },
  botShouldUse(sim, self) {
    const v = botView(sim, self);
    const t = v.target;
    if (!t || !v.los || v.dist > P('wanjian', 'range', 60)) return false;
    const r = P('wanjian', 'radius', 8);
    // clusters, or a hero pinned in place (rooted / stunned / dancing / downed)
    const pinned = t.kind === 'hero' && (t.hero!.downed || sim.hasStatus(t.id, 'root') || sim.hasStatus(t.id, 'stun') || sim.hasStatus(t.id, 'dance') || sim.hasStatus(t.id, 'freeze'));
    return pinned || clusterScore(sim, self, t.pos, r * 0.75, 2) >= 4;
  },
});

// ── 桃园结义: heal everyone around (enemies too) ─────────────────────────────
registerItem({
  id: 'taoyuan',
  use(ctx) {
    const { sim, self } = ctx;
    const radius = prm(ctx, 'radius', 15);
    const amount = prm(ctx, 'heal', 80);
    let total = 0;
    for (const u of sim.queryRadius(self.pos, radius, { kinds: ['hero', 'troop'] })) {
      if (isStanding(u)) total += sim.heal(u.id, amount, self.id);
    }
    if (total <= 0) return false; // nobody was hurt: card kept
    sim.emit({ t: 'explosion', pos: { ...self.pos }, radius, kind: 'heal' });
    return true;
  },
  botShouldUse(sim, self) {
    const amount = P('taoyuan', 'heal', 80);
    const radius = P('taoyuan', 'radius', 15);
    let mine = Math.min(amount, self.maxHp - self.hp);
    if (mine < amount * 0.6) return false; // only when it really needs the heal itself
    let theirs = 0;
    for (const u of sim.queryRadius(self.pos, radius, { kinds: ['hero'], exclude: [self.id] })) {
      if (!isStanding(u)) continue;
      const gain = Math.min(amount, u.maxHp - u.hp);
      if (sim.isHostileTo(self, u) || u.id === sim.inputOf(self).aimTargetId) theirs += gain;
      else mine += gain * 0.5; // unknowns / allies: half credit
    }
    return mine > theirs;
  },
});

// ── 五谷丰登: burst random items onto the ground ─────────────────────────────
registerItem({
  id: 'wugu',
  use(ctx) {
    const { sim, self } = ctx;
    const ids = rollRewardItems(sim.rng, Math.max(1, Math.round(prm(ctx, 'count', 4))));
    if (ids.length === 0) return false;
    const r = Math.max(1.6, prm(ctx, 'scatter', 3) * 0.8); // beyond the 1.4 m auto-pickup reach
    const spots = ringSpots(sim, self.pos, ids.length, r, sim.rng.next() * Math.PI * 2);
    ids.forEach((id, i) => sim.spawnLoot(spots[i], { itemId: id, count: 1 }));
    sim.emit({ t: 'sfx', name: 'crateOpen', pos: { ...self.pos } });
    return true;
  },
  botShouldUse(sim, self) {
    const v = botView(sim, self);
    // share nothing with the enemy: only when nobody hostile is around
    return !v.target && v.since > 5 && hostileHeroesNear(sim, self, 30).length === 0;
  },
});

// ── 火攻: incendiary grenade ─────────────────────────────────────────────────
registerItem({
  id: 'huogong',
  use(ctx) {
    const { sim, self } = ctx;
    const range = prm(ctx, 'range', ctx.def.range || 30);
    const radius = prm(ctx, 'radius', 4);
    const fuse = prm(ctx, 'fuse', 1.5);
    const damage = prm(ctx, 'damage', 40);
    const burnDps = prm(ctx, 'burnDps', 10);
    const burnTime = prm(ctx, 'burnTime', 3);
    const fieldTime = prm(ctx, 'fieldTime', 6);
    const fieldDps = prm(ctx, 'fieldDps', 15);
    const dtype: DamageType = ctx.def.dtype ?? 'fire';
    const aim = ctx.point ?? sim.aimPoint(self, range);
    const plan = throwItem(sim, self, aim, 'grenadeIncendiary', fuse * 0.75);
    const selfId = self.id;
    armFuse(sim, self, plan, 'grenadeIncendiary', radius, fuse, (pos) => {
      sim.explode(pos, radius, damage, dtype, selfId, {
        kind: 'fire',
        falloff: false,
        abilityId: 'huogong',
        status: burnTime > 0 && burnDps > 0 ? { id: 'burn', duration: burnTime, params: { dps: burnDps } } : undefined,
      });
      if (fieldTime > 0 && fieldDps > 0) {
        const tick = 0.5;
        sim.spawnHazard({ kind: 'huogongFire', ownerId: selfId, pos, radius, duration: fieldTime, tickEvery: tick, params: { damage: fieldDps * tick }, dtype });
      }
    });
    return true;
  },
  botShouldUse(sim, self) {
    const v = botView(sim, self);
    const t = v.target;
    if (!t || !v.los || v.dist > P('huogong', 'range', 30) || v.dist < 5) return false;
    if (t.kind === 'hero' && (t.hero!.armor === 'tengjia' || sim.hasStatus(t.id, 'chained'))) return true;
    return t.kind === 'hero' || clusterScore(sim, self, t.pos, P('huogong', 'radius', 4), 2) >= 3;
  },
});

// ── 铁索连环: chain up to 3 enemies near the aim point ──────────────────────
registerItem({
  id: 'tiesuo',
  use(ctx) {
    const { sim, self } = ctx;
    const range = prm(ctx, 'range', ctx.def.range || 30);
    const at = ctx.point ?? sim.aimPoint(self, range);
    const radius = prm(ctx, 'radius', 6);
    const max = Math.max(1, Math.round(prm(ctx, 'maxTargets', 3)));
    const dur = prm(ctx, 'duration', 10);
    const cands = sim
      .queryRadius(at, radius, { kinds: UNIT_KINDS, notFriendlyTo: self.id })
      .filter((e) => isEnemyUnit(sim, self, e))
      .sort((a, b) => (a.kind === 'hero' ? 0 : 1) - (b.kind === 'hero' ? 0 : 1) || flatDist(a.pos, at) - flatDist(b.pos, at) || a.id - b.id)
      .slice(0, max);
    if (cands.length === 0) return false; // nobody to chain: card kept
    for (const t of cands) sim.applyStatus(t.id, 'chained', dur, { sourceId: self.id });
    return true;
  },
  botShouldUse(sim, self) {
    const v = botView(sim, self);
    const t = v.target;
    if (!t || !v.los || v.dist > P('tiesuo', 'range', 30) || sim.hasStatus(t.id, 'chained')) return false;
    const n = sim.queryRadius(t.pos, P('tiesuo', 'radius', 6), { kinds: UNIT_KINDS, notFriendlyTo: self.id }).filter((e) => isAlive(e)).length;
    // worth it with fire/thunder follow-ups in hand, or a big pack
    const follow = self.hero!.items.some((s) => s && (s.id === 'huogong' || s.id === 'shandian'));
    return n >= (follow ? 2 : 3);
  },
});

// ── 征兵令: recruit soldiers (up to `overCap` over the squad cap) ─────────────
/** Squad cap of a hero: settings.troopsPerHero + hero troopBonus + lord bonus + squadBonus modifiers. */
export function squadCap(sim: SimApi, self: Entity): number {
  const def = sim.heroDef(self);
  const role = sim.roleOf(self);
  const lord = role === 'lord' || role === 'double' ? 2 : 0;
  return Math.max(0, troopsPerHero(sim) + (def?.troopBonus ?? 0) + lord + ext(sim).modifiers(self.id).squadBonus);
}

function livingSquad(sim: SimApi, self: Entity): number {
  return (self.hero?.squad ?? []).filter((id) => isAlive(sim.get(id))).length;
}

registerItem({
  id: 'zhengbing',
  use(ctx) {
    const { sim, self } = ctx;
    const def = sim.heroDef(self);
    if (!def || !self.hero) return false;
    const room = squadCap(sim, self) + Math.round(prm(ctx, 'overCap', 2)) - livingSquad(sim, self);
    const n = Math.min(Math.round(prm(ctx, 'count', 2)), room);
    if (n <= 0) return false; // squad full: card kept
    return sim.spawnTroops(self.id, def.troopType, n).length > 0;
  },
  botShouldUse(sim, self) {
    const v = botView(sim, self);
    if (v.since < 3 || (v.target && v.dist < 20)) return false; // 1.5 s channel: not under fire
    const h = self.hero;
    if (!h) return false;
    const living = livingSquad(sim, self);
    const cap = squadCap(sim, self);
    if (living < cap) return true; // refill
    if (living >= cap + Math.round(P('zhengbing', 'overCap', 2))) return false; // no room even over the cap
    // over the cap: before a fight (a foe in sight, not yet shooting), or when the card only takes up space
    if (v.target?.kind === 'hero' && v.los && v.dist <= 60) return true;
    const used = h.items.filter(Boolean).length;
    const stack = h.items.find((s) => s?.id === 'zhengbing');
    return used >= h.items.length - 1 || (stack?.count ?? 0) >= (ITEM_BY_ID.zhengbing?.maxStack ?? 2);
  },
});
