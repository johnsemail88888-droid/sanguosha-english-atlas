// Loot tables (docs/GAME_SPEC.md §4 "Loot & airdrops") and pure roll helpers.
// Tables are weighted; weights are relative within a table. All rolls go
// through the host's seeded Rng, so identical seeds give identical loot.
//
//  tier1    wooden 锦囊 crate (~40 per map): 1–2 drops, mostly common/rare.
//  tier2    bronze crate in camps / key buildings (~12): 2–3 drops incl. a rare+ weapon.
//  tier3    gold crate: 1 epic+ weapon, 1 armor or mount, 2 items.
//  airdrop  天降锦囊: 1 epic/legendary weapon, 1 armor or mount, 2 items.
//  ground   single pickups on the ~60 ground loot spots.
//  reward   items only: rebel-kill rewards (3), bounty rewards (2, rare+), and every
//           "gain N random items" effect (无中生有, 遗计, 苦肉, 洛神, 制衡, 天妒 …).
import type { Rng } from '../core/rng';
import { ARMOR_BY_ID, ITEM_BY_ID, MOUNT_BY_ID } from './items';
import type { Rarity } from './types';
import { WEAPON_BY_ID } from './weapons';

export type LootKind = 'item' | 'weapon' | 'armor' | 'mount';
export type LootTableId = 'tier1' | 'tier2' | 'tier3' | 'airdrop' | 'ground' | 'reward';

export interface LootEntry {
  kind: LootKind;
  id: string;
  weight: number;
}

/** One rolled drop. */
export interface LootDrop {
  kind: LootKind;
  id: string;
}

export interface RollOptions {
  /** only entries of these kinds */
  kinds?: readonly LootKind[];
  /** only entries whose def rarity is at least this */
  minRarity?: Rarity;
}

const it = (id: string, weight: number): LootEntry => ({ kind: 'item', id, weight });
const wp = (id: string, weight: number): LootEntry => ({ kind: 'weapon', id, weight });
const ar = (id: string, weight: number): LootEntry => ({ kind: 'armor', id, weight });
const mt = (id: string, weight: number): LootEntry => ({ kind: 'mount', id, weight });

export const LOOT_TABLES: Record<LootTableId, LootEntry[]> = {
  tier1: [
    it('sha', 14), it('shan', 12), it('tao', 10), it('jiu', 4), it('huogong', 6), it('tiesuo', 5),
    it('wuzhong', 3), it('guohe', 3), it('shunshou', 3), it('wuxie', 3), it('lebusishu', 2),
    it('bingliang', 2), it('zhengbing', 2), it('taoyuan', 2), it('wugu', 1),
    wp('carbine', 4), wp('smg', 4), wp('pistol', 2), wp('hanbing', 1), wp('cixiong', 1), wp('guding', 1), wp('qinggang', 1),
    ar('bagua', 1), ar('renwang', 1), ar('tengjia', 1),
    mt('zixing', 2), mt('dilu', 1), mt('jueying', 1), mt('dawan', 0.5),
  ],
  tier2: [
    it('sha', 6), it('shan', 6), it('tao', 8), it('jiu', 4), it('wuzhong', 4), it('guohe', 4), it('shunshou', 4),
    it('juedou', 3), it('wuxie', 3), it('huogong', 4), it('tiesuo', 3), it('lebusishu', 3), it('bingliang', 3),
    it('zhengbing', 3), it('taoyuan', 2), it('wugu', 2), it('nanman', 1.5), it('wanjian', 1.5), it('jiedao', 1),
    it('shandian', 1),
    wp('carbine', 2), wp('smg', 2), wp('hanbing', 3), wp('cixiong', 3), wp('guding', 3), wp('qinggang', 3),
    wp('qinglong', 1.5), wp('zhangba', 1.5), wp('zhuge', 1.5), wp('guanshi', 1.5), wp('zhuque', 1.5),
    ar('bagua', 2), ar('renwang', 2), ar('tengjia', 2), ar('baiyin', 0.8),
    mt('zixing', 1.5), mt('dawan', 1.5), mt('dilu', 1.5), mt('jueying', 1.5), mt('chitu', 0.5), mt('zhuahuang', 0.5),
  ],
  tier3: [
    it('tao', 4), it('jiu', 3), it('wuzhong', 3), it('juedou', 2), it('wuxie', 2), it('nanman', 2), it('wanjian', 2),
    it('jiedao', 2), it('shandian', 1.5), it('zhengbing', 2),
    wp('qinglong', 3), wp('zhangba', 3), wp('zhuge', 3), wp('guanshi', 3), wp('zhuque', 3), wp('fangtian', 1.5),
    wp('qilin', 1.5),
    ar('baiyin', 2), ar('bagua', 1.5), ar('renwang', 1.5), ar('tengjia', 1),
    mt('chitu', 1.5), mt('zhuahuang', 1.5), mt('dawan', 1),
  ],
  airdrop: [
    it('tao', 5), it('jiu', 3), it('wuzhong', 3), it('juedou', 2), it('wuxie', 2), it('nanman', 2), it('wanjian', 2),
    it('jiedao', 2), it('taoyuan', 2), it('zhengbing', 2), it('shandian', 1),
    wp('fangtian', 3), wp('qilin', 3), wp('qinglong', 2), wp('zhangba', 2), wp('zhuge', 2), wp('guanshi', 2),
    wp('zhuque', 2),
    ar('baiyin', 3), ar('bagua', 2), ar('renwang', 2), ar('tengjia', 1),
    mt('chitu', 3), mt('zhuahuang', 3), mt('dawan', 1),
  ],
  ground: [
    it('sha', 16), it('shan', 10), it('tao', 7), it('jiu', 2), it('huogong', 4), it('tiesuo', 3), it('wuzhong', 1),
    it('guohe', 1), it('shunshou', 1), it('wuxie', 1), it('zhengbing', 1),
    wp('pistol', 3), wp('carbine', 3), wp('smg', 3), wp('cixiong', 0.7), wp('hanbing', 0.7), wp('guding', 0.7),
    wp('qinggang', 0.7),
    ar('bagua', 0.5), ar('renwang', 0.5), ar('tengjia', 0.5),
    mt('zixing', 1),
  ],
  reward: [
    it('sha', 8), it('shan', 8), it('tao', 9), it('jiu', 5), it('wuzhong', 4), it('guohe', 4), it('shunshou', 4),
    it('juedou', 3), it('jiedao', 2), it('wuxie', 4), it('nanman', 2), it('wanjian', 2), it('taoyuan', 2), it('wugu', 2),
    it('huogong', 5), it('tiesuo', 4), it('lebusishu', 3), it('bingliang', 3), it('shandian', 1), it('zhengbing', 3),
  ],
};

