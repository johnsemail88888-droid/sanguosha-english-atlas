import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import type { GameMode, RoleId } from '../../../src/core/types';
import { ROLE_DISTRIBUTION } from '../../../src/data/roles';
import {
  botPickHero,
  crownSeats,
  dealRoles,
  generalPhaseOptions,
  heroSuitability,
  lordPhaseOptions,
  roleDealViewFor,
  visibleLordSeat,
} from '../../../src/net/flow';
import { generateRoomCode, isValidRoomCode, normalizeRoomCode, ROOM_ALPHABET } from '../../../src/net/roomCode';
import { testHeroPool } from './fixtures';

const count = (roles: RoleId[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of [...roles].sort()) out[r] = (out[r] ?? 0) + 1;
  return out;
};

describe('dealRoles', () => {
  for (const mode of ['standard', 'chaos'] as GameMode[]) {
    for (const n of [5, 6, 7, 8] as const) {
      it(`${mode} ${n} players deals one of the official variants`, () => {
        const variants = ROLE_DISTRIBUTION[mode][n].map((v) => JSON.stringify(count(v)));
        const lordSeats = new Set<number>();
        for (let seed = 1; seed <= 60; seed++) {
          const deal = dealRoles(mode, n, new Rng(seed));
          expect(deal.roles).toHaveLength(n);
          expect(variants).toContain(JSON.stringify(count(deal.roles)));
          expect(deal.roles[deal.lordSeat]).toBe('lord');
          expect(deal.roles.filter((r) => r === 'lord')).toHaveLength(1);
          lordSeats.add(deal.lordSeat);
          if (deal.doubleSeat !== null) expect(deal.roles[deal.doubleSeat]).toBe('double');
          for (const [hunter, target] of Object.entries(deal.bountyTargets)) {
            expect(deal.roles[Number(hunter)]).toBe('bounty');
            expect(Number(hunter)).not.toBe(target);
            expect(['lord', 'double']).not.toContain(deal.roles[target]);
          }
          if (deal.roles.includes('bounty')) expect(Object.keys(deal.bountyTargets)).toHaveLength(1);
        }
        // the lord seat is random, not always 0
        expect(lordSeats.size).toBeGreaterThan(2);
      });
    }
  }

  it('standard counts match the official table', () => {
    const expected: Record<number, Record<string, number>> = {
      5: { lord: 1, loyalist: 1, rebel: 2, traitor: 1 },
      6: { lord: 1, loyalist: 1, rebel: 3, traitor: 1 },
      7: { lord: 1, loyalist: 2, rebel: 3, traitor: 1 },
      8: { lord: 1, loyalist: 2, rebel: 4, traitor: 1 },
    };
    for (const n of [5, 6, 7, 8]) expect(count(dealRoles('standard', n, new Rng(n)).roles)).toEqual(expected[n]);
  });
});

describe('role visibility', () => {
  it('only the lord learns which crown is the double', () => {
    // find a chaos deal with a double
    let deal = dealRoles('chaos', 8, new Rng(1));
    for (let s = 2; deal.doubleSeat === null; s++) deal = dealRoles('chaos', 8, new Rng(s));
    const d = deal.doubleSeat as number;
    const lordView = roleDealViewFor(deal, deal.lordSeat);
    expect(lordView.publicRoles[d]).toBe('double');
    for (let seat = 0; seat < 8; seat++) {
      const v = roleDealViewFor(deal, seat);
      expect(v.yourRole).toBe(deal.roles[seat]);
      const publicSeats = Object.keys(v.publicRoles).map(Number).sort();
      expect(publicSeats).toEqual(crownSeats(deal).sort());
      if (seat !== deal.lordSeat) {
        expect(v.publicRoles[d]).toBe('lord');
        expect(v.publicRoles[deal.lordSeat]).toBe('lord');
      }
      if (deal.roles[seat] !== 'bounty') expect(v.bountySeat).toBeUndefined();
      // observers see the lowest crown as "lord seat" — never the truth by accident of role
      const vis = visibleLordSeat(deal, seat);
      if (seat === deal.lordSeat || seat === d) expect(vis).toBe(deal.lordSeat);
      else expect(vis).toBe(Math.min(deal.lordSeat, d));
    }
  });
});

describe('hero options', () => {
  const pool = testHeroPool();

  it('lord options = every lord candidate + 3 others, crowns never share extras', () => {
    const opts = lordPhaseOptions(pool, [2, 5], 3, new Rng(9));
    for (const seat of [2, 5]) {
      expect(opts[seat]).toHaveLength(8);
      for (let i = 0; i < 5; i++) expect(opts[seat]).toContain(`hero${i}`);
    }
    const extras2 = opts[2].filter((id) => !pool.find((h) => h.id === id)!.lordCandidate);
    const extras5 = opts[5].filter((id) => !pool.find((h) => h.id === id)!.lordCandidate);
    expect(extras2.some((id) => extras5.includes(id))).toBe(false);
  });

  it('general options are unique across seats and exclude taken heroes', () => {
    const taken = new Set(['hero0', 'hero7']);
    const seats = [0, 1, 2, 3, 4, 5, 6];
    const opts = generalPhaseOptions(pool, seats, 3, taken, new Rng(4));
    const all = seats.flatMap((s) => opts[s]);
    expect(all).toHaveLength(21);
    expect(new Set(all).size).toBe(21);
    for (const id of all) expect(taken.has(id)).toBe(false);
  });

  it('degrades gracefully with a tiny pool', () => {
    const tiny = pool.slice(0, 2);
    const opts = generalPhaseOptions(tiny, [0, 1, 2], 3, new Set(), new Rng(1));
    for (const s of [0, 1, 2]) expect(opts[s].length).toBeGreaterThan(0);
    const lord = lordPhaseOptions(pool.slice(10, 11), [0], 3, new Rng(1));
    expect(lord[0]).toEqual(['hero10']);
  });

  it('bots prefer heroes that suit their role', () => {
    const byId = Object.fromEntries(pool.map((h) => [h.id, h]));
    // a lord bot offered lord candidates + non-candidates picks a candidate almost always
    let lordPicks = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const pick = botPickHero(['hero10', 'hero0', 'hero11', 'hero1'], 'lord', byId, new Rng(seed));
      if (byId[pick].lordCandidate) lordPicks++;
    }
    expect(lordPicks).toBeGreaterThanOrEqual(45);
    expect(heroSuitability(byId.hero0, 'lord')).toBeGreaterThan(heroSuitability(byId.hero10, 'lord'));
  });
});

describe('room codes', () => {
  it('generates valid codes and normalizes input', () => {
    for (let i = 0; i < 200; i++) {
      const c = generateRoomCode();
      expect(isValidRoomCode(c)).toBe(true);
      for (const ch of c) expect(ROOM_ALPHABET).toContain(ch);
    }
    expect(normalizeRoomCode(' abc-de ')).toBe('ABCDE');
    expect(normalizeRoomCode('sgwl-XYZ23')).toBe('XYZ23');
    expect(normalizeRoomCode('https://x.io/?room=k7m9p')).toBe('K7M9P');
    expect(normalizeRoomCode('ABC0E')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeRoomCode('ABCD')).toBeNull();
  });
});
