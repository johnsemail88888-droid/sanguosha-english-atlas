// Large-sample metrics run (opt-in: AI_SAMPLE=<n> npx vitest run tests/unit/ai/sample.test.ts).
// Prints the per-match table, aggregate win rates per mode and pacing; with
// AI_SAMPLE ≥ 24 it also asserts win-rate floors per mode (rebels ≥ 25 % in
// 乱世 and ≥ 20 % in standard, the lord side ≥ 20 % in both), hero-vs-hero contact
// well before the lord falls, and spread-out deaths. AI_MODE=chaos|standard runs
// one mode only (no floors).
// Used for tuning and for the report. Skipped in the normal test run.
import { describe, expect, it } from 'vitest';
import type { MatchMetrics, MatchSpec } from './harness';
import { formatSummary, formatTable, runMatch, summarize } from './harness';

const N = Number(process.env.AI_SAMPLE ?? 0);
const SEED0 = Number(process.env.AI_SEED ?? 1000);
const ONLY = process.env.AI_SPEC; // e.g. "8:standard:normal"
const MODE_ONLY = process.env.AI_MODE as 'standard' | 'chaos' | undefined; // one mode, every player count / difficulty

describe.skipIf(!(N > 0))('AI large sample', () => {
  it(`runs ${N} matches`, () => {
    const rows: MatchMetrics[] = [];
    const diffs = ['easy', 'normal', 'hard'] as const;
    const modes = ['standard', 'chaos'] as const;
    for (let i = 0; i < N; i++) {
      let spec: MatchSpec = {
        players: (5 + (i % 4)) as 5 | 6 | 7 | 8,
        mode: modes[Math.floor(i / 4) % 2],
        difficulty: diffs[Math.floor(i / 8) % 3],
        seed: SEED0 + i,
      };
      if (MODE_ONLY) spec = { ...spec, mode: MODE_ONLY };
      if (ONLY) {
        const [p, m, d] = ONLY.split(':');
        spec = { players: Number(p) as 5 | 6 | 7 | 8, mode: m as 'standard' | 'chaos', difficulty: d as 'easy' | 'normal' | 'hard', seed: SEED0 + i };
      }
      const r = runMatch(spec, { timing: true });
      rows.push(r);
      process.stdout.write(`[ai] ${i + 1}/${N} ${spec.players}p ${spec.mode} ${spec.difficulty} seed ${spec.seed}: ${r.winner} ${r.duration.toFixed(0)}s deaths ${JSON.stringify(r.deaths)} 1st hit ${r.firstHeroHitAt.toFixed(0)} dmg<180 ${r.heroDmgBefore180} push ${r.pushes}/${r.failedPushes} abil ${r.abilities} items ${r.items} aimed ${r.castsAimed}/${r.castTimeouts} m/min ${r.minMetersPerMinute} idle ${r.longestIdle} tick ${r.tickAvgMs.toFixed(2)}ms lordKilledLoyal ${r.lordKilledLoyal} | ${r.deathLog.join(' ')}\n`);
    }
    process.stdout.write(`\n${formatTable(rows)}\n`);
    const sum = summarize(rows);
    process.stdout.write(`\n${formatSummary(sum)}\n`);
    // win-rate floors per mode (only meaningful on a real sample: AI_SAMPLE ≥ 24, mixed modes).
    // G4 pacing (8–12 min matches): 乱世 rebels 33 % over 96 normal matches (5–8 seats; every
    // 乱世 variant now deals as many rebels as lord-side seats), standard 8p lord side ~40 %,
    // 5p ~62 %. A 24-match half has ±9 points of noise, so the floors sit below the means.
    if (N >= 24 && !ONLY && !MODE_ONLY) {
      const share = (mode: string, winner: string): number => {
        const m = sum.winsByMode[mode] ?? {};
        const n = Object.values(m).reduce((a, b) => a + b, 0);
        return n > 0 ? (m[winner] ?? 0) / n : 0;
      };
      expect(share('chaos', 'rebel'), '乱世 rebel win rate').toBeGreaterThanOrEqual(0.2);
      expect(share('standard', 'rebel'), 'standard rebel win rate').toBeGreaterThanOrEqual(0.2);
      expect(share('chaos', 'lord'), '乱世 lord win rate').toBeGreaterThanOrEqual(0.2);
      expect(share('standard', 'lord'), 'standard lord win rate').toBeGreaterThanOrEqual(0.2);
      expect(sum.medianFirstHit, 'median first hero-on-hero hit').toBeLessThanOrEqual(330);
      expect(sum.medianLordGap, 'median first hit → lord death').toBeGreaterThanOrEqual(60);
      expect(sum.meanDeathSpread, 'mean seconds between the first and the last death').toBeGreaterThanOrEqual(60);
    }
  }, 3_600_000);
});
