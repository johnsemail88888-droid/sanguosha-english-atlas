// Aim assist (game/aimAssist.ts, weapons spec C9): touch / gamepad only (a mouse gets nothing),
// slowdown inside 1.5 × the target's angular half-width (0.8–5°), a follow of 30 % / 40 % of the
// target's angular velocity capped at 10°/s (none through a scope), never on your own squad, your
// summons or allies you already know — and every other hero alike (no role leak).
import { describe, expect, it } from 'vitest';
import type { ViewEntity } from '../../../src/core/types';
import { VF_DEAD, VF_EXPOSED, VF_STEALTH } from '../../../src/core/types';
import {
  AimAssist,
  CONE_MAX_DEG,
  CONE_MIN_DEG,
  FOLLOW_MAX_DEG,
  SLOW_AIMED,
  SLOW_HIP,
  SLOW_SCOPE,
  assistConeDeg,
  assistExcluded,
  type AssistFrame,
} from '../../../src/game/aimAssist';

const DEG = Math.PI / 180;
const ME = 1;

function ent(id: number, x: number, z: number, o: Partial<ViewEntity> = {}): ViewEntity {
  return { id, kind: 'hero', sub: 'dummy', x, y: 0, z, yaw: 0, pitch: 0, speed: 0, hp: 400, maxHp: 400, shield: 0, flags: 0, ...o };
}

/** A frame looking straight down −z from (0, 1.1, 0) (the chest height of a target on flat ground). */
function frame(entities: ViewEntity[], o: Partial<AssistFrame> = {}): AssistFrame {
  return {
    device: 'touch',
    level: 'standard',
    origin: { x: 0, y: 1.1, z: 0 },
    yaw: 0,
    pitch: 0,
    blend: 0,
    scoped: false,
    active: true,
    dt: 1 / 60,
    viewer: { id: ME, role: 'rebel' },
    entities,
    ...o,
  };
}

