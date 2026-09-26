// Host ⇄ client movement parity (the NET client predicts the local hero with
// predictMove + the snapshot's moveMods + its own BTN_ADS), grounded ability
// aim points, and airdrops that always land within reach on the real map.
import { describe, expect, it } from 'vitest';
import { terrainHeight } from '../../../src/core/map';
import type { InputFrame, RoleId } from '../../../src/core/types';
import { BTN_ADS, BTN_SPRINT, SIM_DT, defaultSettings, emptyInput } from '../../../src/core/types';
import { HEROES } from '../../../src/data';
import { generateMap } from '../../../src/sim/map/generate';
import { NAV_MAIN, buildNavGrid, locateNode } from '../../../src/sim/map/nav';
import type { MoveMods, MoveState } from '../../../src/sim/physics';
import { STEP_HEIGHT, WALK_SPEED, brakeForcedEnd, forcedMove, groundAt, isOpenGround, predictMove } from '../../../src/sim/physics';
import type { World } from '../../../src/sim/world';
import { createWorld } from '../../../src/sim/world';
import { hero, makeWorld, place } from './helpers';

const ROLES5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

/** What net/clientView does: the host's last moveMods + the frame's own ADS button. */
function clientMods(w: World, player: string, frame: InputFrame): MoveMods {
  const you = w.snapshotFor(player).you!;
  const ads = (frame.buttons & BTN_ADS) !== 0;
  return { ...you.moveMods!, ads, downed: you.downed };
}

function parity(w: World, seat: number, frames: InputFrame[]): number {
  const e = hero(w, seat);
  const player = `p${seat}`;
  w.setInput(player, { ...emptyInput(1), yaw: frames[0].yaw });
  w.step();
  const client: MoveState = { pos: { ...e.pos }, vel: { ...e.vel }, onGround: e.onGround };
  let worst = 0;
  let seq = 2;
  for (const f of frames) {
    const frame = { ...f, seq: seq++ };
    const mods = clientMods(w, player, frame); // mods known before this tick, as on the client
    w.setInput(player, frame);
    w.step();
    predictMove(w.cw, client, frame, SIM_DT, mods);
    worst = Math.max(worst, Math.hypot(client.pos.x - e.pos.x, client.pos.y - e.pos.y, client.pos.z - e.pos.z));
  }
  return worst;
}

function sprintThenAim(yaw: number): InputFrame[] {
  const frames: InputFrame[] = [];
  const f = (buttons: number): InputFrame => ({ ...emptyInput(), moveZ: 1, yaw, buttons });
  for (let i = 0; i < 20; i++) frames.push(f(BTN_SPRINT)); // sprint
  for (let i = 0; i < 30; i++) frames.push(f(BTN_SPRINT | BTN_ADS)); // aim while still holding sprint
  for (let i = 0; i < 10; i++) frames.push(f(BTN_ADS)); // aim only
  for (let i = 0; i < 20; i++) frames.push(f(BTN_SPRINT)); // sprint again
  for (let i = 0; i < 10; i++) frames.push(f(BTN_ADS | BTN_SPRINT));
  return frames;
}

describe('client prediction parity', () => {
  it('sprint held before ADS: host and client move identically', () => {
    const w = makeWorld(ROLES5);
    const e = hero(w, 2);
    place(w, e, 0, 50, 0);
    // yaw 0 = facing -z: open ground from z=50 toward z=20
    const worst = parity(w, 2, sprintThenAim(0));
    expect(worst).toBeLessThan(1e-9);
    // ADS cancels sprint: while aiming the hero is not sprinting and walks at ADS speed
    expect(e.hero!.sprinting).toBe(false);
    expect(e.hero!.ads).toBe(true);
  });

  it('with sprintAds (神速) the host publishes it and the client still matches', () => {
    const w = makeWorld(ROLES5);
    const e = hero(w, 2);
    w.heroRt(e.id)!.abilities.push({
      def: { id: 't_shensu', slot: 'passive', nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {} },
      impl: { id: 't_shensu', modifiers: () => ({ sprintAds: true }) },
    });
    place(w, e, 0, 50, 0);
    const worst = parity(w, 2, sprintThenAim(0));
    expect(worst).toBeLessThan(1e-9);
    expect(w.snapshotFor('p2').you!.moveMods!.sprintAds).toBe(true);
    // sprinting and aiming at once
    expect(e.hero!.sprinting).toBe(true);
    expect(e.hero!.ads).toBe(true);
  });
});

/**
 * What net/clientView does with the snapshot of tick T: start from the host state and
 * replay `frames` (ticks T+1…): forced ticks while `remaining` > 0, then the end brake
 * once, then predictMove. Returns the worst deviation from the host.
 */
