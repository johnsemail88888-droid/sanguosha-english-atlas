// Large-sample metrics run (opt-in: AI_SAMPLE=<n> npx vitest run tests/unit/ai/sample.test.ts).
// Prints the per-match table and aggregate win rates; used for tuning and for
// the report. Skipped in the normal test run (it takes minutes).
import { describe, it } from 'vitest';
import type { MatchMetrics, MatchSpec } from './harness';
import { formatTable, runMatch } from './harness';

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
      process.stdout.write(`[ai] ${i + 1}/${N} ${spec.players}p ${spec.mode} ${spec.difficulty} seed ${spec.seed}: ${r.winner} ${r.duration.toFixed(0)}s deaths ${JSON.stringify(r.deaths)} abil ${r.abilities} items ${r.items} m/min ${r.minMetersPerMinute} idle ${r.longestIdle} tick ${r.tickAvgMs.toFixed(2)}ms lordKilledLoyal ${r.lordKilledLoyal} | ${r.deathLog.join(' ')}\n`);
    }
    process.stdout.write(`\n${formatTable(rows)}\n`);
    const wins: Record<string, number> = {};
    for (const r of rows) wins[r.winner] = (wins[r.winner] ?? 0) + 1;
    const avg = rows.reduce((s, r) => s + r.duration, 0) / rows.length;
    const combat = rows.filter((r) => r.decidedByCombat).length / rows.length;
    process.stdout.write(`\nwins ${JSON.stringify(wins)} avg ${avg.toFixed(0)}s combat ${(combat * 100).toFixed(0)}%\n`);
  }, 3_600_000);
});
