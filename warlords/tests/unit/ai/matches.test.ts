// Full all-bot matches on the real map (5–8 players, standard + 乱世, every
// difficulty, different seeds) with the metrics the AI is tuned for. Prints a
// summary table (winner, duration, deaths by cause, first hit / deaths, abilities
// / items used, aimed casts, pushes) and the pacing summary. The win-rate floors
// per mode are checked on the larger opt-in sample (sample.test.ts).
import { cpus, loadavg } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ROLE_BY_ID } from '../../../src/data';
import { FAILSAFE_TIME } from '../../../src/sim/rules';
import type { MatchMetrics, MatchSpec } from './harness';
import { formatSummary, formatTable, runMatch, summarize } from './harness';

// 8 matches (they run ~2× longer since the 8–12 min pacing, so the test's runtime stays about
// what 12 shorter ones took): every player count, both modes, every difficulty.
const SPECS: MatchSpec[] = [
  { players: 8, mode: 'standard', difficulty: 'normal', seed: 11 },
  { players: 8, mode: 'chaos', difficulty: 'hard', seed: 23 },
  { players: 5, mode: 'standard', difficulty: 'easy', seed: 5 },
  { players: 6, mode: 'standard', difficulty: 'hard', seed: 31 },
  { players: 7, mode: 'chaos', difficulty: 'normal', seed: 41 },
  { players: 8, mode: 'standard', difficulty: 'easy', seed: 53 },
  { players: 5, mode: 'chaos', difficulty: 'normal', seed: 67 },
  { players: 6, mode: 'standard', difficulty: 'normal', seed: 103 },
];

describe('AI full matches', () => {
  it(`${SPECS.length} bot matches: valid results, combat-decided, varied winners, 6–13 min, nobody stuck, tick budget`, () => {
    const rows: MatchMetrics[] = SPECS.map((s) => runMatch(s, { timing: true }));
    process.stdout.write(`\n[ai] ${rows.length} full bot matches\n${formatTable(rows)}\n`);
    for (const r of rows) process.stdout.write(`[ai] seed ${r.spec.seed} deaths: ${r.deathLog.join(' ')}\n`);

    // every match ends with a valid result, and no brain ever threw
    for (const r of rows) {
      expect(r.brainErrors).toEqual([]);
      const res = r.result;
      expect(res).toBeTruthy();
      expect(['lord', 'rebel', 'traitor', 'draw']).toContain(res.winner);
      expect(Object.keys(res.roles).length).toBe(r.spec.players);
      for (const id of res.winners) {
        const f = ROLE_BY_ID[res.roles[id]].faction;
        expect(f === res.winner || f === 'neutral').toBe(true);
      }
      expect(res.durationSec).toBeLessThanOrEqual(FAILSAFE_TIME + 1);
    }
    // ≥ 70 % decided by fighting before the final circle collapses
    const combat = rows.filter((r) => r.decidedByCombat).length / rows.length;
    expect(combat).toBeGreaterThanOrEqual(0.7);
    // different sides win
    const winners = new Set(rows.map((r) => r.winner));
    expect(winners.size).toBeGreaterThanOrEqual(2);
    // pacing (8–12 min target, the circle closes at 10:40): 6–13 minutes on average, hero-vs-hero
    // skirmishes long before the lord falls, deaths spread over the match
    const sum = summarize(rows);
    process.stdout.write(`${formatSummary(sum)}\n`);
    const avg = sum.avgDuration;
    expect(avg).toBeGreaterThanOrEqual(360);
    expect(avg).toBeLessThanOrEqual(780);
    expect(sum.medianFirstHit, 'median first hero-on-hero hit').toBeLessThanOrEqual(330);
    if (rows.filter((r) => Number.isFinite(r.lordDeathAt)).length >= 2) expect(sum.medianLordGap, 'median first hit → lord death').toBeGreaterThanOrEqual(45);
    expect(sum.meanDeathSpread, 'mean seconds between the first and the last death').toBeGreaterThanOrEqual(45);
    // nobody stuck: every living, standing bot covers ground every minute
    for (const r of rows) expect(r.minMetersPerMinute, `seed ${r.spec.seed}`).toBeGreaterThanOrEqual(10);
    // the lord almost never executes a loyalist
    expect(rows.reduce((s, r) => s + r.lordKilledLoyal, 0)).toBeLessThanOrEqual(1);
    // abilities and items are used
    for (const r of rows) {
      expect(r.abilities).toBeGreaterThan(0);
      expect(r.items).toBeGreaterThan(0);
    }
    // tick budget (8 bots + squads + NPCs): 4 ms on average, wall clock scaled by machine overload
    const overload = Math.max(1, loadavg()[0] / Math.max(1, cpus().length));
    const tickAvg = rows.reduce((s, r) => s + r.tickAvgMs, 0) / rows.length;
    process.stdout.write(`[ai] combat-decided ${(combat * 100).toFixed(0)}% · winners ${[...winners].join('/')} · avg ${avg.toFixed(0)} s · tick avg ${tickAvg.toFixed(2)} ms (overload ×${overload.toFixed(2)})\n`);
    expect(tickAvg).toBeLessThan(4 * overload);
  }, 900_000);
});
