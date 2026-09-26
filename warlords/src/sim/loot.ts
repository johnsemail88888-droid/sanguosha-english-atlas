// Loot (GAME_SPEC §4 "Loot & airdrops"): crate contents, ground loot,
// 天降锦囊 airdrops every 100 s from 2:00 with a 12 s fall, reward rolls.
//
// Tables come from data/loot.ts (LOOT_TABLES / rollLoot). Drops that reference
// ids this build does not know are replaced by a roll from a rarity-weighted
// pool built from WEAPONS / ITEMS / ARMORS / MOUNTS (lootable flags), which is
// also the fallback when a table is empty.
import type { Vec3 } from '../core/math';
import type { Rng } from '../core/rng';
import { ARMORS, ITEMS, MOUNTS, WEAPONS } from '../data';
import { rollAirdropLoot, rollCrateLoot, rollLoot, rollRewardItems as dataRollRewardItems } from '../data/loot';
import type { LootDrop } from '../data/loot';
import type { Rarity } from '../data/types';
import { lootKindOf } from './defs';

export const AIRDROP_FIRST = 120;
export const AIRDROP_INTERVAL = 100;
export const AIRDROP_FALL_TIME = 12;
export const AIRDROP_HEIGHT = 120;

export const RARITY_WEIGHT: Record<Rarity, number> = { common: 60, rare: 28, epic: 10, legendary: 2 };
const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };

export interface LootRoll {
  itemId?: string;
  weaponId?: string;
  count: number;
}

type PoolKind = 'item' | 'weapon' | 'armor' | 'mount';
interface PoolEntry {
  kind: PoolKind;
  id: string;
  rarity: Rarity;
}

let pool: PoolEntry[] | null = null;

/** Rarity-weighted fallback pool from the content data (lootable weapons only). */
function fallbackPool(): PoolEntry[] {
  if (pool) return pool;
  pool = [
    ...ITEMS.map((d) => ({ kind: 'item' as const, id: d.id, rarity: d.rarity })),
    ...WEAPONS.filter((d) => d.lootable).map((d) => ({ kind: 'weapon' as const, id: d.id, rarity: d.rarity })),
    ...ARMORS.map((d) => ({ kind: 'armor' as const, id: d.id, rarity: d.rarity })),
    ...MOUNTS.map((d) => ({ kind: 'mount' as const, id: d.id, rarity: d.rarity })),
  ];
  return pool;
}

/** Weighted roll from the fallback pool. */
export function rollFromPool(rng: Rng, kinds: readonly PoolKind[], minRarity: Rarity = 'common'): LootRoll | null {
  const cands = fallbackPool().filter((p) => kinds.includes(p.kind) && RARITY_RANK[p.rarity] >= RARITY_RANK[minRarity]);
  if (cands.length === 0) return null;
  const pick = rng.weighted(
    cands,
    cands.map((c) => RARITY_WEIGHT[c.rarity]),
  );
  return pick.kind === 'weapon' ? { weaponId: pick.id, count: 1 } : { itemId: pick.id, count: 1 };
}

function toRoll(rng: Rng, d: LootDrop): LootRoll | null {
  if (lootKindOf(d.id) !== 'unknown') return d.kind === 'weapon' ? { weaponId: d.id, count: 1 } : { itemId: d.id, count: 1 };
  return rollFromPool(rng, [d.kind]);
}

function convert(rng: Rng, drops: LootDrop[]): LootRoll[] {
  const out: LootRoll[] = [];
  for (const d of drops) {
    const r = toRoll(rng, d);
    if (r) out.push(r);
  }
  return out;
}

export function rollCrate(rng: Rng, tier: 1 | 2 | 3): LootRoll[] {
  const out = convert(rng, rollCrateLoot(tier, rng));
  if (out.length > 0) return out;
  const n = tier === 1 ? rng.int(1, 2) : tier === 2 ? rng.int(2, 3) : 4;
  for (let i = 0; i < n; i++) {
    const r = rollFromPool(rng, ['item', 'weapon', 'armor', 'mount'], tier === 1 ? 'common' : 'rare');
    if (r) out.push(r);
  }
  return out;
}

export function rollGround(rng: Rng): LootRoll[] {
  const out = convert(rng, rollLoot('ground', rng, 1));
  if (out.length > 0) return out;
  const r = rollFromPool(rng, ['item', 'weapon', 'armor', 'mount']);
  return r ? [r] : [];
}

export function rollAirdrop(rng: Rng): LootRoll[] {
  const out = convert(rng, rollAirdropLoot(rng));
  if (out.some((r) => r.weaponId)) return out;
  const w = rollFromPool(rng, ['weapon'], 'epic');
  if (w) out.push(w);
  return out;
}

/** `n` random consumable item ids (rebel-kill / bounty rewards, "draw N" effects). */
export function rollRewardItems(rng: Rng, n: number, minRarity?: Rarity): string[] {
  const ids = dataRollRewardItems(rng, n, minRarity).filter((id) => lootKindOf(id) === 'item');
  while (ids.length < n) {
    const r = rollFromPool(rng, ['item'], minRarity ?? 'common') ?? rollFromPool(rng, ['item']);
    if (!r?.itemId) break;
    ids.push(r.itemId);
  }
  return ids;
}

/** Scatter positions around a point for spawned loot (ring, deterministic). */
export function scatterAround(center: Vec3, index: number, count: number, radius = 1.2): Vec3 {
  if (count <= 1) return { x: center.x, y: center.y, z: center.z };
  const a = (index / count) * Math.PI * 2 + 0.4;
  return { x: center.x + Math.cos(a) * radius, y: center.y, z: center.z + Math.sin(a) * radius };
}

/** Airdrop schedule: every AIRDROP_INTERVAL s starting at AIRDROP_FIRST. */
export class AirdropSchedule {
  nextAt = AIRDROP_FIRST;
  count = 0;

  due(time: number): boolean {
    if (time + 1e-9 < this.nextAt) return false;
    this.nextAt += AIRDROP_INTERVAL;
    this.count++;
    return true;
  }
}
