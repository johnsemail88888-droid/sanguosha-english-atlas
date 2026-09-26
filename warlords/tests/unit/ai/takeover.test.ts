// A bot taking over a dropped player's seat (World.convertToBot) keeps the
// player's public 跳身份 claim and stays quiet for a while: an instant new claim
// (or a flip from 反贼 to 忠臣) would give the takeover — and the role — away.
import { describe, expect, it } from 'vitest';
import type { RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const STD5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

function claimTimeline(seat: number, claim: RoleId | null, seconds: number, startAt = 40): { claims: (RoleId | null)[]; events: number } {
  const w = makeWorld(STD5, { humans: [seat], squads: false });
  STD5.forEach((_, i) => place(w, hero(w, i), i * 10 - 20, 30 + (i % 2) * 6));
  const me = hero(w, seat);
  // the human plays for a while, claims, then drops
  stepN(w, startAt * 30);
  if (claim) {
    w.setInput(`p${seat}`, { ...emptyInput(1), actions: [{ a: 'claim', role: claim }] });
    w.step();
  }
  expect(me.hero!.claim).toBe(claim);
  w.drainEvents();
  w.convertToBot(`p${seat}`);
  const claims: (RoleId | null)[] = [];
  let events = 0;
  for (let i = 0; i < seconds * 30; i++) {
    w.step();
    for (const ev of w.drainEvents()) if (ev.t === 'claim' && ev.who === me.id) events++;
    if (i % 30 === 0) claims.push(me.hero!.claim);
  }
  return { claims, events };
}

describe('bot takeover of a dropped player', () => {
  it('a rebel who claimed 反贼 keeps claim === "rebel" for at least 30 s after the takeover', () => {
    const r = claimTimeline(2, 'rebel', 32);
    expect(r.claims.length).toBeGreaterThanOrEqual(30);
    expect(r.claims.every((c) => c === 'rebel')).toBe(true);
    expect(r.events).toBe(0);
  });

  it('a traitor who claimed 忠臣 and a player who never claimed stay as they were for 30 s', () => {
    const t = claimTimeline(4, 'loyalist', 31);
    expect(t.claims.every((c) => c === 'loyalist')).toBe(true);
    expect(t.events).toBe(0);
    const n = claimTimeline(3, null, 31, 100);
    expect(n.claims.every((c) => c === null)).toBe(true);
    expect(n.events).toBe(0);
  });
});
