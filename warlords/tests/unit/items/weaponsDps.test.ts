// COMBAT-9 v2 (weapons spec D2): practical time-to-kill, measured the way a perfect player would
// get it — a rooted, unarmored dummy hero on a flat range, the crosshair on its chest every tick
// (projectiles held over for their drop), the sights up first in the ADS cells: seconds from the
// first shot until 400 damage (the wielder's passive included — 烈弓 / 鬼道), reloads counted,
// 12 s cap. Cells: hip 6 m, hip 15 m, ADS 15 m, ADS 40 m, ADS 75 m (+ 800 damage at ADS 15 m
// for the LMG's sustained fire, and 方天's group cell: three dummies 2.5 m apart at 15 m, all
// to 400). Each cell is the median of SEEDS seeds (spread is random). The table prints on every
// run (`npx vitest run tests/unit/items/weaponsDps.test.ts`); the rules below keep every class in
// its role:
//  - a lootable epic / legendary is ≥ 8 % faster than the best common at the range it is built for;
//    a signature (not lootable) at least as fast (balanced with its hero's kit);
//  - no weapon is top 3 in every cell; every shotgun is at least as fast as any common at 6 m;
//  - the sniper beats every bow at 75 m (≤ 0.9 ×); 孙尚香's airburst arrows cannot kill at 75 m;
//  - 方天 downs a group ≥ 20 % faster than the carbine; 许褚's belt lands 800 before the carbine.
import { describe, expect, it } from 'vitest';
import { HEROES, WEAPONS, WEAPON_BY_ID } from '../../../src/data';
import type { WeaponDef } from '../../../src/data/types';
import { measureGroup, measureTtk, median } from '../balance/range';

export const CELLS = [
  { key: 'hip6', dist: 6, ads: false },
  { key: 'hip15', dist: 15, ads: false },
  { key: 'ads15', dist: 15, ads: true },
  { key: 'ads40', dist: 40, ads: true },
  { key: 'ads75', dist: 75, ads: true },
] as const;
export type CellKey = (typeof CELLS)[number]['key'] | 'ads15_800' | 'group15';

/** seeds per cell (the median is the cell's value); WEAPONS_DPS_SEEDS overrides */
const SEEDS = Number(process.env.WEAPONS_DPS_SEEDS ?? 9);
const SIGNATURES = new Set(HEROES.map((h) => h.signatureWeapon));
/** player weapons: every lootable gun and every hero's signature weapon */
export const MEASURED = WEAPONS.filter((w) => !w.melee && (w.lootable || SIGNATURES.has(w.id)));
const COMMONS = ['pistol', 'carbine', 'smg'];

const seedOf = (i: number): number => 1000 + i * 7919;
function cell(def: WeaponDef, dist: number, ads: boolean, hp = 400): number {
  const xs: number[] = [];
  for (let i = 0; i < SEEDS; i++) xs.push(measureTtk(def, dist, ads, seedOf(i), hp));
  return median(xs);
}
function groupCell(def: WeaponDef): number {
  const xs: number[] = [];
  for (let i = 0; i < SEEDS; i++) xs.push(measureGroup(def, 15, seedOf(i)));
  return median(xs);
}

export function measureAll(): Map<string, Partial<Record<CellKey, number>>> {
  const out = new Map<string, Partial<Record<CellKey, number>>>();
  for (const def of MEASURED) {
    const row: Partial<Record<CellKey, number>> = {};
    for (const c of CELLS) row[c.key] = cell(def, c.dist, c.ads);
    if (def.class === 'lmg' || def.id === 'carbine') row.ads15_800 = cell(def, 15, true, 800);
    if (def.special === 'multiTarget' || def.id === 'carbine') row.group15 = groupCell(def);
    out.set(def.id, row);
  }
  return out;
}

/**
 * The range each class is built for and the common guns it is measured against there: close
 * range (hip 6 m) for shotguns / flamers / SMGs, aimed 15 m for rifles, the crossbow and 孙尚香's
 * skirmisher bow, aimed 75 m for DMRs / bows / the sniper, hip 15 m for grenade launchers (their
 * edge where hip fire scatters), the group cell for 方天 and 800 sustained damage for the LMG.
 */
