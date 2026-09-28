// Aim aids (render/aimAids.ts): where a lobbed round / arrow lands (the impact diamond), the
// third-person blocked shot, who a fully aimed 方天画戟 would lock, the draw's arrow speed.
import { describe, expect, it } from 'vitest';
import type { ViewEntity } from '../../../src/core/types';
import { VF_DEAD, VF_STEALTH } from '../../../src/core/types';
import { WEAPON_BY_ID } from '../../../src/data';
import { BLOCK_MARGIN, arrowSpeedMul, blockedAt, lockCandidates, predictImpact, type CastFn } from '../../../src/render/aimAids';

/** Flat ground at y = 0 (and nothing else). */
const ground: CastFn = (o, d, m) => {
  if (d.y >= 0) return null;
  const t = -o.y / d.y;
  if (t < 0 || t > m) return null;
  return { point: { x: o.x + d.x * t, y: 0, z: o.z + d.z * t }, dist: t };
};

describe('predictImpact', () => {
  it('a level grenade shot lands where the flat-ground ballistics say', () => {
    // v 60 m/s, g 9.8, fired level from 1.6 m: t = √(2·1.6 / 9.8) ≈ 0.571 s → ~34 m
    const imp = predictImpact({ origin: { x: 0, y: 1.6, z: 0 }, dir: { x: 0, y: 0, z: -1 }, speed: 60, gravity: 9.8, lifetime: 3 }, ground, 1 / 120);
    expect(imp?.hit).toBe(true);
    expect(imp!.point.y).toBe(0);
    expect(-imp!.point.z).toBeCloseTo(60 * Math.sqrt((2 * 1.6) / 9.8), 0);
    expect(imp!.time).toBeCloseTo(Math.sqrt((2 * 1.6) / 9.8), 1);
  });

  it('an airburst (lifetime runs out first) reports the burst point, not a hit', () => {
    const imp = predictImpact({ origin: { x: 0, y: 10, z: 0 }, dir: { x: 0, y: 0, z: -1 }, speed: 120, gravity: 5, lifetime: 0.5 }, ground);
    expect(imp?.hit).toBe(false);
    expect(-imp!.point.z).toBeCloseTo(60, 0);
  });
});

describe('blockedAt', () => {
  const wallAt = (d: number) => () => d;
  it('marks a wall well before the aim point; nothing when the wall is the aim point', () => {
    const eye = { x: 0, y: 1.6, z: 0 };
    const aim = { x: 0, y: 1.6, z: -20 };
    const b = blockedAt(eye, aim, wallAt(5));
    expect(b).not.toBeNull();
    expect(b!.z).toBeCloseTo(-5, 9);
    expect(blockedAt(eye, aim, wallAt(20 - BLOCK_MARGIN / 2))).toBeNull();
    expect(blockedAt(eye, aim, () => Infinity)).toBeNull();
  });
});

describe('lockCandidates (方天画戟: angular lock)', () => {
  const ent = (id: number, x: number, z: number, o: Partial<ViewEntity> = {}): ViewEntity => ({ id, kind: 'hero', sub: 'd', x, y: 0, z, yaw: 0, pitch: 0, speed: 0, hp: 400, maxHp: 400, shield: 0, flags: 0, ...o });
  // (the lock cone is the weapon's lockDeg: the side dummies 2.5 m apart at 15 m are 9.5° off the middle one)
  const q = { origin: { x: 0, y: 1.1, z: 0 }, dir: { x: 0, y: 0, z: -1 }, coneDeg: 10, range: 40, max: 3, selfId: 1 };

  it('picks 3 heroes 2.5 m apart at 15 m, nearest angle first', () => {
    const got = lockCandidates(q, [ent(2, 2.5, -15), ent(3, 0, -15), ent(4, -2.5, -15)]);
    expect(got).toHaveLength(3);
    expect(got[0]!.id).toBe(3);
    expect(got.map((c) => c.id).sort()).toEqual([2, 3, 4]);
    expect(got[1]!.off).toBeGreaterThan(got[0]!.off);
  });

  it('nothing beyond 40 m or outside the cone; never yourself, your squad, the dead or the unseen; at most 3', () => {
    expect(lockCandidates(q, [ent(2, 0, -45)])).toEqual([]);
    expect(lockCandidates(q, [ent(2, 3, -15)])).toHaveLength(0); // 11.3°
    expect(lockCandidates(q, [ent(1, 0, -15), ent(5, 0.5, -15, { kind: 'troop', owner: 1 })])).toEqual([]);
    expect(lockCandidates(q, [ent(2, 0, -15, { flags: VF_DEAD }), ent(3, 0, -16, { flags: VF_STEALTH })])).toEqual([]);
    const many = [0, 0.5, 1, -0.5, -1].map((x, i) => ent(10 + i, x, -15));
    expect(lockCandidates(q, many)).toHaveLength(3);
    expect(lockCandidates(q, [ent(2, 0, -15)], () => true)).toEqual([]);
  });
});

describe('arrowSpeedMul (the draw is the arrow\'s speed too)', () => {
  it('0.55 undrawn → 1 at full draw for bows; 1 for everything else', () => {
    const bow = WEAPON_BY_ID.liegong!;
    expect(arrowSpeedMul(bow, 0)).toBeCloseTo(0.55, 9);
    expect(arrowSpeedMul(bow, 1)).toBe(1);
    expect(arrowSpeedMul(WEAPON_BY_ID.guanshi!, 0)).toBe(1);
  });
});
