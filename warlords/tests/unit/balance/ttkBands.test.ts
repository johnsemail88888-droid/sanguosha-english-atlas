// Human-model TTK bands (weapons spec D3, tests/unit/balance/ttkModel.ts): a mid-skill human, a
// 400 HP target strafing at 5 m/s, unarmored, 20 % headshots, the better of hip / ADS. Each class
// must land in its target band (spec A1, ±5 %) at every range from 5 to 100 m.
//
// Default run (≈ seconds): 11 class representatives × 7 ranges; the SMG role rule; the touch rule.
// BALANCE=1: every weapon, the armor rules, the per-range top 3, the model vs the sim (D2).
// src/data/weaponTtk.gen.ts (the stat card's TTK strip) is generated from this model and
// drift-checked here: UPDATE_TTK=1 npx vitest run tests/unit/balance/ttkBands.test.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEAPON_BY_ID } from '../../../src/data';
import type { WeaponClass } from '../../../src/data/types';
import { measureTtk, median } from './range';
import { ARMORS, CAP, MODEL_WEAPONS, RANGES, bestTtk, calibTtk, touchTtk } from './ttkModel';
import type { ArmorId } from './ttkModel';

const I = Infinity;
type Band = [number, number];
/** Target TTK bands (s) at 5 / 10 / 20 / 35 / 50 / 75 / 100 m; [lo, ∞] = at least lo, or cannot kill (spec A1). */
export const BANDS: Readonly<Record<Exclude<WeaponClass, 'melee'>, Band[]>> = {
  shotgun: [[1.3, 1.8], [1.9, 2.8], [5, I], [12, I], [12, I], [12, I], [12, I]],
  flamer: [[1.6, 2.2], [2.5, 3.3], [12, I], [12, I], [12, I], [12, I], [12, I]],
  smg: [[1.9, 2.4], [2.1, 2.6], [2.6, 3.6], [5.5, I], [9, I], [12, I], [12, I]],
  pistol: [[2.7, 3.6], [2.8, 3.7], [2.8, 4.2], [4.5, 8.5], [7, I], [12, I], [12, I]],
  rifle: [[2.0, 2.9], [2.0, 2.9], [2.1, 2.9], [2.5, 3.5], [3.6, 6.5], [7, I], [11, I]],
  lmg: [[2.5, 3.1], [2.5, 3.1], [2.6, 3.1], [3.0, 3.7], [4.0, 5.5], [8, I], [12, I]],
  crossbow: [[2.1, 2.9], [2.1, 2.9], [2.2, 2.9], [2.6, 3.5], [3.8, 6.5], [7, I], [11, I]],
  dmr: [[2.6, 3.8], [2.6, 3.5], [2.6, 3.3], [2.6, 3.3], [2.8, 3.6], [4.0, 7.0], [6.5, 11]],
  bow: [[3.0, 4.2], [3.0, 4.0], [3.2, 4.3], [3.4, 6.0], [4.5, 9.0], [7.0, 12], [9, I]],
  sniper: [[3.4, 6.0], [3.4, 4.4], [3.3, 4.2], [3.3, 4.2], [3.3, 4.2], [3.4, 4.4], [3.5, 5.5]],
  launcher: [[2.3, 3.2], [2.4, 3.3], [2.7, 3.8], [3.2, 6.5], [6, I], [12, I], [12, I]],
};
/** weapons whose role differs from their class row (spec A1 overrides) */
export const BAND_OVERRIDE: Readonly<Record<string, Band[]>> = {
  cixiong: BANDS.smg,
  taiping: [[2.0, 2.8], [2.0, 2.8], [2.1, 2.9], [3.3, 5.5], [7, I], [12, I], [12, I]],
  guanshi: [[6, I], [2.4, 3.3], [2.7, 4.2], [3.2, 9], [6, I], [12, I], [12, I]],
  baiyi: [[2.6, 3.8], [2.6, 3.5], [2.6, 3.3], [2.6, 3.3], [2.8, 3.8], [5.0, 9.0], [8, I]],
  fangtian: [[2.3, 3.2], [2.4, 3.3], [3.5, 6.0], [6, I], [12, I], [12, I], [12, I]],
  xiaoji: [[2.7, 3.6], [2.7, 3.6], [3.0, 4.0], [3.6, 5.2], [5.0, 10], [9, I], [12, I]],
};
export const bandOf = (id: string): Band[] => BAND_OVERRIDE[id] ?? BANDS[WEAPON_BY_ID[id].class as Exclude<WeaponClass, 'melee'>];
/** one per class (the default run) */
export const REPRESENTATIVES = ['pistol', 'smg', 'carbine', 'jiguan', 'huben', 'qinggang', 'liegong', 'qilin', 'guding', 'guanshi', 'zhuque'];
/** accepted misses: 青釭 at 50 / 75 m (a rare that ignores all armor) */
const ALLOWED_OUT = new Set(['qinggang@50', 'qinggang@75']);
const TRIALS = Number(process.env.TTK_TRIALS ?? 200);
/**
 * Trials of a band cell: its median settles to the study's own table (final/rows_final_mid) at
 * ~1000; at 200 a far cell (青釭 100 m, 烈弓 75 m) wanders ±8 % between runs.
 */
