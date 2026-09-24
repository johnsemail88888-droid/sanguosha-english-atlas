// Inventory, equipment, loot pickup, drops and interaction channels
// (revive / crate opening / item use). Free functions over the World, which
// keeps thin SimApi wrappers for the public ones.
import type { Vec3 } from '../core/math';
import type { Entity, EntityId, EntityKind } from '../core/types';
import { BTN_INTERACT, ITEM_SLOTS } from '../core/types';
import type { ItemCtx } from './api';
import { armorDef, itemDef, lootKindOf, maxReserve, maxStackOf, usesAmmo, warnOnce, weaponDef } from './defs';
import type { ItemImplEx } from './ext';
import { getItem } from './items/registry';
import { rollAirdrop, rollCrate, rollRewardItems as rollRewards, scatterAround } from './loot';
import type { LootRoll } from './loot';
import { REVIVE_HP, REVIVE_TIME } from './rules';
import type { ControlState } from './status';
import type { HeroRuntime, World } from './world';

/** seconds before you can pick up what you dropped yourself */
export const DROP_LOCK = 3;
/** seconds before the lord may re-take the gear dropped by the 误杀忠臣 penalty */
export const PENALTY_LOCK = 20;
export const INTERACT_RANGE = 2.6;
export const AUTO_PICKUP_RANGE = 1.4;
const UNIT_KINDS: EntityKind[] = ['hero', 'troop', 'npc', 'turret'];

const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Is this loot reserved away from `heroId` (own drops / penalty drops)? */
export function lootLockedFor(w: World, loot: Entity, heroId: EntityId): boolean {
  const l = w.lootLocks.get(loot.id);
  if (!l) return false;
  if (w.time >= l.until) {
    w.lootLocks.delete(loot.id);
    return false;
  }
  return l.heroId === heroId;
}

export function useItemSlot(w: World, e: Entity, rt: HeroRuntime, slot: number, cs: ControlState): void {
  const h = e.hero!;
  if (slot < 0 || slot >= ITEM_SLOTS) return;
  const stack = h.items[slot];
  if (!stack || h.channel) return;
  const def = itemDef(stack.id);
  const impl = getItem(stack.id) as ItemImplEx | undefined;
  if (!def || !impl) {
    warnOnce(`item-impl:${stack.id}`, `item '${stack.id}' has no implementation yet`);
    return;
  }
  if (h.downed && !impl.usableWhileDowned) return;
  if (cs.silenced || cs.stunned) return;
  // resolve target
  let target: Entity | undefined;
  let point: Vec3 | undefined;
  if (impl.canRevive && !h.downed) {
    target = findReviveTarget(w, e, Math.max(def.range, 2.5) + 0.5);
  }
  if (!target) {
    switch (def.targeting) {
      case 'ally': {
        const t = w.aimTarget(e, Math.max(1, def.range), { kinds: ['hero', 'troop'] });
        target = t && !t.hero?.dead ? t : e;
        break;
      }
      case 'enemy': {
        target = w.aimTarget(e, Math.max(1, def.range), { kinds: UNIT_KINDS, notFriendlyTo: e.id });
        if (!target) return;
        break;
      }
      case 'point':
      case 'direction':
        point = w.aimPoint(e, Math.max(1, def.range));
        break;
      default:
        target = e;
        break;
    }
  }
  const reviving = target !== undefined && target !== e && target.hero?.downed === true;
  const useTime = reviving ? (def.params.reviveTime ?? def.useTime ?? REVIVE_TIME) * rt.mods.reviveTimeMul : def.useTime;
  if (useTime > 0) {
    h.channel = { kind: 'item', start: w.time, until: w.time + useTime, targetId: target?.id, itemSlot: slot };
    h.reloadUntil = 0;
    rt.channelItem = { id: stack.id, point, revive: reviving };
    return;
  }
  completeItem(w, e, rt, slot, stack.id, target, point);
}

