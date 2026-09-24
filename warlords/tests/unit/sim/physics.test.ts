import { describe, expect, it } from 'vitest';
import type { InputFrame } from '../../../src/core/types';
import { BTN_JUMP, BTN_SPRINT, emptyInput } from '../../../src/core/types';
import type { MoveMods, MoveState, StaticHit } from '../../../src/sim/physics';
import {
  CHAR_RADIUS,
  SWIM_DEPTH,
  WALK_SPEED,
  buildCollisionWorld,
  forcedMove,
  lineOfSight,
  predictMove,
  raycastStatic,
  rayTerrain,
} from '../../../src/sim/physics';
import { STAIRS, WATER_LEVEL, makeTestMap } from './helpers';

const DT = 1 / 30;
const mods = (p: Partial<MoveMods> = {}): MoveMods => ({
  speedMul: 1,
  canSprint: true,
  canJump: true,
  rooted: false,
  ads: false,
  downed: false,
  ...p,
});
const state = (x: number, y: number, z: number): MoveState => ({ pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, onGround: true });
const input = (p: Partial<InputFrame>): InputFrame => ({ ...emptyInput(), ...p });

/** yaw that faces the given world direction */
const yawFor = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

function run(cw: ReturnType<typeof buildCollisionWorld>, st: MoveState, inp: InputFrame, seconds: number, m = mods()): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) predictMove(cw, st, inp, DT, m);
}

