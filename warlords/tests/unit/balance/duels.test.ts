// Weapon duels between bots (duelHarness.ts; weapons spec D4) — a regression net for the class
// roles, not the design target (the bots' 1.7° aim-error floor over-rewards guns that fire more
// often at 80 m; the targets are D2 weaponsDps and D3 ttkBands).
//
// The default run is a cheap regression (≈ 10 s). The full study is opt-in:
//
//   DUEL_STUDY=1 DUEL_PASS=normal DUEL_OUT=/some/dir npx vitest run tests/unit/balance/duels.test.ts
//
// DUEL_PASS: normal (normal-skill bots, no armor) | hard | armor (both wear DUEL_ARMOR, default 藤甲)
// DUEL_TIMEOUT: seconds before a duel is a draw / a TTK run counts as ∞ (default 40).
// DUEL_N: seeds per cell (default 20). DUEL_WEAPONS / DUEL_CORE: comma lists to override the sets.
// DUEL_EXTRAS=0 skips the extra-weapons-vs-carbine duels. DUEL_TAG names the output files.
// DUEL_SIDEARM: the sidearm both sides carry in slot 2 (default pistol, as a bot spawns; 'none' =
// the weapon alone). A bot only draws it inside its primary's minimum range (sidearmInside: a
// scope or bow inside 12 m, a launcher inside its arming distance) — how a bot plays those guns.
// DUEL_STRICT=1 asserts the spec's role targets (D4) instead of only printing them.
// Writes ttk_<tag>.csv, duels_<tag>.csv and summary_<tag>.md to DUEL_OUT (and prints the summary).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BotDifficulty } from '../../../src/core/types';
import { HEROES, WEAPONS } from '../../../src/data';
import type { WeaponDef } from '../../../src/data/types';
import type { DuelOpts, DuelResult } from './duelHarness';
import { fairDuel, median, raceWinRate, runDuel, runTtk } from './duelHarness';

export const RANGES = [6, 15, 30, 50, 80] as const;
const SIGNATURES = new Set(HEROES.map((h) => h.signatureWeapon));
/** every weapon a player can hold: lootable guns + hero signatures (no troop / NPC / melee) */
export const PLAYER_WEAPONS: WeaponDef[] = WEAPONS.filter((w) => !w.melee && (w.lootable || SIGNATURES.has(w.id)));
/** one representative per class (the round-robin field) */
export const CORE = ['pistol', 'smg', 'carbine', 'qinggang', 'qilin', 'huben', 'guding', 'liegong', 'jiguan', 'zhuque', 'guanshi'];

const env = process.env;
const STUDY = env.DUEL_STUDY === '1';
const PASS = env.DUEL_PASS ?? 'normal';
const N = Number(env.DUEL_N ?? 20);
const OUT = env.DUEL_OUT ?? join(process.cwd(), 'duel-study');
const TIMEOUT = Number(env.DUEL_TIMEOUT ?? 40);
const TAG = env.DUEL_TAG ?? PASS;
const SIDEARM = env.DUEL_SIDEARM === 'none' ? null : (env.DUEL_SIDEARM ?? 'pistol');

interface PassCfg {
  skill: BotDifficulty;
  armor: string | null;
}
const PASSES: Record<string, PassCfg> = {
  normal: { skill: 'normal', armor: null },
  hard: { skill: 'hard', armor: null },
  armor: { skill: 'normal', armor: env.DUEL_ARMOR ?? 'tengjia' },
};

const byId = new Map(WEAPONS.map((w) => [w.id, w]));
const cls = (id: string): string => byId.get(id)?.class ?? '?';
const fmtT = (t: number): string => (Number.isFinite(t) ? t.toFixed(1) : '∞');
const pct = (x: number): string => (Number.isFinite(x) ? `${Math.round(x * 100)}` : '–');