export function completeItem(w: World, e: Entity, rt: HeroRuntime, slot: number, itemId: string, target: Entity | undefined, point: Vec3 | undefined): void {
  const h = e.hero!;
  const stack = h.items[slot];
  if (!stack || stack.id !== itemId) return;
  const def = itemDef(itemId);
  const impl = getItem(itemId);
  if (!def || !impl) return;
  const ctx: ItemCtx = { sim: w, self: e, def, input: rt.input, target, point };
  let ok = false;
  try {
    ok = impl.use(ctx) === true;
  } catch (err) {
    warnOnce(`item-throw:${itemId}`, `item '${itemId}' threw: ${String(err)}`);
  }
  if (!ok) return;
  const cur = h.items[slot];
  if (cur && cur.id === itemId) {
    cur.count--;
    if (cur.count <= 0) h.items[slot] = null;
  }
  w.emit({ t: 'itemUse', who: e.id, item: itemId, pos: point, target: target?.id });
  w.hooks.onItemUsed(e, itemId);
}

/**
 * Downed hero a 桃 would be used on: the one under the crosshair, else the
 * nearest one in front of you that you have no known hostility with.
 */
export function findReviveTarget(w: World, e: Entity, range: number): Entity | undefined {
  const aimed = w.get(w.inputOf(e).aimTargetId);
  if (aimed?.hero?.downed && !aimed.hero.dead && dist3(aimed.pos, e.pos) <= range) return aimed;
  const fx = -Math.sin(e.yaw);
  const fz = -Math.cos(e.yaw);
  let best: Entity | undefined;
  let bd = range;
  for (const o of w.heroList()) {
    if (o === e || !o.hero!.downed || o.hero!.dead) continue;
    const dx = o.pos.x - e.pos.x;
    const dz = o.pos.z - e.pos.z;
    const d = dist3(o.pos, e.pos);
    if (d > bd) continue;
    const flat = Math.hypot(dx, dz);
    if (flat > 0.5 && (dx * fx + dz * fz) / flat < 0.5) continue;
    if (w.isHostileTo(e, o)) continue;
    bd = d;
    best = o;
  }
  return best;
}

/** add to an existing stack or the first free slot; false when full */
export function giveItem(w: World, heroId: EntityId, itemId: string, count = 1): boolean {
  const e = w.get(heroId);
  const h = e?.hero;
  if (!e || !h || h.dead || count <= 0) return false;
  const kind = lootKindOf(itemId);
  if (kind === 'weapon') {
    giveWeapon(w, heroId, itemId);
    return true;
  }
  if (kind === 'armor' || kind === 'mount') {
    equip(w, heroId, itemId);
    return true;
  }
  if (kind === 'unknown') return false;
  const max = maxStackOf(itemId);
  let left = count;
  for (let i = 0; i < ITEM_SLOTS && left > 0; i++) {
    const s = h.items[i];
    if (s && s.id === itemId && s.count < max) {
      const add = Math.min(max - s.count, left);
      s.count += add;
      left -= add;
    }
  }
  for (let i = 0; i < ITEM_SLOTS && left > 0; i++) {
    if (!h.items[i]) {
      const add = Math.min(max, left);
      h.items[i] = { id: itemId, count: add };
      left -= add;
    }
  }
  if (left > 0 && left < count) {
    w.spawnLoot(e.pos, { itemId, count: left });
    return true;
  }
  return left === 0;
}

/** giveItem, or drop at the hero's feet when the slots are full. */
export function giveOrDrop(w: World, e: Entity, itemId: string): void {
  if (!giveItem(w, e.id, itemId, 1)) w.spawnLoot(e.pos, { itemId, count: 1 });
}

export function rollRewardItems(w: World, n: number, minRarity?: 'common' | 'rare' | 'epic' | 'legendary'): string[] {
  return rollRewards(w.rng, n, minRarity);
}