export function intendedCell(def: WeaponDef): { cell: CellKey; vs: string[] } {
  if (def.special === 'multiTarget') return { cell: 'group15', vs: ['carbine'] };
  if (def.id === 'xiaoji') return { cell: 'ads15', vs: ['carbine'] };
  switch (def.class) {
    case 'shotgun':
    case 'flamer':
      return { cell: 'hip6', vs: COMMONS };
    case 'smg':
      return { cell: 'hip6', vs: ['smg'] };
    case 'pistol':
      return { cell: 'ads15', vs: ['pistol'] };
    case 'dmr':
    case 'bow':
    case 'sniper':
      return { cell: 'ads75', vs: COMMONS };
    case 'launcher':
      return { cell: 'hip15', vs: COMMONS };
    case 'lmg':
      return { cell: 'ads15_800', vs: ['carbine'] };
    default:
      return { cell: 'ads15', vs: ['carbine'] };
  }
}

const f = (x: number | undefined): string => (x === undefined ? '' : Number.isFinite(x) ? x.toFixed(2) : '—');

describe('practical time-to-kill (COMBAT-9 v2)', () => {
  const table = measureAll();
  const ttk = (id: string, k: CellKey): number => table.get(id)![k] ?? NaN;
  const isSignature = (d: WeaponDef): boolean => SIGNATURES.has(d.id) && !d.lootable;

  it('prints the table', () => {
    const lines = ['| weapon | class | rarity | hip 6 m | hip 15 m | ADS 15 m | ADS 40 m | ADS 75 m | 800 @ ADS 15 | group 15 m |', '|---|---|---|---|---|---|---|---|---|---|'];
    for (const def of MEASURED) {
      const r = table.get(def.id)!;
      lines.push(`| ${def.id} | ${def.class} | ${isSignature(def) ? 'sig' : def.rarity} | ${f(r.hip6)} | ${f(r.hip15)} | ${f(r.ads15)} | ${f(r.ads40)} | ${f(r.ads75)} | ${f(r.ads15_800)} | ${f(r.group15)} |`);
    }
    process.stdout.write(`\n[weapons] perfect-aim TTK vs a 400 HP dummy (s; median of ${SEEDS} seeds; — = not in 12 s)\n${lines.join('\n')}\n`);
    expect(table.size).toBe(MEASURED.length);
  });

  it('every epic / legendary clearly (×1.08) and every signature at least matches the best common at the range it is built for', () => {
    const bad: string[] = [];
    for (const def of MEASURED) {
      const sig = isSignature(def);
      if (!sig && def.rarity !== 'epic' && def.rarity !== 'legendary') continue;
      const { cell: k, vs } = intendedCell(def);
      const best = Math.min(...vs.map((c) => ttk(c, k)));
      const mine = ttk(def.id, k);
      const margin = def.special === 'multiTarget' ? 1 / 0.8 : sig ? 1 : 1.08;
      if (!(mine * margin <= best)) bad.push(`${def.id} ${k} ${f(mine)} × ${margin.toFixed(2)} > ${vs.join('/')} ${f(best)}`);
    }
    expect(bad).toEqual([]);
  });

  it('no weapon is top 3 in every cell', () => {
    const top = new Map<string, number>();
    for (const c of CELLS) {
      const ranked = MEASURED.map((d) => d.id).sort((a, b) => ttk(a, c.key) - ttk(b, c.key));
      for (const id of ranked.slice(0, 3)) top.set(id, (top.get(id) ?? 0) + 1);
    }
    expect([...top].filter(([, n]) => n >= CELLS.length).map(([id]) => id)).toEqual([]);
  });

  it('shotguns hit hard up close (at least as fast as every common gun at 6 m)', () => {
    const best = Math.min(...COMMONS.map((c) => ttk(c, 'hip6')));
    for (const def of MEASURED.filter((d) => d.class === 'shotgun')) expect(ttk(def.id, 'hip6'), def.id).toBeLessThanOrEqual(best + 1e-9);
  });

  it('the sniper owns 75 m: ≤ 0.9 × every bow; 孙尚香 cannot kill there; 许褚 lands 800 before the carbine', () => {
    const qilin = ttk('qilin', 'ads75');
    expect(qilin).toBeLessThan(Infinity);
    for (const def of MEASURED.filter((d) => d.class === 'bow')) expect(qilin, def.id).toBeLessThanOrEqual(0.9 * ttk(def.id, 'ads75'));
    expect(ttk('xiaoji', 'ads75')).toBe(Infinity);
    expect(ttk('huben', 'ads15_800')).toBeLessThan(ttk('carbine', 'ads15_800'));
    expect(WEAPON_BY_ID.fangtian.special).toBe('multiTarget');
  });
});
