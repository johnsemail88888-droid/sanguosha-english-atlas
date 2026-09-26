// NP-5: a bot 主公 picks near-uniformly among the lord candidates, dealt (5 candidates + 3 others)
// and in 自由选将 alike. Before: the +3 candidate bonus and the 4-HP tank bonus decided it —
// 袁绍 60 % / 刘备 27.5 / 曹操 11.8 / 孙权 0.8 / 张角 0 dealt (pt3-newplayer lordpick.test.ts).
import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { HEROES, HERO_BY_ID } from '../../../src/data';
import { botFreePickHero, botPickHero, lordPhaseOptions } from '../../../src/net/flow';

const CANDIDATES = HEROES.filter((h) => h.lordCandidate).map((h) => h.id);
const N = 4000;

function shares(pick: (rng: Rng) => string): Record<string, number> {
  const rng = new Rng(12345);
  const n: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    const id = pick(rng);
    n[id] = (n[id] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v / N]));
}

describe('NP-5: the bot lord pick', () => {
  it('dealt: every lord candidate 20 % ± 4, never a non-candidate', () => {
    const s = shares((rng) => botPickHero(lordPhaseOptions(HEROES, [0], 3, rng)[0], 'lord', HERO_BY_ID, rng));
    process.stdout.write(`[NP-5 dealt] ${JSON.stringify(s)}\n`);
    expect(CANDIDATES.length).toBe(5);
    for (const id of CANDIDATES) {
      expect(s[id] ?? 0, id).toBeGreaterThan(0.16);
      expect(s[id] ?? 0, id).toBeLessThan(0.24);
    }
    expect(Object.keys(s).every((id) => CANDIDATES.includes(id))).toBe(true);
  });

  it('自由选将: every lord candidate 20 % ± 4', () => {
    const all = HEROES.map((h) => h.id);
    const s = shares((rng) => botFreePickHero(all, 'lord', HERO_BY_ID, rng, { crown: true, choices: 3, extra: 3 }));
    process.stdout.write(`[NP-5 free] ${JSON.stringify(s)}\n`);
    for (const id of CANDIDATES) {
      expect(s[id] ?? 0, id).toBeGreaterThan(0.16);
      expect(s[id] ?? 0, id).toBeLessThan(0.24);
    }
  });

  it('other roles still pick by suitability (a lord pick among no candidates falls back to it too)', () => {
    const rng = new Rng(7);
    const others = HEROES.filter((h) => !h.lordCandidate).map((h) => h.id);
    const opts = others.slice(0, 3);
    for (let i = 0; i < 20; i++) expect(opts).toContain(botPickHero(opts, 'lord', HERO_BY_ID, rng));
    for (let i = 0; i < 20; i++) expect(opts).toContain(botPickHero(opts, 'rebel', HERO_BY_ID, rng));
  });
});