/** Remove one random item (or armor/mount) from a hero. Returns null when 谦逊-style vetoes block theft. */
export function takeRandomItem(w: World, heroId: EntityId, includeEquipment = false): string | null {
  const e = w.get(heroId);
  const h = e?.hero;
  if (!e || !h) return null;
  if (!w.hooks.canBeAffected(e, 'steal')) return null;
  const opts: { kind: 'item' | 'armor' | 'mount'; slot: number }[] = [];
  h.items.forEach((s, i) => {
    if (s) opts.push({ kind: 'item', slot: i });
  });
  if (includeEquipment) {
    if (h.armor) opts.push({ kind: 'armor', slot: -1 });
    if (h.mount) opts.push({ kind: 'mount', slot: -1 });
  }
  if (opts.length === 0) return null;
  const pick = w.rng.pick(opts);
  if (pick.kind === 'item') {
    const s = h.items[pick.slot]!;
    s.count--;
    if (s.count <= 0) h.items[pick.slot] = null;
    return s.id;
  }
  if (pick.kind === 'armor') {
    const id = h.armor!;
    setArmor(w, heroId, null);
    return id;
  }
  const id = h.mount!;
  h.mount = null;
  return id;
}

export function stealItem(w: World, thiefId: EntityId, victimId: EntityId, includeEquipment = false): string | null {
  const victim = w.get(victimId);
  const thief = w.get(thiefId);
  if (!victim?.hero || !thief?.hero || victim === thief) return null;
  if (!w.hooks.canBeAffected(victim, 'steal', thiefId)) return null;
  const id = takeRandomItem(w, victimId, includeEquipment);
  if (id) giveOrDrop(w, thief, id);
  return id;
}

export function giveWeapon(w: World, heroId: EntityId, weaponId: string): void {
  const e = w.get(heroId);
  const h = e?.hero;
  if (!e || !h) return;
  const def = weaponDef(weaponId);
  const slot = def.class === 'pistol' && h.weapons[0] ? 1 : 0;
  const old = h.weapons[slot];
  h.weapons[slot] = w.newWeapon(weaponId);
  if (old) w.spawnLoot(e.pos, { weaponId: old.id, count: 1 }, old);
  h.activeSlot = slot;
  h.reloadUntil = 0;
  h.burst = 0;
}

export function refillAmmo(w: World, heroId: EntityId, fractionOfMax: number): void {
  const h = w.get(heroId)?.hero;
  if (!h) return;
  for (const wi of h.weapons) {
    if (!wi) continue;
    const def = weaponDef(wi.id);
    if (!usesAmmo(def)) continue;
    const max = maxReserve(def);
    wi.reserve = Math.min(max, wi.reserve + Math.ceil(max * fractionOfMax));
  }
}

export function refillMag(w: World, heroId: EntityId, slot?: number): void {
  const h = w.get(heroId)?.hero;
  if (!h) return;
  const wi = h.weapons[slot ?? h.activeSlot];
  if (!wi) return;
  const def = weaponDef(wi.id);
  if (usesAmmo(def)) wi.mag = def.magSize;
  if (slot === undefined || slot === h.activeSlot) h.reloadUntil = 0;
}

export function equip(w: World, heroId: EntityId, armorOrMountId: string): void {
  const e = w.get(heroId);
  const h = e?.hero;
  if (!e || !h) return;
  const kind = lootKindOf(armorOrMountId);
  if (kind === 'armor' || (kind === 'unknown' && armorDef(armorOrMountId))) {
    const old = h.armor;
    setArmor(w, heroId, armorOrMountId);
    if (old) w.spawnLoot(e.pos, { itemId: old });
  } else if (kind === 'mount') {
    const old = h.mount;
    h.mount = armorOrMountId;
    if (old) w.spawnLoot(e.pos, { itemId: old });
  } else {
    warnOnce(`equip:${armorOrMountId}`, `equip: '${armorOrMountId}' is neither armor nor a mount`);
  }
}

/** Change armor, applying 白银狮子's heal-on-removal. */
export function setArmor(w: World, heroId: EntityId, id: string | null): void {
  const e = w.get(heroId);
  const h = e?.hero;
  if (!e || !h || h.armor === id) return;
  const old = armorDef(h.armor);
  h.armor = id;
  if (old?.special === 'baiyin' && !h.downed && !h.dead) w.heal(e.id, old.params.healOnRemove ?? 100, e.id);
}