const BAND_TRIALS = Number(process.env.TTK_TRIALS ?? 1000);
const BALANCE = process.env.BALANCE === '1';

/** a band cell looks as far as its tolerance (12 s × 1.05): a 75 m bow at 12.3 s is in its [7, 12] band */
const BAND_CAP = CAP * 1.05;
const f = (x: number): string => (!Number.isFinite(x) ? '—' : x < 10 ? x.toFixed(2) : x.toFixed(1));
const inBand = (v: number, [lo, hi]: Band): boolean => v >= lo * 0.95 && v <= hi * 1.05;

function bandRows(ids: readonly string[]): { lines: string[]; out: string[]; table: Map<string, number[]> } {
  const lines: string[] = [];
  const out: string[] = [];
  const table = new Map<string, number[]>();
  for (const id of ids) {
    const band = bandOf(id);
    const row = RANGES.map((d) => bestTtk(id, d, 'mid', BAND_TRIALS, { cap: BAND_CAP }).t);
    table.set(id, row);
    const cells = row.map((v, i) => {
      const ok = inBand(v, band[i]) || ALLOWED_OUT.has(`${id}@${RANGES[i]}`);
      if (!ok) out.push(`${id}@${RANGES[i]} ${f(v)} ∉ [${band[i][0]}, ${band[i][1]}]`);
      return `${f(v)}${ok ? '' : '*'}`.padEnd(6);
    });
    lines.push(`${id.padEnd(9)} ${WEAPON_BY_ID[id].class.padEnd(8)} ${cells.join(' | ')}`);
  }
  return { lines, out, table };
}

describe('human-model TTK bands (D3)', () => {
  it('every class representative lands in its band at every range (±5 %)', () => {
    const { lines, out } = bandRows(REPRESENTATIVES);
    process.stdout.write(`\n[ttk bands] mid human, 400 HP strafer, unarmored, 20 % head (s) at ${RANGES.join(' / ')} m\n${lines.join('\n')}\n`);
    expect(out).toEqual([]);
  }, 300_000);

  it('the SMG role: ≤ 0.9 × the carbine at 5 and 10 m, standing and moving', () => {
    for (const moving of [false, true]) {
      for (const d of [5, 10]) {
        const smg = bestTtk('smg', d, 'mid', TRIALS, { moving }).t;
        const carbine = bestTtk('carbine', d, 'mid', TRIALS, { moving }).t;
        // (+10 ms: below the model's resolution — shots land on 33 ms ticks)
        expect(smg, `${d} m${moving ? ' moving' : ''}: smg ${f(smg)} vs carbine ${f(carbine)}`).toBeLessThanOrEqual(0.9 * carbine + 0.01);
      }
    }
  }, 300_000);

  it('touch + aim assist lands between the casual and the mid mouse (±3 %) in every cell', () => {
    const ids = ['pistol', 'smg', 'carbine', 'huben', 'qinggang', 'qilin', 'liegong', 'guding'];
    const bad: string[] = [];
    for (const id of ids) {
      for (const d of RANGES) {
        const t = touchTtk(id, d, TRIALS);
        const mid = bestTtk(id, d, 'mid', TRIALS).t;
        const casual = bestTtk(id, d, 'casual', TRIALS).t;
        if (t < mid * 0.97) bad.push(`${id}@${d} touch ${f(t)} faster than the mid mouse ${f(mid)}`);
        if (t > casual * 1.03) bad.push(`${id}@${d} touch ${f(t)} slower than casual ${f(casual)}`);
      }
    }
    expect(bad).toEqual([]);
  }, 600_000);
});

// ── the TTK strip of the stat card: data/weaponTtk.gen.ts ─────────────────────
const GEN = join(__dirname, '../../../src/data/weaponTtk.gen.ts');
export function weaponTtkSource(): string {
  const rows = MODEL_WEAPONS.map((id) => {
    const v = [5, 20, 50].map((d) => bestTtk(id, d, 'mid', 1000).t);
    const n = (x: number): string => (Number.isFinite(x) ? String(Math.round(x * 100) / 100) : 'Infinity');
    return `  ${id}: { m5: ${n(v[0])}, m20: ${n(v[1])}, m50: ${n(v[2])} },`;
  });
  return [
    '// GENERATED by tests/unit/balance/ttkBands.test.ts from the human TTK model (tests/unit/balance/ttkModel.ts):',
    '// a mid-skill human vs a 400 HP hero strafing at 5 m/s, unarmored, 20 % headshots, the better of hip and ADS;',
    '// seconds, Infinity = cannot down it in 12 s. Do not edit — regenerate with',
    '//   UPDATE_TTK=1 npx vitest run tests/unit/balance/ttkBands.test.ts',
    'export const WEAPON_TTK: Record<string, { m5: number; m20: number; m50: number }> = {',
    ...rows,
    '};',
    '',
  ].join('\n');
}

