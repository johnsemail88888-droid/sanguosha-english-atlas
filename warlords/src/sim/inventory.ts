// Inventory, equipment, loot pickup, drops and interaction channels
// (revive / crate opening / item use). Free functions over the World, which
// keeps thin SimApi wrappers for the public ones.
import type { Vec3 } from '../core/math';
import type { DeniedReason, Entity, EntityId, EntityKind } from '../core/types';
import { BTN_INTERACT, ITEM_SLOTS } from '../core/types';
import type { ItemCtx } from './api';
import { armorDef, itemDef, lootKindOf, maxReserve, maxStackOf, usesAmmo, warnOnce, weaponDef } from './defs';
import type { ItemImplEx, StripOptions } from './ext';
import { getItem } from './items/registry';
import { rollAirdrop, rollCrate, rollRewardItems as rollRewards, scatterAround } from './loot';
import type { LootRoll } from './loot';
import { REVIVE_HP, REVIVE_TIME } from './rules';
import type { ControlState } from './status';
import { findStatus, revealedTo } from './status';
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
  if (cs.stunned) return;
  if (cs.silenced) {
    itemDenied(w, e, stack.id, 'silenced');
    return;
  }
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
        if (!target) {
          itemDenied(w, e, stack.id, 'noTarget');
          return;
        }
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
  // can it be used at all right now (桃 at full HP, 闪 at the cap…)? Refuse before the 使用中
  // channel starts instead of after it (APP-7)
  if (impl.canUse) {
    let why: DeniedReason | null | undefined;
    try {
      why = impl.canUse({ sim: w, self: e, def, input: rt.input, target, point });
    } catch (err) {
      warnOnce(`item-canuse:${stack.id}`, `item '${stack.id}' canUse threw: ${String(err)}`);
    }
    if (why) {
      itemDenied(w, e, stack.id, why);
      return;
    }
  }
  const useTime = reviving ? (def.params.reviveTime ?? def.useTime ?? REVIVE_TIME) * rt.mods.reviveTimeMul : def.useTime;
  if (useTime > 0) {
    h.channel = { kind: 'item', start: w.time, until: w.time + useTime, targetId: target?.id, itemSlot: slot };
    h.reloadUntil = 0;
    rt.channelItem = { id: stack.id, point, revive: reviving };
    return;
  }
  completeItem(w, e, rt, slot, stack.id, target, point);
}

/**
 * "Can't use that now" cue for the user's own client (ITEMS-7 / APP-7): which card and why
 * (a DeniedReason; absent = generic refusal). Bots need no cue.
 */
export function itemDenied(w: World, e: Entity, itemId: string, reason?: DeniedReason): void {
  if (w.isBotHero(e)) return;
  w.emit({ t: 'sfx', name: 'itemDenied', pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z }, privateTo: e.id, item: itemId, ...(reason ? { reason } : {}) });
}