const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };

/** Rarity of the def behind a loot entry (undefined if the id does not resolve). */
export function lootRarity(kind: LootKind, id: string): Rarity | undefined {
  switch (kind) {
    case 'item':
      return ITEM_BY_ID[id]?.rarity;
    case 'weapon':
      return WEAPON_BY_ID[id]?.rarity;
    case 'armor':
      return ARMOR_BY_ID[id]?.rarity;
    case 'mount':
      return MOUNT_BY_ID[id]?.rarity;
  }
}

function filterEntries(entries: readonly LootEntry[], opts?: RollOptions): LootEntry[] {
  const kinds = opts?.kinds;
  const minRank = opts?.minRarity ? RARITY_RANK[opts.minRarity] : 0;
  return entries.filter((e) => {
    if (e.weight <= 0) return false;
    if (kinds && !kinds.includes(e.kind)) return false;
    if (minRank > 0) {
      const r = lootRarity(e.kind, e.id);
      if (!r || RARITY_RANK[r] < minRank) return false;
    }
    return true;
  });
}

/**
 * Roll `n` weighted drops from a table. Draws without replacement (no duplicate
 * entries in one roll) until the filtered table is exhausted, then starts over.
 * Pure apart from advancing `rng`; returns [] for n <= 0 or an empty selection.
 */
export function rollLoot(table: LootTableId | readonly LootEntry[], rng: Rng, n: number, opts?: RollOptions): LootDrop[] {
  const source = typeof table === 'string' ? LOOT_TABLES[table] : table;
  const pool = filterEntries(source, opts);
  const out: LootDrop[] = [];
  if (pool.length === 0) return out;
  let remaining = pool.slice();
  const count = Math.max(0, Math.floor(n));
  for (let i = 0; i < count; i++) {
    if (remaining.length === 0) remaining = pool.slice();
    const pick = rng.weighted(
      remaining,
      remaining.map((e) => e.weight),
    );
    out.push({ kind: pick.kind, id: pick.id });
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return out;
}

/** Contents of a crate by tier (see table header for the composition rules). */
export function rollCrateLoot(tier: 1 | 2 | 3, rng: Rng): LootDrop[] {
  if (tier === 1) return rollLoot('tier1', rng, rng.int(1, 2));
  if (tier === 2) {
    const weapon = rollLoot('tier2', rng, 1, { kinds: ['weapon'], minRarity: 'rare' });
    const rest = rollLoot('tier2', rng, rng.int(1, 2), { kinds: ['item', 'armor', 'mount'] });
    return [...weapon, ...rest];
  }
  return rollPremium('tier3', rng);
}

/** 天降锦囊: 1 epic/legendary weapon + 1 armor or mount + 2 items. */
export function rollAirdropLoot(rng: Rng): LootDrop[] {
  return rollPremium('airdrop', rng);
}

function rollPremium(table: 'tier3' | 'airdrop', rng: Rng): LootDrop[] {
  return [
    ...rollLoot(table, rng, 1, { kinds: ['weapon'], minRarity: 'epic' }),
    ...rollLoot(table, rng, 1, { kinds: ['armor', 'mount'] }),
    ...rollLoot(table, rng, 2, { kinds: ['item'] }),
  ];
}

/** `n` random item ids for "gain N random items" effects and kill rewards. */
export function rollRewardItems(rng: Rng, n: number, minRarity?: Rarity): string[] {
  return rollLoot('reward', rng, n, minRarity ? { minRarity } : undefined).map((d) => d.id);
}

/** Map a drop to the SimApi.spawnLoot argument. */
export function lootSpawnSpec(drop: LootDrop): { itemId?: string; weaponId?: string; count: number } {
  return drop.kind === 'weapon' ? { weaponId: drop.id, count: 1 } : { itemId: drop.id, count: 1 };
}
