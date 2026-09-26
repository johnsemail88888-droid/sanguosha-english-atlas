// Full headless matches on the real generated map with the current content
// data. Must pass with either the stub or the real map generator. The tick-time
// benchmark lives in tests/perf (it runs alone, after the unit suite).
import { describe, expect, it } from 'vitest';
import type { GameEvent, GameResult, MatchSettings, RoleId } from '../../../src/core/types';
import { defaultSettings } from '../../../src/core/types';
import { HEROES, ROLE_BY_ID } from '../../../src/data';
import type { MatchInit } from '../../../src/sim/host';
import { FAILSAFE_TIME } from '../../../src/sim/rules';
import { ZONE_PHASES } from '../../../src/sim/zone';
import type { World } from '../../../src/sim/world';
import { createWorld } from '../../../src/sim/world';

function botInit(roles: RoleId[], seed: number, patch: Partial<MatchSettings> = {}): MatchInit {
  const heroes = HEROES.map((h) => h.id);
  return {
    settings: { ...defaultSettings(), playerCount: roles.length as 5 | 6 | 7 | 8, ...patch },
    seed,
    seats: roles.map((role, i) => ({
      seat: i,
      playerId: `bot-${i}`,
      name: `Bot ${i}`,
      isBot: true,
      role,
      heroId: heroes[(i * 7 + seed) % heroes.length],
    })),
  };
}

/** Start of the last shrink (the circle closing to 0): deaths before it are decided by fighting, not by the fire. */
const FINAL_SHRINK_START = ZONE_PHASES.reduce((t, p, i) => (i < ZONE_PHASES.length - 1 ? t + p.wait + p.shrink : t + p.wait), 0);

function playOut(w: World): { result: GameResult; events: number; gameOver: number; combatDeaths: number } {
  let events = 0;
  let gameOver = 0;
  let combatDeaths = 0;
  const maxTicks = Math.ceil((FAILSAFE_TIME + 5) * 30);
  for (let i = 0; i < maxTicks && !w.result(); i++) {
    w.step();
    const ev: GameEvent[] = w.drainEvents();
    events += ev.length;
    for (const e of ev) {
      if (e.t === 'gameOver') gameOver++;
      if (e.t === 'death' && e.kind === 'hero' && e.killer !== undefined && w.time < FINAL_SHRINK_START) combatDeaths++;
    }
  }
  const r = w.result();
  if (r) console.log(`[match] ${r.winner} after ${r.durationSec}s — ${r.reasonEn} (${events} events, ${combatDeaths} combat deaths)`);
  return { result: w.result()!, events, gameOver, combatDeaths };
}

function validate(w: World, res: GameResult): void {
  expect(res).toBeTruthy();
  const heroes = w.heroList();
  expect(['lord', 'rebel', 'traitor', 'draw']).toContain(res.winner);
  expect(Object.keys(res.roles).length).toBe(heroes.length);
  for (const h of heroes) expect(res.roles[h.id]).toBe(h.hero!.role);
  for (const id of res.winners) {
    const role = res.roles[id];
    const faction = ROLE_BY_ID[role].faction;
    expect(faction === res.winner || faction === 'neutral').toBe(true);
  }
  if (res.winner !== 'draw') {
    expect(res.winners.length).toBeGreaterThan(0);
    expect(res.winners).toContain(res.mvp);
  }
  expect(res.reasonZh.length).toBeGreaterThan(0);
  expect(res.reasonEn.length).toBeGreaterThan(0);
  expect(res.durationSec).toBeGreaterThan(0);
  expect(res.durationSec).toBeLessThanOrEqual(FAILSAFE_TIME + 1);
}

describe('full bot matches', () => {
  it('8-bot standard match on the generated map ends with a valid GameResult', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
    const init = botInit(roles, 11, { playerCount: 8 });
    const w = createWorld(init, { onWarn: () => {} });
    const { result, events, gameOver, combatDeaths } = playOut(w);
    validate(w, result);
    expect(gameOver).toBe(1);
    expect(events).toBeGreaterThan(100);
    // bots fight it out: heroes fall to other heroes before the final circle closes
    // (a rebel win can be decided by the lord's death alone; every other outcome takes ≥ 2)
    const dmg = w.heroList().reduce((s, h) => s + h.hero!.stats.damage, 0);
    expect(dmg).toBeGreaterThan(0);
    expect(combatDeaths).toBeGreaterThanOrEqual(result.winner === 'rebel' ? 1 : 2);
  }, 180_000);

  it('8-bot chaos match (影武者 / 墙头草 / 赏金猎人) ends with a valid GameResult', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'double', 'rebel', 'rebel', 'opportunist', 'bounty', 'traitor'];
    const init = botInit(roles, 23, { playerCount: 8, mode: 'chaos', botDifficulty: 'hard' });
    const w = createWorld(init, { onWarn: () => {} });
    const hunter = w.heroList().find((h) => h.hero!.role === 'bounty')!;
    expect(hunter.hero!.bountyTargetId).toBeDefined();
    const { result, combatDeaths } = playOut(w);
    validate(w, result);
    expect(combatDeaths).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('5-bot easy match ends too', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
    const w = createWorld(botInit(roles, 5, { botDifficulty: 'easy' }), { onWarn: () => {} });
    const { result, combatDeaths } = playOut(w);
    validate(w, result);
    expect(combatDeaths).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