export function completeItem(w: World, e: Entity, rt: HeroRuntime, slot: number, itemId: string, target: Entity | undefined, point: Vec3 | undefined): void {
  const h = e.hero!;
  const stack = h.items[slot];
  if (!stack || stack.id !== itemId) return;
  const def = itemDef(itemId);
  const impl = getItem(itemId) as ItemImplEx | undefined;
  if (!def || !impl) return;
  // a revive card (桃) on a downed ally while a free revive is ready (华佗 急救): the free
  // revive goes first — the card stays in the bag (QUN-6)
  if (impl.canRevive && target && target !== e && target.hero?.downed && !target.hero.dead && w.hooks.canReviveFree(e)) {
    const hp = (def.params.reviveHp ?? REVIVE_HP) + rt.mods.reviveHpBonus;
    w.revive(target.id, hp, e.id, true);
    return;
  }
  // hidden use (ITEMS-3): the card asks for it, or the user is in stealth (not publicly revealed)
  const hidden = impl.hiddenUse === true || (findStatus(e, 'stealth', w.time) !== undefined && !revealedTo(e, undefined, w.time));
  const ctx: ItemCtx = { sim: w, self: e, def, input: rt.input, target, point };
  let ok = false;
  const prevActor = w.actorId;
  w.actorId = e.id; // source of source-less effects (knockback, steal) for nullify / vetoes
  try {
    ok = impl.use(ctx) === true;
  } catch (err) {
    warnOnce(`item-throw:${itemId}`, `item '${itemId}' threw: ${String(err)}`);
  } finally {
    w.actorId = prevActor;
  }
  if (!ok) {
    itemDenied(w, e, itemId, ctx.deniedReason);
    return;
  }
  const cur = h.items[slot];
  if (cur && cur.id === itemId) {
    cur.count--;
    if (cur.count <= 0) h.items[slot] = null;
  }
  // use() may say where the card really landed (a grenade stopped by a wall): ctx.eventPos
  const at = ctx.eventPos ?? point;
  const ev = { t: 'itemUse' as const, who: e.id, item: itemId, pos: at ? { x: at.x, y: at.y, z: at.z } : undefined, target: target?.id };
  w.emit(hidden ? { ...ev, privateTo: e.id } : ev);
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
/**
 * SimApi.takeRandomItem: remove one random item (and optionally armor/mount).
 * Called from ability / item code the acting hero is the thief: 陆逊 谦逊
 * vetoes it and 无懈可击 cancels it when that hero is an enemy.
 */
export function takeRandomItem(w: World, heroId: EntityId, includeEquipment = false): string | null {
  const e = w.get(heroId);
  if (!e?.hero) return null;
  const actor = w.actorId;
  if (actor !== e.id) {
    if (!w.hooks.canBeAffected(e, 'steal', actor)) return null;
    if (actor !== undefined && w.nullifies(e, actor)) return null;
  }
  return takeItemFrom(w, e, includeEquipment);
}

/** Remove one random item/equipment piece (no vetoes). */
function takeItemFrom(w: World, e: Entity, includeEquipment: boolean): string | null {
  const h = e.hero!;
  const heroId = e.id;
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
  if (w.nullifies(victim, thiefId)) return null;
  const id = takeItemFrom(w, victim, includeEquipment);
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

/**
 * Equip armor / a mount; the piece it replaces drops at the hero's feet — or where `drop` says
 * (a swap at a loot pile drops it clear of the pile, locked briefly for the hero).
 */
export function equip(w: World, heroId: EntityId, armorOrMountId: string, drop?: SwapDrop): void {
  const e = w.get(heroId);
  const h = e?.hero;
  if (!e || !h) return;
  const kind = lootKindOf(armorOrMountId);
  if (kind === 'armor' || (kind === 'unknown' && armorDef(armorOrMountId))) {
    const old = h.armor;
    setArmor(w, heroId, armorOrMountId);
    if (old) w.spawnLoot(drop?.pos ?? e.pos, { itemId: old }, undefined, drop?.lock);
  } else if (kind === 'mount') {
    const old = h.mount;
    h.mount = armorOrMountId;
    if (old) w.spawnLoot(drop?.pos ?? e.pos, { itemId: old }, undefined, drop?.lock);
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

/** Drop stripped gear where the strip says (default: at the feet), optionally locked for its old owner. */
function dropStripped(w: World, e: Entity, itemId: string, opts: StripOptions | undefined): void {
  const lock = opts?.lock !== undefined && opts.lock > 0 ? { heroId: e.id, seconds: opts.lock } : undefined;
  w.spawnLoot(opts?.at ?? e.pos, { itemId }, undefined, lock);
}

/**
 * Drop the hero's mount as loot. With opts.sourceId an enemy's strip is cancelled
 * by 无懈可击 (checked only when there is a mount to lose). Returns true when stripped.
 */
export function dismount(w: World, heroId: EntityId, opts?: StripOptions): boolean {
  const e = w.get(heroId);
  const h = e?.hero;
  if (!e || !h || !h.mount) return false;
  if (opts?.sourceId !== undefined && w.nullifies(e, opts.sourceId)) return false;
  const id = h.mount;
  h.mount = null;
  dropStripped(w, e, id, opts);
  return true;
}

/** Remove the hero's armor (dropped as loot when `drop`); same gate / options as dismount. */
export function stripArmor(w: World, heroId: EntityId, drop = true, opts?: StripOptions): boolean {
  const e = w.get(heroId);
  const h = e?.hero;
  if (!e || !h || !h.armor) return false;
  if (opts?.sourceId !== undefined && w.nullifies(e, opts.sourceId)) return false;
  const id = h.armor;
  setArmor(w, heroId, null);
  if (drop) dropStripped(w, e, id, opts);
  return true;
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
      // a ready free revive (华佗 急救) goes first; the 桃 is kept (QUN-6)
      let free = false;
      if (w.hooks.canReviveFree(e)) {
        free = true;
      } else {
        const taoSlot = h.items.findIndex((s) => s?.id === 'tao');
        if (taoSlot < 0) return;
        const s = h.items[taoSlot]!;
        s.count--;
        if (s.count <= 0) h.items[taoSlot] = null;
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

/** Where (and with what pickup lock) the gear a swap replaces is dropped. */
export interface SwapDrop {
  pos: Vec3;
  lock?: { heroId: EntityId; seconds: number };
}

/** seconds the hero who swapped gear cannot pick the old piece back up (no accidental re-swap on the next F) */
export const SWAP_LOCK = 1.5;
/** how far behind the hero the replaced gear lands */
const SWAP_DROP_DIST = 1.35;
/** loot this close to the picked item counts as its pile */
const PILE_RADIUS = 3.5;

/**
 * Drop spot for gear replaced by a swap at `pile` (the loot just taken): ~1.35 m behind the
 * hero, on the side away from the rest of the pile, so the next F press at the pile takes the
 * next piece instead of the one just dropped. Picks the candidate direction that keeps the
 * most room to every other pile item and is not behind a wall.
 */
export function swapDropPos(w: World, e: Entity, pile: Entity): Vec3 {
  const others: Vec3[] = [];
  for (const o of w.queryRadius(pile.pos, PILE_RADIUS, { kinds: ['loot', 'crate', 'airdrop'], exclude: [pile.id] })) if (o.alive) others.push(o.pos);
  // away from the pile (its centre incl. the taken item), else straight behind the hero
  let cx = pile.pos.x;
  let cz = pile.pos.z;
  for (const o of others) {
    cx += o.x;
    cz += o.z;
  }
  cx /= others.length + 1;
  cz /= others.length + 1;
  let bx = e.pos.x - cx;
  let bz = e.pos.z - cz;
  let l = Math.hypot(bx, bz);
  if (l < 0.3) {
    bx = Math.sin(e.yaw);
    bz = Math.cos(e.yaw);
    l = 1;
  }
  bx /= l;
  bz /= l;
  const chest = { x: e.pos.x, y: e.pos.y + 0.8, z: e.pos.z };
  let best: Vec3 | null = null;
  let bestRoom = -Infinity;
  for (const deg of [0, 40, -40, 80, -80, 125, -125, 180]) {
    const a = (deg * Math.PI) / 180;
    const dx = bx * Math.cos(a) - bz * Math.sin(a);
    const dz = bx * Math.sin(a) + bz * Math.cos(a);
    const p = { x: e.pos.x + dx * SWAP_DROP_DIST, y: e.pos.y, z: e.pos.z + dz * SWAP_DROP_DIST };
    if (!w.lineOfSight(chest, { x: p.x, y: p.y + 0.8, z: p.z })) continue;
    let room = Infinity;
    for (const o of others) room = Math.min(room, Math.hypot(o.x - p.x, o.z - p.z));
    if (room >= 1.2) return p;
    if (room > bestRoom) {
      bestRoom = room;
      best = p;
    }
  }
  return best ?? { x: e.pos.x, y: e.pos.y, z: e.pos.z };
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
    // the replaced gun lands behind the hero, clear of the pile, briefly locked for him
    if (old) w.spawnLoot(swapDropPos(w, e, l), { weaponId: old.id }, old, { heroId: e.id, seconds: SWAP_LOCK });
    w.emit({ t: 'pickup', who: e.id, item: lo.weaponId });
    return true;
  }
  const id = lo.itemId!;
  const kind = lootKindOf(id);
  if (kind === 'armor' || kind === 'mount') {
    if (!explicit) return false;
    w.removeEntity(l.id);
    equip(w, e.id, id, { pos: swapDropPos(w, e, l), lock: { heroId: e.id, seconds: SWAP_LOCK } });
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