function forcedParity(w: World, seat: number, frames: InputFrame[]): { worst: number; brakes: number } {
  const e = hero(w, seat);
  const player = `p${seat}`;
  const you = w.snapshotFor(player).you!;
  const st: MoveState = { pos: { ...e.pos }, vel: { ...you.vel! }, onGround: you.onGround! };
  const f = you.forced ? { vx: you.forced.vel.x, vz: you.forced.vel.z, left: you.forced.remaining, braked: false } : null;
  let worst = 0;
  let brakes = 0;
  let seq = 100 + w.tick;
  for (const fr of frames) {
    const frame = { ...fr, seq: seq++ };
    const mods = clientMods(w, player, frame);
    w.setInput(player, frame);
    w.step();
    if (f && f.left > 1e-6) {
      forcedMove(w.cw, st, f.vx, f.vz, SIM_DT);
      f.left -= SIM_DT;
    } else {
      if (f && !f.braked) {
        f.braked = true;
        brakes++;
        brakeForcedEnd(st.vel, WALK_SPEED);
      }
      predictMove(w.cw, st, frame, SIM_DT, mods);
    }
    worst = Math.max(worst, Math.hypot(st.pos.x - e.pos.x, st.pos.y - e.pos.y, st.pos.z - e.pos.z));
  }
  return { worst, brakes };
}

describe('forced movement: exact distances and prediction parity (SHU-1)', () => {
  const walk = (n: number, yaw = 0): InputFrame[] => Array.from({ length: n }, () => ({ ...emptyInput(), moveZ: 1, yaw }));

  it('a dodge roll covers exactly its distance and stops at walking speed (no slide)', () => {
    const w = makeWorld(ROLES5);
    const e = hero(w, 2);
    place(w, e, 0, 50, 0);
    w.step();
    const z0 = e.pos.z;
    w.setInput('p2', { ...emptyInput(5), moveZ: 1, yaw: 0, actions: [{ a: 'dodge' }] });
    w.step();
    // 0.35 s = 11 movement ticks (this one included); the brake happens on the 12th
    for (let i = 0; i < 11; i++) {
      w.setInput('p2', { ...emptyInput(6 + i), yaw: 0 });
      w.step();
    }
    expect(e.forced).toBeUndefined();
    for (let i = 0; i < 10; i++) {
      w.setInput('p2', { ...emptyInput(20 + i), yaw: 0 });
      w.step();
    }
    // 4.5 m roll; afterwards at most walking speed, braking to a stop at GROUND_ACCEL
    const rolled = z0 - e.pos.z;
    expect(rolled).toBeGreaterThan(4.5 - 1e-6);
    expect(rolled).toBeLessThan(4.5 + (WALK_SPEED * WALK_SPEED) / (2 * 60) + 0.2);
    expect(Math.hypot(e.vel.x, e.vel.z)).toBeLessThan(1e-6);
  });

  it('a knockback of force F travels F m, then brakes', () => {
    const w = makeWorld(ROLES5);
    const e = hero(w, 2);
    place(w, e, 0, 50, 0);
    w.step();
    const z0 = e.pos.z;
    w.knockback(e.id, { x: 0, y: 0, z: 1 }, 6);
    for (let i = 0; i < 30; i++) w.step();
    expect(e.pos.z - z0).toBeGreaterThan(6 - 1e-6);
    expect(e.pos.z - z0).toBeLessThan(6 + (WALK_SPEED * WALK_SPEED) / 120 + 0.05);
  });

  it('the client replays reported forced movement and the end brake bit-for-bit', () => {
    for (let start = 0; start < 12; start++) {
      const w = makeWorld(ROLES5);
      const e = hero(w, 2);
      place(w, e, 0, 50, 0);
      w.setInput('p2', { ...emptyInput(1), moveZ: 1, yaw: 0 });
      w.step();
      // dodge while walking, then replay from a snapshot taken `start` ticks later
      w.setInput('p2', { ...emptyInput(2), moveZ: 1, yaw: 0, actions: [{ a: 'dodge' }] });
      w.step();
      for (let i = 0; i < start; i++) {
        w.setInput('p2', { ...emptyInput(3 + i), moveZ: 1, yaw: 0 });
        w.step();
      }
      const r = forcedParity(w, 2, walk(20));
      expect(r.worst, `snapshot ${start} ticks into the roll`).toBeLessThan(1e-9);
      // the roll lasts 11 ticks: every snapshot during it (and the one right after) still owes the brake
      if (start <= 10) expect(r.brakes).toBe(1);
    }
  });

  it('knockbacks landing after the hero moved this tick are replayed exactly too', () => {
    const w = makeWorld(ROLES5);
    const e = hero(w, 2);
    place(w, e, 0, 50, 0);
    w.setInput('p2', { ...emptyInput(1), moveZ: 1, yaw: 0 });
    w.step();
    w.knockback(e.id, { x: 1, y: 0, z: 0.3 }, 7); // between ticks = after this tick's movement
    const r = forcedParity(w, 2, walk(25));
    expect(r.worst).toBeLessThan(1e-9);
    expect(r.brakes).toBe(1);
  });
});

