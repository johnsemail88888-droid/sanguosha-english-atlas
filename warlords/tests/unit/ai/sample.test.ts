// Large-sample metrics run (opt-in: AI_SAMPLE=<n> npx vitest run tests/unit/ai/sample.test.ts).
// Prints the per-match table, aggregate win rates per mode and pacing; with
// AI_SAMPLE ≥ 24 it also asserts win-rate floors per mode (rebels and the lord
// side each win ≥ 20 % in standard AND 乱世) and early skirmishes. Used for
// tuning and for the report. Skipped in the normal test run (it takes minutes).
import { describe, expect, it } from 'vitest';
import type { MatchMetrics, MatchSpec } from './harness';
import { formatSummary, formatTable, runMatch, summarize } from './harness';

const N = Number(process.env.AI_SAMPLE ?? 0);
const SEED0 = Number(process.env.AI_SEED ?? 1000);
const ONLY = process.env.AI_SPEC; // e.g. "8:standard:normal"

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
    // win-rate floors per mode (only meaningful on a real sample: AI_SAMPLE ≥ 24, mixed modes)
    if (N >= 24 && !ONLY) {
      const share = (mode: string, winner: string): number => {
        const m = sum.winsByMode[mode] ?? {};
        const n = Object.values(m).reduce((a, b) => a + b, 0);
        return n > 0 ? (m[winner] ?? 0) / n : 0;
      };
      expect(share('chaos', 'rebel'), '乱世 rebel win rate').toBeGreaterThanOrEqual(0.2);
      expect(share('standard', 'rebel'), 'standard rebel win rate').toBeGreaterThanOrEqual(0.2);
      expect(share('chaos', 'lord'), '乱世 lord win rate').toBeGreaterThanOrEqual(0.2);
      expect(share('standard', 'lord'), 'standard lord win rate').toBeGreaterThanOrEqual(0.2);
      expect(sum.earlyDamageShare, 'matches with hero damage before 180 s').toBeGreaterThanOrEqual(0.6);
    }
  }, 3_600_000);
});
