// Opt-in balance / pacing sample (playtest round 2): headless all-bot matches on the real map,
// one JSON line per match with the per-hero results, casts, item uses, claims and the death log.
//   BAL_N=24 BAL_SEED=7000 BAL_OUT=/path/out.jsonl nice -n 15 npx vitest run tests/unit/ai/bal.test.ts
// BAL_P (players, default 8), BAL_D (difficulty, default normal), BAL_MODE (standard|chaos).
// Skipped in the normal test run.
import { appendFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { createWorld } from '../../../src/sim/world';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { FAILSAFE_TIME } from '../../../src/sim/rules';
import { makeBotInit, realMap } from './harness';

const N = Number(process.env.BAL_N ?? 0);
const OUT = process.env.BAL_OUT ?? '/dev/null';
const SEED0 = Number(process.env.BAL_SEED ?? 7000);
const PLAYERS = Number(process.env.BAL_P ?? 8) as 5 | 6 | 7 | 8;
const DIFF = (process.env.BAL_D ?? 'normal') as 'easy' | 'normal' | 'hard';
const MODE = (process.env.BAL_MODE ?? 'standard') as 'standard' | 'chaos';

describe.skipIf(!(N > 0))('balance sample', () => {
  it(`runs ${N} matches`, () => {
    for (let k = 0; k < N; k++) {
      const seed = SEED0 + k;
      const init = makeBotInit({ players: PLAYERS, mode: MODE, difficulty: DIFF, seed });
      const warns: string[] = [];
      const w = createWorld(init, { map: realMap(), onWarn: (m) => void (warns.length < 30 && warns.push(m)), botFactory: (seat, d, s) => new HeroBot(seat, d, s) });
      const heroes = w.heroList();
      const abil: Record<string, number> = {};
      const items: Record<string, number> = {};
      const claims: string[] = [];
      const killLog: string[] = [];
      const name = (id: number | undefined): string => {
        const e = id !== undefined ? w.get(id) : undefined;
        return e?.hero ? `${e.hero.heroId}(${e.hero.role})` : e ? e.kind : 'env';
      };
      const maxTicks = Math.ceil((FAILSAFE_TIME + 5) * 30);
      for (let i = 0; i < maxTicks && !w.result(); i++) {
        w.step();
        for (const ev of w.drainEvents()) {
          if (ev.t === 'ability') abil[ev.ability] = (abil[ev.ability] ?? 0) + 1;
          else if (ev.t === 'itemUse') items[ev.item] = (items[ev.item] ?? 0) + 1;
          else if (ev.t === 'claim') claims.push(`${Math.round(w.time)}:${name(ev.who)}=>${ev.role}`);
          else if (ev.t === 'death' && ev.kind === 'hero') killLog.push(`${Math.round(w.time)}:${name(ev.target)}<${name(ev.killer)}`);
        }
      }
      const r = w.result()!;
      const rec = {
        seed,
        players: PLAYERS,
        diff: DIFF,
        mode: MODE,
        winner: r.winner,
        dur: Math.round(r.durationSec),
        heroes: heroes.map((h) => ({ id: h.hero!.heroId, role: h.hero!.role, won: r.winners.includes(h.id), alive: !h.hero!.dead, dmg: Math.round(h.hero!.stats.damage), kills: h.hero!.stats.kills })),
        abil,
        items,
        claims,
        killLog,
        warns,
      };
      appendFileSync(OUT, `${JSON.stringify(rec)}\n`);
      process.stdout.write(`[bal] seed ${seed}: ${r.winner} ${rec.dur}s deaths ${killLog.join(' ')}\n`);
    }
  }, 7_200_000);
});