describe('ability aim points', () => {
  it('a crosshair ray that hits nothing is dropped onto the ground', () => {
    const w = makeWorld(ROLES5);
    const e = hero(w, 2);
    place(w, e, 0, 50, 0);
    w.setInput('p2', { ...emptyInput(1), yaw: 0, pitch: 0.9 });
    w.step();
    const p = w.aimPoint(e, 25);
    expect(p.y).toBeCloseTo(w.groundHeight(p.x, p.z), 6);
    expect(Math.hypot(p.x - e.pos.x, p.z - e.pos.z)).toBeLessThanOrEqual(25 + 1e-6);
  });

  it('a crosshair on a wall keeps the impact point', () => {
    const w = makeWorld(ROLES5);
    const e = hero(w, 2);
    place(w, e, 4, 0, -Math.PI / 2); // facing +x toward the wall at x = 10
    w.setInput('p2', { ...emptyInput(1), yaw: -Math.PI / 2, pitch: 0 });
    w.step();
    const p = w.aimPoint(e, 25);
    expect(p.x).toBeCloseTo(9.5, 1);
    expect(p.y).toBeGreaterThan(1);
  });
});

describe('airdrops', () => {
  const heroes = HEROES.map((h) => h.id);
  // idle human seats: nobody moves or fights, so the match is still running at 2:00
  const init = (seed: number) => ({
    settings: { ...defaultSettings(), playerCount: 5 as const },
    seed,
    seats: ROLES5.map((role, i) => ({ seat: i, playerId: `p${i}`, name: `P${i}`, isBot: false, role, heroId: heroes[i % heroes.length] })),
  });

  it('always land on open, dry ground within reach on the generated map', () => {
    const map = generateMap(7);
    const w = createWorld(init(3), { map, ambient: false, squads: false, zone: false, airdrops: false, onWarn: () => {} });
    const nav = buildNavGrid(map);
    const radii = [160, 100, 55, 25];
    let bad = 0;
    for (let i = 0; i < 400; i++) {
      const a = w.rng.next() * Math.PI * 2;
      const d = w.rng.next() * 120;
      const r = radii[i % radii.length];
      const spot = w.airdropSpot({ x: Math.cos(a) * d, y: 0, z: Math.sin(a) * d }, r);
      const t = terrainHeight(map, spot.x, spot.z);
      const landing = groundAt(w.cw, spot.x, spot.z, 80);
      const node = locateNode(nav, spot, 1.2);
      const reachable = node >= 0 && (nav.flags[node] & NAV_MAIN) !== 0;
      if (!(landing - t < STEP_HEIGHT && t > map.waterLevel && isOpenGround(w.cw, spot.x, spot.z, 1.0) && reachable)) bad++;
    }
    expect(bad).toBe(0);
  });

  it('a scheduled airdrop falls for 12 s and lands on the ground', () => {
    const map = generateMap(11);
    const w = createWorld(init(5), { map, ambient: false, squads: false, nav: false, onWarn: () => {} });
    // keep everyone alive in the (not yet shrinking much) zone
    for (const h of w.heroList()) w.teleport(h.id, { x: 0, y: 0, z: 0 });
    let landedAt = -1;
    let announcedAt = -1;
    for (let i = 0; i < 30 * 140 && landedAt < 0; i++) {
      w.step();
      for (const ev of w.drainEvents()) {
        if (ev.t === 'airdrop') announcedAt = w.time;
        if (ev.t === 'sfx' && ev.name === 'airdropLand') landedAt = w.time;
      }
    }
    expect(w.result()).toBeNull();
    const drops = w.kindList('airdrop');
    expect(drops.length).toBe(1);
    expect(announcedAt).toBeCloseTo(120, 0);
    expect(landedAt - announcedAt).toBeCloseTo(12, 0);
    const d = drops[0];
    expect(d.onGround).toBe(true);
    expect(d.pos.y - terrainHeight(map, d.pos.x, d.pos.z)).toBeLessThan(STEP_HEIGHT);
  });
});
