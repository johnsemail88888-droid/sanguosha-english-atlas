// Full headless matches on the real generated map with the current content
// data, plus a tick-time benchmark. Must pass with either the stub or the
// real map generator.
import { describe, expect, it } from 'vitest';
import type { GameEvent, GameResult, MatchSettings, RoleId } from '../../../src/core/types';
import { defaultSettings } from '../../../src/core/types';
import { HEROES, ROLE_BY_ID } from '../../../src/data';
import { generateMap } from '../../../src/sim/map/generate';
import type { MatchInit } from '../../../src/sim/host';
import { FAILSAFE_TIME } from '../../../src/sim/rules';
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

function playOut(w: World): { result: GameResult; events: number; gameOver: number } {
  let events = 0;
  let gameOver = 0;
  const maxTicks = Math.ceil((FAILSAFE_TIME + 5) * 30);
  for (let i = 0; i < maxTicks && !w.result(); i++) {
    w.step();
    const ev: GameEvent[] = w.drainEvents();
    events += ev.length;
    for (const e of ev) if (e.t === 'gameOver') gameOver++;
  }
  const r = w.result();
  if (r) console.log(`[match] ${r.winner} after ${r.durationSec}s — ${r.reasonEn} (${events} events)`);
  return { result: w.result()!, events, gameOver };
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
    const { result, events, gameOver } = playOut(w);
    validate(w, result);
    expect(gameOver).toBe(1);
    expect(events).toBeGreaterThan(100);
    // somebody actually fought
    const dmg = w.heroList().reduce((s, h) => s + h.hero!.stats.damage, 0);
    expect(dmg).toBeGreaterThan(0);
  }, 180_000);

  it('8-bot chaos match (影武者 / 墙头草 / 赏金猎人) ends with a valid GameResult', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'double', 'rebel', 'rebel', 'opportunist', 'bounty', 'traitor'];
    const init = botInit(roles, 23, { playerCount: 8, mode: 'chaos', botDifficulty: 'hard' });
    const w = createWorld(init, { onWarn: () => {} });
    const hunter = w.heroList().find((h) => h.hero!.role === 'bounty')!;
    expect(hunter.hero!.bountyTargetId).toBeDefined();
    const { result } = playOut(w);
    validate(w, result);
  }, 180_000);

  it('5-bot easy match ends too', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
    const w = createWorld(botInit(roles, 5, { botDifficulty: 'easy' }), { onWarn: () => {} });
    validate(w, playOut(w).result);
  }, 180_000);
});

describe('performance', () => {
  it('tick ≤ 4 ms with 8 heroes + ~50 troops + ~30 NPCs + projectiles', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
    const map = generateMap(20260924);
    const w = createWorld(botInit(roles, 99, { playerCount: 8, troopsPerHero: 5 }), { map, onWarn: () => {} });
    // top up to ~50 troops and ~30 NPCs, everyone near the center so they fight
    const heroes = w.heroList();
    let troops = w.kindList('troop').length;
    for (let i = 0; troops < 50; i = (i + 1) % heroes.length) {
      troops += w.spawnTroops(heroes[i].id, 'shu_rifleman', 1).length;
    }
    let npcs = w.kindList('npc').length;
    for (let i = 0; npcs < 30; i++, npcs++) {
      const a = (i / 30) * Math.PI * 2;
      w.spawnNpc(i % 3 === 0 ? 'barbarian' : 'yellowTurban', { x: Math.cos(a) * 30, y: 20, z: Math.sin(a) * 30 });
    }
    heroes.forEach((h, i) => {
      const a = (i / heroes.length) * Math.PI * 2;
      w.teleport(h.id, { x: Math.cos(a) * 18, y: 20, z: Math.sin(a) * 18 });
    });
    // short warm-up (JIT), then measure while the brawl is at full strength
    for (let i = 0; i < 60; i++) {
      w.step();
      w.drainEvents();
    }
    const start = { troops: w.kindList('troop').length, npcs: w.kindList('npc').length };
    const times: number[] = [];
    let projectiles = 0;
    for (let i = 0; i < 600; i++) {
      const t0 = performance.now();
      w.step();
      times.push(performance.now() - t0);
      projectiles = Math.max(projectiles, w.kindList('projectile').length);
      w.drainEvents();
      w.snapshotFor('bot-0');
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((s, t) => s + t, 0) / times.length;
    const p95 = times[Math.floor(times.length * 0.95)];
    const counts = { start, end: { troops: w.kindList('troop').length, npcs: w.kindList('npc').length }, projectilesPeak: projectiles };
    console.log(`[bench] tick avg ${avg.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${times[times.length - 1].toFixed(2)} ms ${JSON.stringify(counts)}`);
    expect(avg).toBeLessThan(4);
  }, 120_000);
});
