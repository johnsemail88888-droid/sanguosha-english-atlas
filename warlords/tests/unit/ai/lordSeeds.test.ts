// The bot 主公 over 8 seeds (weapons spec D1b): the lord-burst gates the committed single-seed
// lordFocus.test.ts cannot see, judged against the game BEFORE the weapons spec on the same seeds
// (a fixed "< 200" rule fails the old game itself on two extra seeds). Heavy (≈ 80 scenes):
// opt-in with LORD_SEEDS=1.
//
//   LORD_SEEDS=1 npx vitest run tests/unit/ai/lordSeeds.test.ts
//
// Per lord, over seeds 1000 + k·1000 (k = 0…7; the rebelShot scene uses seed + 1):
//  - the fastest rebel-down (rebelFocus at 18 m, late game) is ≥ 3.0 s;
//  - the worst one-shot punishment (rebelShot at 8 m: damage in the worst second) is ≤ 1.15 × the
//    pre-spec game's worst;
//  - the fastest 濒死 → death is ≥ min(1.0 s, the pre-spec game's fastest).
import { describe, expect, it } from 'vitest';
import { LORD_CANDIDATE_IDS } from '../../../src/data';
import { runLordFocus } from './lordFocus';

/** The pre-spec game (commit 69d1163) on the same seeds: worst rebelShot peak / fastest 濒死 → death. */
export const LORD_BASELINE: Readonly<Record<string, { peak: number; downToDeath: number }>> = {
  caocao: { peak: 247, downToDeath: 1.33 },
  sunquan: { peak: 228, downToDeath: 2.27 },
  liubei: { peak: 204, downToDeath: 3.57 },
  zhangjiao: { peak: 245, downToDeath: 0.6 },
  yuanshao: { peak: 179, downToDeath: 1.73 },
};

const SEEDS = Number(process.env.LORD_SEEDS_N ?? 8);

export interface LordSeedRow {
  lord: string;
  downs: number[];
  downToDeath: number[];
  peaks: number[];
}

export function lordSeeds(lord: string, n = SEEDS): LordSeedRow {
  const row: LordSeedRow = { lord, downs: [], downToDeath: [], peaks: [] };
  for (let k = 0; k < n; k++) {
    const f = runLordFocus({ lord, scenario: 'rebelFocus', dist: 18, startAt: 400, seconds: 14, seed: 1000 + k * 1000 });
    row.downs.push(f.firstHitToDown);
    if (f.dead) row.downToDeath.push(f.firstHitToDeath - f.firstHitToDown);
    const s = runLordFocus({ lord, scenario: 'rebelShot', dist: 8, seconds: 6, seed: 1001 + k * 1000 });
    row.peaks.push(s.peak1s);
  }
  return row;
}

describe.runIf(process.env.LORD_SEEDS === '1')('the bot lord over 8 seeds (D1b)', () => {
  it('fastest rebel-down ≥ 3 s, worst one-shot punishment ≤ 1.15 × the old game, 濒死 → death ≥ min(1 s, the old game)', () => {
    const lines: string[] = [];
    const bad: string[] = [];
    for (const lord of LORD_CANDIDATE_IDS) {
      const r = lordSeeds(lord);
      const base = LORD_BASELINE[lord];
      const minDown = Math.min(...r.downs);
      const maxPeak = Math.max(...r.peaks);
      const minFin = r.downToDeath.length ? Math.min(...r.downToDeath) : Infinity;
      const f = (xs: number[], d = 2): string => xs.map((x) => (Number.isFinite(x) ? x.toFixed(d) : '—')).join(' ');
      lines.push(`${lord.padEnd(9)} down ${f(r.downs)} | min ${minDown.toFixed(2)}`);
      lines.push(`${''.padEnd(9)} down→dead ${f(r.downToDeath)} | min ${minFin.toFixed(2)} (old ${base?.downToDeath ?? '?'})`);
      lines.push(`${''.padEnd(9)} rebelShot peak ${f(r.peaks, 0)} | max ${maxPeak.toFixed(0)} (old ${base?.peak ?? '?'})`);
      if (minDown < 3) bad.push(`${lord} rebel down in ${minDown.toFixed(2)} s`);
      if (base && maxPeak > 1.15 * base.peak) bad.push(`${lord} peak ${maxPeak.toFixed(0)} > 1.15 × ${base.peak}`);
      if (base && minFin < Math.min(1, base.downToDeath) - 1e-9) bad.push(`${lord} 濒死 → death ${minFin.toFixed(2)} s < ${Math.min(1, base.downToDeath)}`);
    }
    process.stdout.write(`\n[lord seeds] ${SEEDS} seeds\n${lines.join('\n')}\n`);
    expect(bad).toEqual([]);
  }, 1_800_000);
});