describe('character movement', () => {
  const cw = buildCollisionWorld(makeTestMap({ hill: true }));

  it('walks at the base speed on flat ground', () => {
    const st = state(0, 0, 30);
    run(cw, st, input({ moveZ: 1, yaw: 0 }), 1);
    // accelerates within ~0.1 s, then 5 m/s
    expect(30 - st.pos.z).toBeGreaterThan(WALK_SPEED * 0.9);
    expect(30 - st.pos.z).toBeLessThan(WALK_SPEED * 1.01);
    expect(st.onGround).toBe(true);
    expect(st.pos.y).toBeCloseTo(0, 5);
  });

  it('sprint is faster, ADS is slower', () => {
    const a = state(0, 0, 30);
    run(cw, a, input({ moveZ: 1, yaw: 0, buttons: BTN_SPRINT }), 1);
    const b = state(0, 0, 30);
    run(cw, b, input({ moveZ: 1, yaw: 0 }), 1, mods({ ads: true }));
    expect(30 - a.pos.z).toBeGreaterThan(7);
    expect(a.sprinting).toBe(true);
    expect(30 - b.pos.z).toBeLessThan(3.2);
  });

  it('is stopped by a wall and slides along it', () => {
    // wall occupies x ∈ [9.5, 10.5], z ∈ [-5, 5]
    const st = state(6, 0, 2);
    const yaw = yawFor(1, -0.4);
    run(cw, st, input({ moveZ: 1, yaw }), 2);
    expect(st.pos.x).toBeLessThanOrEqual(9.5 - CHAR_RADIUS + 1e-3);
    expect(st.pos.x).toBeGreaterThan(9.5 - CHAR_RADIUS - 0.05);
    expect(st.pos.z).toBeLessThan(0); // slid along the wall
  });

  it('collides with cylinders and rotated boxes', () => {
    const st = state(-5, 0, -1);
    run(cw, st, input({ moveZ: 1, yaw: yawFor(0, -1) }), 2);
    expect(Math.hypot(st.pos.x + 5, st.pos.z + 5)).toBeGreaterThanOrEqual(0.5 + CHAR_RADIUS - 1e-3);
    // rotated 45° box centred (20,20), half-extents 2 × 0.5
    const r = state(15, 0, 15);
    run(cw, r, input({ moveZ: 1, yaw: yawFor(1, 1) }), 3);
    // local frame of the box: distance to the box surface must be >= radius
    const c = Math.cos(Math.PI / 4);
    const s = Math.sin(Math.PI / 4);
    const rx = r.pos.x - 20;
    const rz = r.pos.z - 20;
    const lx = c * rx - s * rz;
    const lz = s * rx + c * rz;
    const qx = Math.max(-2, Math.min(2, lx));
    const qz = Math.max(-0.5, Math.min(0.5, lz));
    expect(Math.hypot(lx - qx, lz - qz)).toBeGreaterThanOrEqual(CHAR_RADIUS - 1e-3);
  });

  it('climbs stairs made of 0.4 m box steps', () => {
    const st = state(STAIRS.x, 0, STAIRS.z0 + 2);
    run(cw, st, input({ moveZ: 1, yaw: 0 }), 1.4); // ~6.5 m: onto the landing
    const landingTop = STAIRS.stepRise * STAIRS.steps;
    expect(st.pos.z).toBeLessThan(STAIRS.z0 - STAIRS.stepRun * STAIRS.steps);
    expect(st.pos.y).toBeCloseTo(landingTop, 3);
    expect(st.onGround).toBe(true);
  });

  it('cannot walk onto a 1 m platform but can jump onto it, and stands on it', () => {
    // platform x ∈ [-12,-8], z ∈ [8,12], top 1.0
    const st = state(-10, 0, 15);
    run(cw, st, input({ moveZ: 1, yaw: 0 }), 1.5);
    expect(st.pos.z).toBeGreaterThanOrEqual(12 + CHAR_RADIUS - 1e-3);
    expect(st.pos.y).toBeCloseTo(0, 5);
    run(cw, st, input({ moveZ: 1, yaw: 0, buttons: BTN_JUMP }), 0.8);
    run(cw, st, input({ moveZ: 0.2, yaw: 0 }), 0.6);
    expect(st.pos.y).toBeCloseTo(1, 3);
    expect(st.onGround).toBe(true);
    // standing still on top stays on top
    run(cw, st, input({}), 1);
    expect(st.pos.y).toBeCloseTo(1, 3);
    // walking off the far edge falls back to the ground
    run(cw, st, input({ moveZ: 1, yaw: 0 }), 2);
    expect(st.pos.y).toBeCloseTo(0, 3);
  });

  it('jumps about a meter high and lands', () => {
    const st = state(0, 0, 40);
    let peak = 0;
    predictMove(cw, st, input({ buttons: BTN_JUMP }), DT, mods());
    for (let i = 0; i < 60; i++) {
      predictMove(cw, st, input({}), DT, mods());
      peak = Math.max(peak, st.pos.y);
    }
    expect(peak).toBeGreaterThan(0.9);
    expect(peak).toBeLessThan(1.3);
    expect(st.pos.y).toBeCloseTo(0, 5);
    expect(st.onGround).toBe(true);
  });

  it('hits its head on a ceiling', () => {
    // roof slab bottom at 2.5 over (-20,-20)
    const st = state(-20, 0, -20);
    let peak = 0;
    predictMove(cw, st, input({ buttons: BTN_JUMP }), DT, mods());
    for (let i = 0; i < 40; i++) {
      predictMove(cw, st, input({}), DT, mods());
      peak = Math.max(peak, st.pos.y);
    }
    expect(peak).toBeLessThanOrEqual(2.5 - 1.8 + 1e-3);
  });

  it('is slowed in water and cannot sprint there', () => {
    const st = state(37, -2, 0);
    run(cw, st, input({}), 0.2);
    // 1.5 m deep: deeper than SWIM_DEPTH, so the character floats with its head above water
    expect(st.pos.y).toBeCloseTo(WATER_LEVEL - SWIM_DEPTH, 3);
    const z0 = st.pos.z;
    run(cw, st, input({ moveZ: 1, yaw: 0, buttons: BTN_SPRINT }), 1);
    expect(st.inWater).toBe(true);
    expect(st.sprinting).toBe(false);
    expect(z0 - st.pos.z).toBeLessThan(WALK_SPEED * 0.61);
    expect(z0 - st.pos.z).toBeGreaterThan(WALK_SPEED * 0.45);
  });

  it('cannot walk up terrain steeper than 45°', () => {
    const st = state(-25, 0, 0);
    run(cw, st, input({ moveZ: 1, yaw: yawFor(-1, 0) }), 3);
    expect(st.pos.y).toBeLessThan(1);
    expect(st.pos.x).toBeGreaterThan(-31);
  });

  it('stays inside the world bounds', () => {
    const st = state(50, 0, 40);
    run(cw, st, input({ moveZ: 1, yaw: yawFor(1, 0), buttons: BTN_SPRINT }), 4);
    expect(st.pos.x).toBeLessThanOrEqual(60 - 0.5 + 1e-6);
  });

  it('rooted characters do not move, downed ones crawl', () => {
    const a = state(0, 0, 30);
    run(cw, a, input({ moveZ: 1 }), 1, mods({ rooted: true }));
    expect(a.pos.z).toBeCloseTo(30, 5);
    const b = state(0, 0, 30);
    run(cw, b, input({ moveZ: 1, buttons: BTN_SPRINT }), 1, mods({ downed: true }));
    expect(30 - b.pos.z).toBeLessThan(WALK_SPEED * 0.26);
    expect(30 - b.pos.z).toBeGreaterThan(WALK_SPEED * 0.15);
  });

  it('forced movement (dash) slides along walls instead of passing through', () => {
    const st = state(7, 0, 0);
    for (let i = 0; i < 10; i++) forcedMove(cw, st, 30, 0, DT);
    expect(st.pos.x).toBeLessThanOrEqual(9.5 - CHAR_RADIUS + 1e-3);
  });

  it('predictMove is deterministic', () => {
    const frames: InputFrame[] = [];
    for (let i = 0; i < 90; i++) {
      frames.push(input({ seq: i, moveX: Math.sin(i * 0.1), moveZ: Math.cos(i * 0.13), yaw: i * 0.05, buttons: i % 20 === 0 ? BTN_JUMP : BTN_SPRINT }));
    }
    const a = state(3, 0, -3);
    const b = state(3, 0, -3);
    for (const f of frames) predictMove(cw, a, f, DT, mods());
    for (const f of frames) predictMove(cw, b, f, DT, mods());
    expect(a.pos).toEqual(b.pos);
    expect(a.vel).toEqual(b.vel);
    expect(a.onGround).toBe(b.onGround);
  });
});