describe('aim assist', () => {
  it('does nothing with a mouse (or when off)', () => {
    const a = new AimAssist();
    const t = [ent(2, 0, -10)];
    expect(a.update(frame(t, { device: 'mouse' }))).toMatchObject({ slow: 1, yaw: 0, pitch: 0, targetId: null });
    expect(a.update(frame(t, { level: 'off' }))).toMatchObject({ slow: 1, yaw: 0, pitch: 0, targetId: null });
  });

  it('slows the look on a target: × 0.6 at the hip, × 0.5 aimed, × 0.75 through a scope; half as much on low', () => {
    const t = [ent(2, 0, -10)];
    expect(new AimAssist().update(frame(t)).slow).toBeCloseTo(SLOW_HIP, 9);
    expect(new AimAssist().update(frame(t, { blend: 1 })).slow).toBeCloseTo(SLOW_AIMED, 9);
    expect(new AimAssist().update(frame(t, { blend: 1, scoped: true })).slow).toBeCloseTo(SLOW_SCOPE, 9);
    expect(new AimAssist().update(frame(t, { level: 'low' })).slow).toBeCloseTo(1 - (1 - SLOW_HIP) * 0.5, 9);
    // off the target: nothing
    expect(new AimAssist().update(frame([ent(2, 5, -10)])).slow).toBe(1);
  });

  it('the cone is 1.5 × the angular half-width, clamped to 0.8°…5°', () => {
    expect(assistConeDeg(0.4, 1)).toBe(CONE_MAX_DEG);
    expect(assistConeDeg(0.4, 200)).toBe(CONE_MIN_DEG);
    const at10 = assistConeDeg(0.4, 10);
    expect(at10).toBeCloseTo((Math.atan2(0.4, 10) / DEG) * 1.5, 9);
    // just inside / just outside the cone at 10 m
    const off = (deg: number): ViewEntity => ent(2, Math.tan(deg * DEG) * 10, -10);
    expect(new AimAssist().update(frame([off(at10 * 0.9)])).targetId).toBe(2);
    expect(new AimAssist().update(frame([off(at10 * 1.15)])).targetId).toBe(null);
    // far beyond the hip range (45 m): nothing; aimed it reaches 70 m
    expect(new AimAssist().update(frame([ent(2, 0, -60)])).targetId).toBe(null);
    expect(new AimAssist().update(frame([ent(2, 0, -60)], { blend: 1 })).targetId).toBe(2);
  });

  it('follows a strafing target at 30 % / 40 % of its angular velocity, never faster than 10°/s', () => {
    const dt = 1 / 60;
    // a target 10 m out crossing at 2 m/s: ~11.5°/s of bearing change
    const run = (blend: number, speed: number): number => {
      const a = new AimAssist();
      let x = 0;
      let turn = 0;
      for (let i = 0; i < 20; i++) {
        // the player keeps the crosshair on the target (the follow's share is measured, not applied)
        const r = a.update(frame([ent(2, x, -10)], { blend, dt, yaw: Math.atan2(-x, 10) }));
        turn = r.yaw;
        x += speed * dt;
      }
      return Math.abs(turn) / dt / DEG; // degrees / s
    };
    const hip = run(0, 2);
    const aimed = run(1, 2);
    expect(hip).toBeGreaterThan(0.3 * 11 * 0.9);
    expect(hip).toBeLessThan(0.3 * 11.5 * 1.1);
    expect(aimed / hip).toBeCloseTo(0.4 / 0.3, 1);
    // a fast target (8 m/s at 10 m ≈ 46°/s): capped at 10°/s
    expect(run(1, 8)).toBeLessThanOrEqual(FOLLOW_MAX_DEG + 1e-6);
    expect(run(1, 8)).toBeGreaterThan(FOLLOW_MAX_DEG * 0.95);
  });

  it('no follow through a scope, nor without an active drag / stick', () => {
    const run = (o: Partial<AssistFrame>): number => {
      const a = new AimAssist();
      let x = 0;
      let turn = 0;
      for (let i = 0; i < 10; i++) {
        turn = a.update(frame([ent(2, x, -10)], { blend: 1, ...o })).yaw;
        x += 2 / 60;
      }
      return turn;
    };
    expect(run({ scoped: true })).toBe(0);
    expect(run({ active: false })).toBe(0);
    expect(Math.abs(run({}))).toBeGreaterThan(0);
  });

  it('skips your squad, your summons, known allies, the dead and the unseen — and treats every other hero alike', () => {
    const v = { id: ME, role: 'loyalist' as const, squad: [5], knownAllies: [7] };
    expect(assistExcluded(ent(ME, 0, 0), v)).toBe(true);
    expect(assistExcluded(ent(5, 0, 0, { kind: 'troop' }), v)).toBe(true);
    expect(assistExcluded(ent(6, 0, 0, { kind: 'npc', owner: ME }), v)).toBe(true);
    expect(assistExcluded(ent(7, 0, 0), v)).toBe(true);
    expect(assistExcluded(ent(8, 0, 0, { kind: 'troop', owner: 7 }), v)).toBe(true);
    // the Lord is public: a loyalist's known ally; a revealed rebel is not
    expect(assistExcluded(ent(9, 0, 0, { role: 'lord' }), v)).toBe(true);
    expect(assistExcluded(ent(10, 0, 0, { role: 'rebel' }), v)).toBe(false);
    // a hidden hero is a hidden hero, whatever he secretly is
    expect(assistExcluded(ent(11, 0, 0), v)).toBe(false);
    // a traitor has no known allies by role
    expect(assistExcluded(ent(12, 0, 0, { role: 'traitor' }), { id: ME, role: 'traitor' })).toBe(false);
    const a = new AimAssist();
    expect(a.update(frame([ent(2, 0, -10, { flags: VF_DEAD })])).targetId).toBe(null);
    expect(a.update(frame([ent(2, 0, -10, { flags: VF_STEALTH })])).targetId).toBe(null);
    expect(a.update(frame([ent(2, 0, -10, { flags: VF_STEALTH | VF_EXPOSED })])).targetId).toBe(2);
    expect(new AimAssist().update(frame([ent(2, 0, -10, { owner: ME, kind: 'troop' })])).targetId).toBe(null);
    // a wall in the way: nothing
    expect(new AimAssist().update(frame([ent(2, 0, -10)], { blocked: () => true })).targetId).toBe(null);
  });
});