export interface RoleTarget {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The spec's D4 role targets on the core round robin + the extras-vs-carbine duels.
 * `field(a, r)` = a's mean win rate vs the rest of the core field at r m; `rank` 1 = best;
 * `vs(a, b, r)` = a's win rate against b.
 */
export function roleTargets(
  core: string[],
  field: (a: string, r: number) => number,
  rank: (a: string, r: number) => number,
  vs: (a: string, b: string, r: number) => number | undefined,
  pass: string,
): RoleTarget[] {
  const have = (...ids: string[]): boolean => ids.every((id) => core.includes(id));
  const f = (a: string, r: number): string => `${a}@${r} ${Math.round(field(a, r) * 100)}% (#${rank(a, r)})`;
  const out: RoleTarget[] = [];
  const push = (name: string, ok: boolean, detail: string): void => void out.push({ name, ok, detail });
  const p = (x: number | undefined): string => (x === undefined ? '?' : `${Math.round(x * 100)}%`);
  if (have('guding', 'zhuque')) push('zhuque or guding is #1–2 at 6 m', Math.min(rank('guding', 6), rank('zhuque', 6)) <= 2, `${f('guding', 6)}, ${f('zhuque', 6)}`);
  if (have('guding')) push('guding ≥ 65 at 6 m and ≤ 20 at 30 m', field('guding', 6) >= 0.65 && field('guding', 30) <= 0.2, `${f('guding', 6)}, ${f('guding', 30)}`);
  if (have('smg', 'carbine', 'huben', 'jiguan', 'liegong')) {
    const losses = ['carbine', 'huben', 'jiguan', 'liegong'].map((b) => vs('smg', b, 30) ?? NaN);
    push('smg ≥ 65 at 6 m and loses ≥ 70 % to the carbine, huben, jiguan and liegong at 30 m', field('smg', 6) >= 0.65 && losses.every((x) => x <= 0.3), `${f('smg', 6)}; smg at 30 m vs carbine/huben/jiguan/liegong ${losses.map((x) => p(x)).join('/')}`);
  }
  if (have('carbine')) push('carbine top 3 at 30 m', rank('carbine', 30) <= 3, f('carbine', 30));
  if (have('huben')) push('huben not #1 at 6 m and ≤ 85 everywhere', rank('huben', 6) > 1 && RANGES.every((r) => field('huben', r) <= 0.85), RANGES.map((r) => f('huben', r)).join(', '));
  const ft15 = vs('fangtian', 'carbine', 15);
  const ft30 = vs('fangtian', 'carbine', 30);
  const ft50 = vs('fangtian', 'carbine', 50);
  if (ft15 !== undefined) push('fangtian vs carbine ≤ 60 at 15 and 30 m, ≤ 10 at 50 m', (ft15 ?? 1) <= 0.6 && (ft30 ?? 1) <= 0.6 && (ft50 ?? 1) <= 0.1, `${p(ft15)} / ${p(ft30)} / ${p(ft50)}`);
  if (have('qilin')) push('qilin ≥ 75 at 80 m and ≤ 40 at 6 m', field('qilin', 80) >= 0.75 && field('qilin', 6) <= 0.4, `${f('qilin', 80)}, ${f('qilin', 6)}`);
  if (have('qilin', 'liegong')) {
    const h2h = vs('qilin', 'liegong', 80);
    push('qilin beats liegong head to head at 80 m (≥ 55 %) and field(liegong) ≤ field(qilin) + 5 at 80 m', (h2h ?? 0) >= 0.55 && field('liegong', 80) <= field('qilin', 80) + 0.05, `h2h ${p(h2h)}; ${f('liegong', 80)} vs ${f('qilin', 80)}`);
  }
  if (pass === 'armor' && have('qinggang')) push('qinggang ≤ 80 at every range (armor pass)', RANGES.every((r) => field('qinggang', r) <= 0.8), RANGES.map((r) => f('qinggang', r)).join(', '));
  const top3 = core.filter((a) => [6, 15, 30, 50].filter((r) => rank(a, r) <= 3).length >= 4);
  push('no weapon top 3 at all of 6 / 15 / 30 / 50 m', top3.length === 0, top3.length ? top3.join(', ') : 'none');
  return out;
}

describe.runIf(STUDY)(`weapon duel study (${PASS})`, () => {
  it('runs', () => {
    const cfg = PASSES[PASS];
    expect(cfg, `unknown DUEL_PASS ${PASS}`).toBeDefined();
    const base = { skill: cfg.skill, armor: cfg.armor, timeout: TIMEOUT, sidearm: SIDEARM };
    const all = env.DUEL_WEAPONS ? env.DUEL_WEAPONS.split(',') : PLAYER_WEAPONS.map((w) => w.id);
    const core = env.DUEL_CORE ? env.DUEL_CORE.split(',') : CORE;
    mkdirSync(OUT, { recursive: true });
    const t0 = performance.now();
    const md: string[] = [`# Duel study — pass \`${PASS}\` (skill ${cfg.skill}, armor ${cfg.armor ?? 'none'}, sidearm ${SIDEARM ?? 'none'}, N=${N}/cell)`, ''];

    // ── 1. one-sided TTK vs a strafing, non-shooting 400 HP target ──
    const ttk = new Map<string, number[]>();
    const acc = new Map<string, { shots: number; hits: number; heads: number }>();
    const ttkRows = ['weapon,class,range,seed,ttk,shots,hits,heads,dmg'];
    for (const id of all) {
      for (const r of RANGES) {
        const xs: number[] = [];
        const a = { shots: 0, hits: 0, heads: 0 };
        for (let s = 1; s <= N; s++) {
          const res = runTtk(id, { ...base, dist: r, seed: 1000 + s });
          xs.push(res.t);
          a.shots += res.side.shots;
          a.hits += res.side.hits;
          a.heads += res.side.heads;
          ttkRows.push(`${id},${cls(id)},${r},${s},${Number.isFinite(res.t) ? res.t.toFixed(3) : 'inf'},${res.side.shots},${res.side.hits},${res.side.heads},${res.side.dmg.toFixed(1)}`);
        }
        ttk.set(`${id}@${r}`, xs);
        acc.set(`${id}@${r}`, a);
      }
    }
    writeFileSync(join(OUT, `ttk_${TAG}.csv`), ttkRows.join('\n') + '\n');
    md.push(`## Median TTK (s) vs a strafing, non-shooting 400 HP dummy (from the duel start; ∞ = not downed in ${TIMEOUT} s in ≥ half the runs)`, '');
    md.push(`| weapon | class | ${RANGES.map((r) => `${r} m`).join(' | ')} | hit% by range |`);
    md.push(`|---|---|${RANGES.map(() => '---').join('|')}|---|`);
    for (const id of all) {
      const meds = RANGES.map((r) => fmtT(median(ttk.get(`${id}@${r}`)!)));
      const hits = RANGES.map((r) => {
        const a = acc.get(`${id}@${r}`)!;
        return pct(a.shots ? a.hits / a.shots : NaN);
      });
      md.push(`| ${id} | ${cls(id)} | ${meds.join(' | ')} | ${hits.join('/')} |`);
    }
    md.push('');

    // ── 2. round-robin duels among the core set, extras vs the carbine ──
    const duelRows = ['a,b,range,seed,winner,t,a_shots,a_hits,a_dmg,b_shots,b_hits,b_dmg'];
    const wr = new Map<string, number>();
    const record = (a: string, b: string, r: number, s: number, res: DuelResult): number => {
      duelRows.push(`${a},${b},${r},${s},${res.winner},${res.t.toFixed(3)},${res.sides[0].shots},${res.sides[0].hits},${res.sides[0].dmg.toFixed(1)},${res.sides[1].shots},${res.sides[1].hits},${res.sides[1].dmg.toFixed(1)}`);
      return res.winner === -1 ? 0.5 : res.winner === 0 ? 1 : 0;
    };
    const duelSet = (a: string, b: string): void => {
      for (const r of RANGES) {
        let sum = 0;
        for (let s = 1; s <= N; s++) sum += record(a, b, r, s, fairDuel(a, b, { ...base, dist: r, seed: 5000 + s }));
        wr.set(`${a}|${b}@${r}`, sum / N);
        wr.set(`${b}|${a}@${r}`, 1 - sum / N);
      }
    };
    for (let i = 0; i < core.length; i++) for (let j = i + 1; j < core.length; j++) duelSet(core[i], core[j]);
    const extras = env.DUEL_EXTRAS === '0' ? [] : all.filter((id) => !core.includes(id));
    for (const id of extras) if (id !== 'carbine') duelSet(id, 'carbine');
    writeFileSync(join(OUT, `duels_${TAG}.csv`), duelRows.join('\n') + '\n');
    const field = (a: string, r: number): number => {
      const xs = core.filter((b) => b !== a && wr.has(`${a}|${b}@${r}`)).map((b) => wr.get(`${a}|${b}@${r}`)!);
      return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : NaN;
    };
    const rankOf = (a: string, r: number): number => 1 + core.filter((b) => b !== a && field(b, r) > field(a, r)).length;
    for (const r of RANGES) {
      md.push(`## ${r} m — row's win % vs column (N=${N}, draws ½)`, '');
      md.push(`| vs → | ${core.join(' | ')} | **field avg** |`);
      md.push(`|---|${core.map(() => '---').join('|')}|---|`);
      for (const a of core) md.push(`| **${a}** (${cls(a)}) | ${core.map((b) => (a === b ? '·' : pct(wr.get(`${a}|${b}@${r}`)!))).join(' | ')} | **${pct(field(a, r))}** |`);
      md.push('', `Ranking: ${[...core].sort((p, q) => field(q, r) - field(p, r)).map((id) => `${id} ${pct(field(id, r))}`).join(' > ')}`, '');
    }
    if (extras.length) {
      md.push('## Other weapons vs the carbine — win % (race-model prediction)', '');
      md.push(`| weapon | class | ${RANGES.map((r) => `${r} m`).join(' | ')} |`);
      md.push(`|---|---|${RANGES.map(() => '---').join('|')}|`);
      for (const id of extras) {
        if (id === 'carbine') continue;
        md.push(`| ${id} | ${cls(id)} | ${RANGES.map((r) => `${pct(wr.get(`${id}|carbine@${r}`)!)} (${pct(raceWinRate(ttk.get(`${id}@${r}`)!, ttk.get(`carbine@${r}`)!))})`).join(' | ')} |`);
      }
      md.push('');
    }
    // behaviour: the grenade launcher's sidearm inside 10 m (C10-11)
    let sidearm = 0;
    let gl = 0;
    for (let s = 1; s <= Math.min(N, 10); s++) {
      const res = runDuel('guanshi', 'carbine', { ...base, dist: 6, seed: 7000 + s, sidearm: 'pistol' });
      sidearm += res.sides[0].sidearmShots;
      gl += res.sides[0].shots - res.sides[0].sidearmShots;
    }
    const targets = roleTargets(core, field, rankOf, (a, b, r) => wr.get(`${a}|${b}@${r}`), PASS);
    targets.push({ name: 'guanshi bot uses its sidearm inside 10 m', ok: sidearm > 0 && gl === 0, detail: `6 m: ${sidearm} sidearm shots, ${gl} grenades` });
    md.push('## Role targets (D4)', '');
    for (const t of targets) md.push(`- ${t.ok ? '✓' : '✗'} ${t.name} — ${t.detail}`);
    md.push('', `(total ${((performance.now() - t0) / 1000).toFixed(0)} s wall)`);
    writeFileSync(join(OUT, `summary_${TAG}.md`), md.join('\n') + '\n');
    process.stdout.write(`\n${md.join('\n')}\n`);
    if (env.DUEL_STRICT === '1') expect(targets.filter((t) => !t.ok).map((t) => t.name)).toEqual([]);
  }, 3_600_000);
});

// Cheap default checks: the harness is fair and the clearest class roles hold.
describe.runIf(!STUDY)('weapon duels (quick regression)', () => {
  const rate = (a: string, b: string, dist: number, n = 12, o: Partial<DuelOpts> = {}): number => {
    let s = 0;
    for (let i = 1; i <= n; i++) {
      const r = fairDuel(a, b, { dist, seed: 9000 + i, timeout: 30, ...o });
      s += r.winner === -1 ? 0.5 : r.winner === 0 ? 1 : 0;
    }
    return s / n;
  };
  it('mirror duels are fair (seats swapped on odd seeds)', () => {
    const w = rate('carbine', 'carbine', 15, 16);
    expect(w).toBeGreaterThanOrEqual(0.2);
    expect(w).toBeLessThanOrEqual(0.8);
  });
  it('a shotgun beats the carbine at 6 m and loses at 30 m', () => {
    expect(rate('guding', 'carbine', 6)).toBeGreaterThanOrEqual(0.6);
    expect(rate('guding', 'carbine', 30)).toBeLessThanOrEqual(0.1);
  });
  it('the sniper beats the carbine at 80 m', () => {
    expect(rate('qilin', 'carbine', 80)).toBeGreaterThanOrEqual(0.7);
  });
  it('a grenade-launcher bot fights inside 10 m with its sidearm, never its launcher', () => {
    let sidearm = 0;
    let grenades = 0;
    for (let s = 1; s <= 4; s++) {
      const r = runDuel('guanshi', 'carbine', { dist: 6, seed: 7000 + s, timeout: 10, sidearm: 'pistol' });
      sidearm += r.sides[0].sidearmShots;
      grenades += r.sides[0].shots - r.sides[0].sidearmShots;
    }
    expect(sidearm).toBeGreaterThan(0);
    expect(grenades).toBe(0);
  });
}, 120_000);