describe('static raycasts', () => {
  const cw = buildCollisionWorld(makeTestMap({ hill: true }));
  const hit: StaticHit = { t: 0, nx: 0, ny: 0, nz: 0 };

  it('hits flat terrain from above', () => {
    expect(rayTerrain(cw, 0, 10, 40, 0, -1, 0, 100, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(10, 2);
    expect(hit.ny).toBeCloseTo(1, 3);
    // grazing ray along the ground plane at +1 m never hits
    expect(rayTerrain(cw, -20, 1, 40, 1, 0, 0, 30, hit)).toBe(false);
  });

  it('hits sloped terrain (march + refine)', () => {
    const d = { x: -1, y: 0, z: 0 };
    expect(rayTerrain(cw, -20, 5, 0, d.x, d.y, d.z, 100, hit)).toBe(true);
    // slope starts at x=-30 with height (-30-x)*tan60 → y=5 at x≈-32.89
    expect(-20 - hit.t).toBeCloseTo(-30 - 5 / Math.tan((60 * Math.PI) / 180), 1);
  });

  it('hits an axis-aligned box face with the right normal', () => {
    expect(raycastStatic(cw, 0, 1, 0, 1, 0, 0, 100, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(9.5, 4);
    expect(hit.nx).toBeCloseTo(-1, 4);
  });

  it('hits a rotated box (slab test in local space)', () => {
    // box at (20,20) rotated 45°, half-extents x=2, z=0.5. Ray from (20,1,10) toward +z.
    expect(raycastStatic(cw, 20, 1, 10, 0, 0, 1, 50, hit)).toBe(true);
    // the box's thin local-z faces are the diagonal (x+z) planes; along the line x=20 the entry
    // is at z = 20 - 0.5*sqrt(2)
    expect(10 + hit.t).toBeCloseTo(20 - 0.5 * Math.SQRT2, 3);
  });

  it('hits cylinders', () => {
    expect(raycastStatic(cw, -5, 1, 5, 0, 0, -1, 50, hit)).toBe(true);
    expect(5 - hit.t).toBeCloseTo(-4.5, 3);
    expect(hit.nz).toBeCloseTo(1, 3);
  });

  it('line of sight is blocked by walls and terrain', () => {
    expect(lineOfSight(cw, { x: 0, y: 1, z: 0 }, { x: 20, y: 1, z: 0 })).toBe(false);
    expect(lineOfSight(cw, { x: 0, y: 1, z: 20 }, { x: 5, y: 1, z: 40 })).toBe(true);
    expect(lineOfSight(cw, { x: 0, y: 5, z: 0 }, { x: 20, y: 5, z: 0 })).toBe(true); // over the 3 m wall
    expect(lineOfSight(cw, { x: -25, y: 1, z: 0 }, { x: -50, y: 1, z: 0 })).toBe(false); // into the hill
  });
});