export function dismount(w: World, heroId: EntityId): void {
  const e = w.get(heroId);
  const h = e?.hero;
  if (!e || !h || !h.mount) return;
  const id = h.mount;
  h.mount = null;
  w.spawnLoot(e.pos, { itemId: id });
}

export function stripArmor(w: World, heroId: EntityId, drop = true): void {
  const e = w.get(heroId);
  const h = e?.hero;
  if (!e || !h || !h.armor) return;
  const id = h.armor;
  setArmor(w, heroId, null);
  if (drop) w.spawnLoot(e.pos, { itemId: id });
}

/** 主公误杀忠臣: drop every item, armor, mount and the secondary weapon. */
export function dropEverything(w: World, e: Entity): string[] {
  const h = e.hero!;
  const dropped: string[] = [];
  const lock = { heroId: e.id, seconds: PENALTY_LOCK };
  h.items.forEach((s, i) => {
    if (!s) return;
    w.spawnLoot(scatterAround(e.pos, dropped.length, 6, 1.2), { itemId: s.id, count: s.count }, undefined, lock);
    dropped.push(s.id);
    h.items[i] = null;
  });
  if (h.armor) {
    const id = h.armor;
    setArmor(w, e.id, null);
    w.spawnLoot(scatterAround(e.pos, dropped.length, 6, 1.2), { itemId: id }, undefined, lock);
    dropped.push(id);
  }
  if (h.mount) {
    w.spawnLoot(scatterAround(e.pos, dropped.length, 6, 1.2), { itemId: h.mount }, undefined, lock);
    dropped.push(h.mount);
    h.mount = null;
  }
  const sec = h.weapons[1];
  if (sec) {
    w.spawnLoot(scatterAround(e.pos, dropped.length, 6, 1.2), { weaponId: sec.id }, sec, lock);
    dropped.push(sec.id);
    h.weapons[1] = null;
    if (h.activeSlot === 1) h.activeSlot = 0;
  }
  return dropped;
}

export function dropSlot(w: World, e: Entity, slot: number, what: 'item' | 'weapon'): void {
  const h = e.hero!;
  if (what === 'item') {
    const s = h.items[slot];
    if (!s) return;
    h.items[slot] = null;
    w.spawnLoot(dropPos(w, e), { itemId: s.id, count: s.count }, undefined, { heroId: e.id, seconds: DROP_LOCK });
    return;
  }
  const wi = h.weapons[slot];
  if (!wi) return;
  const other = h.weapons.some((x, i) => i !== slot && x);
  if (!other) return; // never drop your last weapon
  h.weapons[slot] = null;
  w.spawnLoot(dropPos(w, e), { weaponId: wi.id }, wi, { heroId: e.id, seconds: DROP_LOCK });
  if (h.activeSlot === slot) {
    h.activeSlot = h.weapons.findIndex((x) => x);
    h.reloadUntil = 0;
  }
}

export function dropPos(w: World, e: Entity): Vec3 {
  const fx = -Math.sin(e.yaw);
  const fz = -Math.cos(e.yaw);
  return { x: e.pos.x + fx * 1.6, y: e.pos.y, z: e.pos.z + fz * 1.6 };
}

