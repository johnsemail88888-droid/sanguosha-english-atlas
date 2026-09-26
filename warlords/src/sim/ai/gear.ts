// Loot & gear evaluation for bot heroes: which weapon is better (rarity +
// bot-effective DPS by class), which armor / mount to wear, which consumables
// are worth a detour, how much a crate / airdrop is worth.
import type { Entity, HeroState, RoleId } from '../../core/types';
import { ARMOR_BY_ID, MOUNT_BY_ID, WEAPON_BY_ID, weaponDps } from '../../data';
import type { Rarity, WeaponClass, WeaponDef } from '../../data/types';
import { itemDef, lootKindOf } from '../defs';

const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };

/** How well a bot can use a weapon class (hitscan autos are easiest). */
const CLASS_FIT: Record<WeaponClass, number> = {
  rifle: 1,
  lmg: 0.95,
  smg: 0.9,
  dmr: 0.85,
  crossbow: 0.85,
  pistol: 0.65,
  shotgun: 0.8,
  launcher: 0.8,
  flamer: 0.7,
  bow: 0.7,
  sniper: 0.6,
  melee: 0.4,
};

/** Bot-perceived value of a primary weapon. */
export function weaponValue(def: WeaponDef | undefined): number {
  if (!def) return 0;
  const dps = weaponDps(def);
  const rangeBonus = Math.min(20, def.maxRange / 8);
  return RARITY_RANK[def.rarity] * 18 + dps * 0.35 * CLASS_FIT[def.class] + rangeBonus;
}

/** Margin a new weapon must beat the current one by (avoid swapping back and forth). */
export const WEAPON_SWAP_MARGIN = 10;

export function armorValue(id: string | null | undefined): number {
  if (!id) return 0;
  const a = ARMOR_BY_ID[id];
  if (!a) return 0;
  const special = a.special === 'baiyin' ? 3.2 : a.special === 'bagua' ? 2.4 : a.special === 'renwang' ? 2.2 : a.special === 'tengjia' ? 1.6 : 1;
  return special + RARITY_RANK[a.rarity] * 0.3;
}

export function mountValue(id: string | null | undefined, role: RoleId): number {
  if (!id) return 0;
  const m = MOUNT_BY_ID[id];
  if (!m) return 0;
  const aggressive = role === 'rebel' || role === 'bounty';
  const base = m.type === 'offense' ? (aggressive ? 2.4 : 1.6) : aggressive ? 1.8 : 2.4;
  return base + (m.speedMul - 1) * 3 + (1 - m.damageTakenMul) * 4 + RARITY_RANK[m.rarity] * 0.2;
}

/** Value of a consumable for this hero right now (0 = don't bother). */
export function itemValue(id: string, h: HeroState, hpFrac: number): number {
  const def = itemDef(id);
  if (!def) return 0;
  switch (id) {
    case 'tao':
      return 10 + (1 - hpFrac) * 8;
    case 'jiu':
      return 6;
    case 'shan':
      return 4;
    case 'wuxie':
      return 5;
    case 'sha': {
      const w = h.weapons[h.activeSlot] ?? h.weapons[0];
      const wd = w ? WEAPON_BY_ID[w.id] : undefined;
      const low = wd && wd.magSize > 0 && w!.reserve < wd.magSize * 1.5;
      return low ? 7 : 2;
    }
    default:
      return 3 + RARITY_RANK[def.rarity] * 1.2;
  }
}

/** Is there room for this consumable (free slot or unfilled stack)? */
export function hasRoomFor(h: HeroState, id: string): boolean {
  const max = itemDef(id)?.maxStack ?? 1;
  return h.items.some((s) => !s || (s.id === id && s.count < max));
}

/**
 * Value of picking up / opening `e` for this hero (0 = not wanted). Weapons,
 * armor and mounts need F; consumables are walked over.
 */
export function lootValue(e: Entity, self: Entity, role: RoleId): number {
  const h = self.hero!;
  if (!e.alive) return 0;
  if (e.kind === 'crate' || e.kind === 'airdrop') {
    if (!e.crate || e.crate.opened || !e.onGround) return 0;
    if (e.kind === 'airdrop') return 30;
    return e.crate.tier >= 2 ? 16 : 9;
  }
  const lo = e.loot;
  if (!lo) return 0;
  if (lo.weaponId) {
    const nw = WEAPON_BY_ID[lo.weaponId];
    if (!nw || nw.class === 'pistol' || nw.melee) return 0;
    const cur = h.weapons[0] ? WEAPON_BY_ID[h.weapons[0].id] : undefined;
    const gain = weaponValue(nw) - weaponValue(cur);
    return gain > WEAPON_SWAP_MARGIN ? 6 + gain * 0.25 : 0;
  }
  const id = lo.itemId;
  if (!id) return 0;
  const kind = lootKindOf(id);
  const hpFrac = self.hp / Math.max(1, self.maxHp);
  if (kind === 'armor') {
    const gain = armorValue(id) - armorValue(h.armor);
    return gain > 0.5 ? 6 + gain * 3 : 0;
  }
  if (kind === 'mount') {
    const gain = mountValue(id, role) - mountValue(h.mount, role);
    return gain > 0.5 ? 5 + gain * 2 : 0;
  }
  if (kind !== 'item') return 0;
  if (!hasRoomFor(h, id)) return 0;
  return itemValue(id, h, hpFrac);
}

/** Does picking this loot need an explicit interact (F)? */
export function needsInteract(e: Entity): boolean {
  if (e.kind === 'crate' || e.kind === 'airdrop') return true;
  const lo = e.loot;
  if (!lo) return false;
  if (lo.weaponId) return true;
  return lo.itemId ? lootKindOf(lo.itemId) !== 'item' : false;
}
