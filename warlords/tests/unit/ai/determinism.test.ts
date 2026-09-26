// The AI keeps the host deterministic: identical seeds → identical matches
// (bots use their own seeded RNG and sim time only — no wall clock).
import { describe, expect, it } from 'vitest';
import { createWorld } from '../../../src/sim/world';
import { makeBotInit, realMap } from './harness';

function fingerprint(seed: number, ticks: number): string {
  const w = createWorld(makeBotInit({ players: 8, mode: 'chaos', difficulty: 'hard', seed }), { map: realMap(), onWarn: () => {} });
  let events = 0;
  for (let i = 0; i < ticks && !w.result(); i++) {
    w.step();
    events += w.drainEvents().length;
  }
  const heroes = w.heroList().map((h) => [h.id, Math.round(h.pos.x * 100), Math.round(h.pos.z * 100), Math.round(h.hp), h.hero!.claim, h.hero!.stats.kills]);
  return JSON.stringify({ events, heroes, troops: w.kindList('troop').length, tick: w.tick });
}

describe('determinism', () => {
  it('same seed, same bot match', () => {
    const a = fingerprint(4242, 30 * 150);
    const b = fingerprint(4242, 30 * 150);
    expect(a).toBe(b);
  }, 120_000);
});
