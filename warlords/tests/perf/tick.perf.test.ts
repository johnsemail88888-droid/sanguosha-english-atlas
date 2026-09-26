// Tick-time benchmark: a real brawl on the generated map. Runs on its own after
// the unit suite (`vitest.perf.config.ts`, no file parallelism) so other test
// files don't steal its CPU, and normalises the 4 ms budget to this machine's
// speed with a fixed calibration workload.
import { cpus, loadavg } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { MatchSettings, RoleId } from '../../src/core/types';
import { defaultSettings } from '../../src/core/types';
import { HEROES } from '../../src/data';
import type { MatchInit } from '../../src/sim/host';
import { generateMap } from '../../src/sim/map/generate';
import { findOpenGround } from '../../src/sim/physics';
import { createWorld } from '../../src/sim/world';
import { calibrationMs } from './calibrate';

/** calibrationMs() on the development machine (4 cores, typical load). */
const REFERENCE_CALIB_MS = 90;

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

describe('performance', () => {
  it('tick ≤ 4 ms avg (p95 bounded) in a real brawl: 8 heroes, ~50 charging troops, ~30 NPCs, launchers', () => {
    const calibMs = calibrationMs();
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
    if (process.env.PERF_PROFILE) w.profile = {};
    const times: number[] = [];
    // process CPU time per tick: unlike wall-clock it doesn't count time the OS
    // gave to other processes, so it stays meaningful on a busy/shared machine
    const cpuTimes: number[] = [];
    let projectiles = 0;
    let hits = 0;
    for (let i = 0; i < 600 && !w.result(); i++) {
      const c0 = process.cpuUsage();
      const t0 = performance.now();
      w.step();
      times.push(performance.now() - t0);
      const c = process.cpuUsage(c0);
      cpuTimes.push((c.user + c.system) / 1000);
      projectiles = Math.max(projectiles, w.kindList('projectile').length);
      for (const ev of w.drainEvents()) if (ev.t === 'hit' && ev.amount > 0) hits++;
      w.snapshotFor('bot-0');
    }
    if (w.profile) {
      const rows = Object.entries(w.profile).sort((a, b) => b[1] - a[1]);
      console.log('[bench] phases (ms total over the run): ' + rows.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', '));
    }
    times.sort((a, b) => a - b);
    cpuTimes.sort((a, b) => a - b);
    const cpuAvg = cpuTimes.reduce((s, t) => s + t, 0) / cpuTimes.length;
    const cpuPct = (q: number): number => cpuTimes[Math.min(cpuTimes.length - 1, Math.floor(cpuTimes.length * q))];
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
    // budget: 4 ms per tick on average and for 95 % of ticks on the reference machine,
    // scaled by how much slower this machine runs a fixed CPU workload (never looser than
    // ×2.5, so a genuine 3× regression still fails on any runner); the tail is also scaled
    // by OS overload because wall-clock percentiles include time given to other processes.
    const speed = Math.min(2.5, Math.max(1, calibMs / REFERENCE_CALIB_MS));
    console.log(
      `[bench] cpu per tick: avg ${cpuAvg.toFixed(3)} ms, p95 ${cpuPct(0.95).toFixed(3)} ms; ` +
        `calibration ${calibMs.toFixed(1)} ms (reference ${REFERENCE_CALIB_MS} ms) → budget ×${speed.toFixed(2)}`,
    );
    // CPU time is logged for diagnosis only: it also counts V8's parallel GC threads.
    expect(avg).toBeLessThan(4 * speed);
    expect(pct(0.95)).toBeLessThan(4 * speed * overload);
  }, 120_000);
});