// ── interact: revive / pick up / open ───────────────────────────────────
export function interact(w: World, e: Entity, rt: HeroRuntime): void {
  const h = e.hero!;
  if (h.channel) return;
  const fx = -Math.sin(e.yaw);
  const fz = -Math.cos(e.yaw);
  let best: Entity | undefined;
  let bestScore = Infinity;
  const aimed = rt.input.aimTargetId;
  for (const o of w.queryRadius(e.pos, INTERACT_RANGE + 0.5, { kinds: ['hero', 'loot', 'crate', 'airdrop'], exclude: [e.id] })) {
    if (o.kind === 'hero' && (!o.hero!.downed || o.hero!.dead)) continue;
    if (o.kind === 'loot' && (!o.loot || lootLockedFor(w, o, e.id))) continue;
    if ((o.kind === 'crate' || o.kind === 'airdrop') && (!o.crate || o.crate.opened || !o.onGround)) continue;
    const dx = o.pos.x - e.pos.x;
    const dz = o.pos.z - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > INTERACT_RANGE + (o.kind === 'crate' || o.kind === 'airdrop' ? 0.6 : 0)) continue;
    const cos = d > 1e-3 ? (dx * fx + dz * fz) / d : 1;
    if (o.kind === 'hero' && cos < 0.3 && aimed !== o.id) continue;
    const score = d + (1 - cos) * 1.5 - (aimed === o.id ? 2 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  if (!best) return;
  if (best.kind === 'hero') startRevive(w, e, rt, best);
  else if (best.kind === 'loot') pickUp(w, e, best, true);
  else {
    const tier = best.crate!.tier;
    const t = tier === 1 ? 0.5 : tier === 2 ? 0.8 : 1.1;
    h.channel = { kind: 'open', start: w.time, until: w.time + t, targetId: best.id };
  }
}

export function startRevive(w: World, e: Entity, rt: HeroRuntime, target: Entity): void {
  const h = e.hero!;
  const hasTao = h.items.some((s) => s?.id === 'tao');
  if (!hasTao && !w.hooks.canReviveFree(e)) return;
  h.channel = {
    kind: 'revive',
    start: w.time,
    until: w.time + REVIVE_TIME * rt.mods.reviveTimeMul,
    targetId: target.id,
  };
  h.reloadUntil = 0;
}

export function updateChannel(w: World, e: Entity, rt: HeroRuntime, cs: ControlState): void {
  const h = e.hero!;
  const ch = h.channel;
  if (!ch) return;
  const now = w.time;
  if (cs.stunned || h.dead) {
    w.cancelChannel(e.id);
    return;
  }
  const tgt = ch.targetId !== undefined ? w.get(ch.targetId) : undefined;
  if (ch.kind === 'item') {
    const stack = ch.itemSlot !== undefined ? h.items[ch.itemSlot] : null;
    const impl = stack ? (getItem(stack.id) as ItemImplEx | undefined) : undefined;
    if (!stack || !impl || (h.downed && !impl.usableWhileDowned) || cs.silenced) {
      w.cancelChannel(e.id);
      return;
    }
    if (rt.channelItem?.revive) {
      // reviving: the target must still be downed and within reach
      const def = itemDef(stack.id);
      if (!tgt?.hero || !tgt.hero.downed || tgt.hero.dead || dist3(tgt.pos, e.pos) > Math.max(def?.range ?? 3, 2.5) + 1.5) {
        w.cancelChannel(e.id);
        return;
      }
    }
    if (now >= ch.until) {
      const itemId = stack.id;
      const point = rt.channelItem?.point;
      h.channel = null;
      rt.channelItem = undefined;
      completeItem(w, e, rt, ch.itemSlot!, itemId, tgt, point);
    }
    return;
  }
  if (h.downed) {
    w.cancelChannel(e.id);
    return;
  }
  if (ch.kind === 'revive') {
    const holding = (rt.input.buttons & BTN_INTERACT) !== 0;
    if (!tgt?.hero || !tgt.hero.downed || tgt.hero.dead || dist3(tgt.pos, e.pos) > INTERACT_RANGE + 1 || !holding) {
      w.cancelChannel(e.id);
      return;
    }
    if (now >= ch.until) {
      h.channel = null;
      let free = false;
      const taoSlot = h.items.findIndex((s) => s?.id === 'tao');
      if (taoSlot >= 0) {
        const s = h.items[taoSlot]!;
        s.count--;
        if (s.count <= 0) h.items[taoSlot] = null;
      } else if (w.hooks.canReviveFree(e)) {
        free = true;
      } else {
        return;
      }
      const taoDef = itemDef('tao');
      const hp = (taoDef?.params.reviveHp ?? REVIVE_HP) + rt.mods.reviveHpBonus;
      if (w.revive(tgt.id, hp, e.id, free) && !free) w.emit({ t: 'itemUse', who: e.id, item: 'tao', target: tgt.id });
    }
    return;
  }
  if (ch.kind === 'open') {
    if (!tgt?.crate || tgt.crate.opened || dist3(tgt.pos, e.pos) > INTERACT_RANGE + 1.2) {
      w.cancelChannel(e.id);
      return;
    }
    if (now >= ch.until) {
      h.channel = null;
      openCrate(w, tgt, e);
    }
    return;
  }
  // 'ability' / 'recruit' channels are driven by their implementations
  if (now >= ch.until) h.channel = null;
}

export function openCrate(w: World, crate: Entity, by: Entity): void {
  const c = crate.crate!;
  if (c.opened) return;
  c.opened = true;
  w.viewDirty = true;
  const rolls = crate.kind === 'airdrop' ? rollAirdrop(w.rng) : rollCrate(w.rng, c.tier);
  rolls.forEach((r, i) => spawnLootRoll(w, scatterAround(crate.pos, i, rolls.length, 1.3), r));
  w.emit({ t: 'sfx', name: 'crateOpen', pos: { ...crate.pos } });
  void by;
}

export function spawnLootRoll(w: World, pos: Vec3, r: LootRoll): void {
  if (r.weaponId) w.spawnLoot(pos, { weaponId: r.weaponId, count: 1 });
  else if (r.itemId) w.spawnLoot(pos, { itemId: r.itemId, count: r.count });
}

/** Walk-over pickup of consumables when a slot/stack is free. */
export function autoPickup(w: World, e: Entity): void {
  const near = w.queryRadius(e.pos, AUTO_PICKUP_RANGE, { kinds: ['loot'] });
  for (const l of near) {
    const lo = l.loot;
    if (!lo?.itemId || lootKindOf(lo.itemId) !== 'item') continue;
    if (Math.abs(l.pos.y - e.pos.y) > 1.6 || lootLockedFor(w, l, e.id)) continue;
    if (pickUp(w, e, l, false)) break;
  }
}

/** Pick up a loot entity. Equipment only when `explicit` (F). */
export function pickUp(w: World, e: Entity, l: Entity, explicit: boolean): boolean {
  const h = e.hero!;
  const lo = l.loot;
  if (!lo || !l.alive) return false;
  if (lo.weaponId) {
    if (!explicit) return false;
    const def = weaponDef(lo.weaponId);
    const slot = def.class === 'pistol' && h.weapons[0] && h.weapons[0].id !== lo.weaponId ? 1 : 0;
    const old = h.weapons[slot];
    h.weapons[slot] = {
      id: lo.weaponId,
      mag: lo.mag ?? (usesAmmo(def) ? def.magSize : 0),
      reserve: lo.reserve ?? (usesAmmo(def) ? maxReserve(def) : 0),
    };
    h.activeSlot = slot;
    h.reloadUntil = 0;
    h.burst = 0;
    w.removeEntity(l.id);
    if (old) w.spawnLoot(l.pos, { weaponId: old.id }, old);
    w.emit({ t: 'pickup', who: e.id, item: lo.weaponId });
    return true;
  }
  const id = lo.itemId!;
  const kind = lootKindOf(id);
  if (kind === 'armor' || kind === 'mount') {
    if (!explicit) return false;
    w.removeEntity(l.id);
    equip(w, e.id, id);
    w.emit({ t: 'pickup', who: e.id, item: id });
    return true;
  }
  if (kind !== 'item') return false;
  // consumables: stack / free slot
  const max = maxStackOf(id);
  let room = 0;
  for (const s of h.items) {
    if (!s) room += max;
    else if (s.id === id) room += max - s.count;
  }
  if (room <= 0) return false;
  const take = Math.min(room, lo.count);
  giveItem(w, e.id, id, take);
  lo.count -= take;
  if (lo.count <= 0) w.removeEntity(l.id);
  w.emit({ t: 'pickup', who: e.id, item: id });
  return true;
}
