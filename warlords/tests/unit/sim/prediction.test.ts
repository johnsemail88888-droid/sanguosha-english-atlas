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
import { STEP_HEIGHT, groundAt, isOpenGround, predictMove } from '../../../src/sim/physics';
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
