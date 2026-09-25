// Full headless matches on the real generated map with the current content
// data, plus a tick-time benchmark. Must pass with either the stub or the
// real map generator.
import { cpus, loadavg } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { GameEvent, GameResult, MatchSettings, RoleId } from '../../../src/core/types';
import { defaultSettings } from '../../../src/core/types';
import { HEROES, ROLE_BY_ID } from '../../../src/data';
import { generateMap } from '../../../src/sim/map/generate';
import type { MatchInit } from '../../../src/sim/host';
import { findOpenGround } from '../../../src/sim/physics';
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

describe('performance', () => {
  it('tick ≤ 4 ms avg (p95 bounded) in a real brawl: 8 heroes, ~50 charging troops, ~30 NPCs, launchers', () => {
    const roles: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
    const map = generateMap(20260924);
    const w = createWorld(botInit(roles, 99, { playerCount: 8, troopsPerHero: 5, botDifficulty: 'hard' }), { map, onWarn: () => {} });
    const heroes = w.heroList();
    // every role public: identity-aware troops and bots engage immediately
    for (const h of heroes) h.hero!.roleRevealed = true;
    // projectile weapons (grenades, rockets, arrows) for half of the heroes
    const launchers = ['guanshi', 'fangtian', 'liegong', 'xiaoji'];
    heroes.forEach((h, i) => {
      if (i % 2 === 0) w.giveWeapon(h.id, launchers[(i / 2) % launchers.length]);
    });
    // lord side vs rebels on open ground ~30 m apart, traitor in between
    let k = 0;
    const rand = (): number => w.rng.next();
    for (const h of heroes) {
      const side = h.hero!.role === 'rebel' ? 1 : h.hero!.role === 'traitor' ? 0 : -1;
      const spot = findOpenGround(w.cw, side * 15, (k++ % 4) * 6 - 9, 6, rand, { radius: 0.6 }) ?? { x: side * 15, y: 0, z: 0 };
      w.teleport(h.id, spot);
    }
    let troops = w.kindList('troop').length;
    for (let i = 0; troops < 50; i = (i + 1) % heroes.length) troops += w.spawnTroops(heroes[i].id, 'shu_rifleman', 1).length;
    let npcs = w.kindList('npc').length;
    for (let i = 0; npcs < 30; i++, npcs++) {
      const a = (i / 30) * Math.PI * 2;
      const p = findOpenGround(w.cw, Math.cos(a) * 28, Math.sin(a) * 28, 6, rand, { radius: 0.6 }) ?? { x: Math.cos(a) * 28, y: 0, z: Math.sin(a) * 28 };
      w.spawnNpc(i % 3 === 0 ? 'barbarian' : 'yellowTurban', p);
    }
    for (const h of heroes) w.setSquadOrder(h.id, { kind: 'charge' });
    // short warm-up (JIT), then measure while the brawl is at full strength
    for (let i = 0; i < 60; i++) {
      w.step();
      w.drainEvents();
    }
    const start = { troops: w.kindList('troop').length, npcs: w.kindList('npc').length };
    const dmg0 = heroes.reduce((s, h) => s + h.hero!.stats.damage, 0);
    const times: number[] = [];
    let projectiles = 0;
    let hits = 0;
    for (let i = 0; i < 600 && !w.result(); i++) {
      const t0 = performance.now();
      w.step();
      times.push(performance.now() - t0);
      projectiles = Math.max(projectiles, w.kindList('projectile').length);
      for (const ev of w.drainEvents()) if (ev.t === 'hit' && ev.amount > 0) hits++;
      w.snapshotFor('bot-0');
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((s, t) => s + t, 0) / times.length;
    const pct = (q: number): number => times[Math.min(times.length - 1, Math.floor(times.length * q))];
    // wall-clock percentiles also count time the OS gave to other processes: on a
    // shared machine whose load exceeds its cores, scale the tail budget by the overload
    const overload = Math.max(1, loadavg()[0] / Math.max(1, cpus().length));
    const heroDmg = heroes.reduce((s, h) => s + h.hero!.stats.damage, 0) - dmg0;
    const counts = {
      start,
      end: { troops: w.kindList('troop').length, npcs: w.kindList('npc').length },
      projectilesPeak: projectiles,
      hits,
      heroDmg: Math.round(heroDmg),
    };
    console.log(
      `[bench] ${times.length} ticks: avg ${avg.toFixed(3)} ms, p50 ${pct(0.5).toFixed(3)}, p95 ${pct(0.95).toFixed(3)}, p99 ${pct(0.99).toFixed(3)}, ` +
        `max ${times[times.length - 1].toFixed(2)} ms (machine overload ×${overload.toFixed(2)}) ${JSON.stringify(counts)}`,
    );
    // it really is a fight
    expect(hits).toBeGreaterThan(200);
    expect(projectiles).toBeGreaterThan(0);
    expect(counts.end.troops + counts.end.npcs).toBeLessThan(start.troops + start.npcs);
    // budget: 4 ms per tick on average and for 95 % of ticks (tail scaled by machine overload)
    expect(avg).toBeLessThan(4);
    expect(pct(0.95)).toBeLessThan(4 * overload);
  }, 120_000);
});
