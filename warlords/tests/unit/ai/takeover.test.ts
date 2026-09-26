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

// Online round 3: a bot standing in for a dropped human claimed in his name (host chat
// 「孟获·孙仲谋：我是忠臣！」). A stand-in never makes identity claims, nor identity quick-chat
// (保护主公, 集火此人…) — only the practical 需要桃 / 谢谢. The world drops a stand-in's claim
// actions whatever brain it runs.
describe('a stand-in bot speaks for nobody', () => {
  function standIn(seat: number, seconds: number): { claims: number; chats: string[]; claim: RoleId | null } {
    const w = makeWorld(STD5, { humans: [seat], squads: false });
    STD5.forEach((_, i) => place(w, hero(w, i), i * 10 - 20, 30 + (i % 2) * 6));
    const me = hero(w, seat);
    stepN(w, 30 * 30);
    w.convertToBot(`p${seat}`);
    let claims = 0;
    const chats: string[] = [];
    for (let i = 0; i < seconds * 30; i++) {
      w.step();
      for (const ev of w.drainEvents()) {
        if (ev.t === 'claim' && ev.who === me.id) claims++;
        if (ev.t === 'quickchat' && ev.who === me.id) chats.push(ev.id);
      }
    }
    return { claims, chats, claim: me.hero!.claim };
  }

  it('no claim for the whole match stretch a bot would normally claim in (loyalist, traitor, rebel seats; 4 min)', () => {
    for (const seat of [1, 2, 4]) {
      const r = standIn(seat, 240);
      expect(r.claims, `seat ${seat}`).toBe(0);
      expect(r.claim, `seat ${seat}`).toBeNull();
      expect(r.chats.filter((c) => c !== 'needPeach' && c !== 'thanks'), `seat ${seat}`).toEqual([]);
    }
  }, 120_000);

  it('the world drops a claim action from a stand-in slot (any brain)', () => {
    const w = makeWorld(STD5, {
      humans: [2],
      squads: false,
      botFactory: () => ({ think: (_sim, self) => ({ ...emptyInput(1), yaw: self.yaw, actions: [{ a: 'claim', role: 'loyalist' }] }) }),
    });
    const me = hero(w, 2);
    const bot = hero(w, 3);
    w.convertToBot('p2');
    stepN(w, 5);
    expect(me.hero!.claim).toBeNull();
    // a born bot still claims as it likes
    expect(bot.hero!.claim).toBe('loyalist');
  });
});