describe('data/weaponTtk.gen.ts (the stat card TTK strip)', () => {
  it('is in sync with the model (UPDATE_TTK=1 regenerates it)', () => {
    const src = weaponTtkSource();
    if (process.env.UPDATE_TTK === '1') writeFileSync(GEN, src);
    let cur = '';
    try {
      cur = readFileSync(GEN, 'utf8');
    } catch {
      cur = '';
    }
    expect(cur === src, 'src/data/weaponTtk.gen.ts is stale — run `UPDATE_TTK=1 npx vitest run tests/unit/balance/ttkBands.test.ts`').toBe(true);
  }, 600_000);
});

describe.runIf(BALANCE)('human-model balance (BALANCE=1)', () => {
  it('every weapon in its band; armor slowdowns; per-range top 3; the model agrees with the sim (D2)', () => {
    const { lines, out, table } = bandRows(MODEL_WEAPONS);
    process.stdout.write(`\n[ttk bands] all weapons\n${lines.join('\n')}\n`);
    expect(out).toEqual([]);
    // armor: killable-only median slowdown, cells pushed past 12 s
    const ratios = new Map<ArmorId, number[]>();
    const pushed = new Map<ArmorId, number>();
    let cells = 0;
    for (const id of MODEL_WEAPONS) {
      for (const d of RANGES) {
        const b = bestTtk(id, d, 'mid', 150, { armors: ARMORS });
        const base = b.cell.t.none_hs20_400;
        if (!(base < I)) continue;
        cells++;
        for (const a of ARMORS.slice(1)) {
          const v = b.cell.t[`${a}_hs20_400`];
          if (v < I) (ratios.get(a) ?? ratios.set(a, []).get(a)!).push(v / base);
          else if (base <= 12) pushed.set(a, (pushed.get(a) ?? 0) + 1);
        }
      }
    }
    const med = (xs: number[]): number => median(xs);
    const armorLines = ARMORS.slice(1).map((a) => `${a}: median ×${med(ratios.get(a) ?? []).toFixed(2)}, pushed past 12 s ${pushed.get(a) ?? 0}/${cells}`);
    process.stdout.write(`\n[ttk armor] ${armorLines.join(' · ')}\n`);
    expect(med(ratios.get('tengjia')!)).toBeLessThanOrEqual(1.6);
    expect(med(ratios.get('bagua')!)).toBeLessThanOrEqual(1.6);
    expect(med(ratios.get('renwang')!)).toBeLessThanOrEqual(1.85);
    for (const a of ARMORS.slice(1)) expect((pushed.get(a) ?? 0) / cells, a).toBeLessThanOrEqual(0.15);
    // each range's top 3 by class (spec A2)
    const TOP3: Record<number, string[]> = { 5: ['shotgun'], 10: ['smg', 'rifle'], 20: ['crossbow', 'rifle'], 35: ['rifle', 'crossbow'], 50: ['dmr', 'sniper'], 75: ['sniper', 'dmr'], 100: ['sniper', 'dmr'] };
    RANGES.forEach((d, i) => {
      const ranked = [...table].filter(([, r]) => r[i] < I).sort((a, b) => a[1][i] - b[1][i]).slice(0, 3);
      process.stdout.write(`[ttk top3] ${d} m: ${ranked.map(([id, r]) => `${id} ${f(r[i])}`).join(', ')}\n`);
      expect(ranked.every(([id]) => TOP3[d].includes(WEAPON_BY_ID[id].class)), `${d} m top 3 ${ranked.map(([id]) => id).join(', ')}`).toBe(true);
    });
    // perfect aim: the model's rooted-target TTK within 5 % of the sim's (D2), hitscan and arrows
    const bad: string[] = [];
    for (const id of ['carbine', 'smg', 'pistol', 'qinggang', 'qilin', 'huben', 'liegong']) {
      for (const [d, ads] of [[15, true], [40, true], [75, true]] as const) {
        const model = calibTtk(id, d, ads ? 'ads' : 'hip');
        // the D2 cell: the median of the same 9 seeds as tests/unit/items/weaponsDps.test.ts
        const sim = median(Array.from({ length: 9 }, (_, i) => measureTtk(WEAPON_BY_ID[id], d, ads, 1000 + i * 7919)));
        if (!(model < I && sim < I)) {
          if (model < I !== sim < I) bad.push(`${id}@${d} model ${f(model)} sim ${f(sim)}`);
          continue;
        }
        if (Math.abs(model / sim - 1) > 0.05) bad.push(`${id}@${d} model ${f(model)} sim ${f(sim)}`);
      }
    }
    process.stdout.write(`[ttk vs D2] ${bad.length ? bad.join('; ') : 'all within 5 %'}\n`);
    expect(bad).toEqual([]);
  }, 3_600_000);
});
