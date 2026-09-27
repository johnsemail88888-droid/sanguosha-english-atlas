// First-person aiming in the sim (BTN_FIRST_PERSON): the crosshair ray and the
// hero's shots start at the eye — the camera the player looks through — so a
// client aim point picked from the first-person camera is accepted as is and
// shots land where the crosshair shows, however close.
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, InputFrame } from '../../../src/core/types';
import { BTN_ADS, BTN_FIRE, BTN_FIRST_PERSON, emptyInput } from '../../../src/core/types';
import { FP_EYE_HEIGHT, FP_EYE_HEIGHT_DOWNED, FP_EYE_HEIGHT_MOUNTED, cameraRig, firstPersonRig, fpEyeHeight } from '../../../src/sim/aim';
import { isActiveInput, neutralInput } from '../../../src/net/validate';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place } from './helpers';

const ROLES5 = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'] as const;

function duel(): { w: World; a: Entity; b: Entity } {
  const w = makeWorld([...ROLES5]);
  const a = hero(w, 2);
  const b = hero(w, 3);
  place(w, a, 0, 30);
  place(w, b, 0, 20);
  place(w, hero(w, 0), -50, 50);
  place(w, hero(w, 1), -50, 45);
  place(w, hero(w, 4), -45, 50);
  w.step();
  return { w, a, b };
}

/** yaw / pitch looking from `from` at `to` (core/math: forward = (−sin yaw, −cos yaw)). */
function lookAt(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): { yaw: number; pitch: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

function shots(evs: GameEvent[]): Extract<GameEvent, { t: 'shot' }>[] {
  return evs.filter((e): e is Extract<GameEvent, { t: 'shot' }> => e.t === 'shot');
}

describe('first-person rig (sim/aim.ts)', () => {
  it('eye heights: standing = World.eyePos (0.9 × 1.8 m), riding up in the saddle, crawling low', () => {
    expect(FP_EYE_HEIGHT).toBeCloseTo(1.8 * 0.9, 6);
    expect(fpEyeHeight(false, false)).toBe(FP_EYE_HEIGHT);
    expect(fpEyeHeight(false, true)).toBe(FP_EYE_HEIGHT_MOUNTED);
    expect(fpEyeHeight(true, true)).toBe(FP_EYE_HEIGHT_DOWNED);
    // the rider's eye sits under the top of the 2.3 m mounted hit box, above the standing head
    expect(FP_EYE_HEIGHT_MOUNTED).toBeGreaterThan(1.9);
    expect(FP_EYE_HEIGHT_MOUNTED).toBeLessThan(2.3);
  });

  it('the camera is the eye: no shoulder offset, the ray along (yaw, pitch), nothing to clip', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [1.1, 0.3],
      [-2.4, -0.8],
    ]) {
      const pos = { x: 3, y: 2, z: -5 };
      const r = firstPersonRig(pos, yaw, pitch, 1.62);
      expect(r.origin).toEqual({ x: 3, y: 3.62, z: -5 });
      expect(r.pivot).toEqual(r.origin);
      expect(r.nearClip).toBe(0);
      // same direction as the third-person rig: only the origin moves
      const t = cameraRig(pos, yaw, pitch);
      expect(r.dir.x).toBeCloseTo(t.dir.x, 12);
      expect(r.dir.y).toBeCloseTo(t.dir.y, 12);
      expect(r.dir.z).toBeCloseTo(t.dir.z, 12);
    }
  });
});

describe('BTN_FIRST_PERSON in the sim', () => {
  it('aim ray and shot origin move from behind the shoulder to the eye', () => {
    const { w, a } = duel();
    const tps = w.aimRay(a);
    expect(Math.hypot(tps.origin.x - a.pos.x, tps.origin.z - a.pos.z)).toBeGreaterThan(2); // behind the shoulder
    w.setInput('p2', { ...emptyInput(1), yaw: 0, pitch: 0, buttons: BTN_FIRST_PERSON });
    w.step();
    expect(w.firstPerson(a)).toBe(true);
    const fp = w.aimRay(a);
    expect(fp.origin.x).toBeCloseTo(a.pos.x, 9);
    expect(fp.origin.y).toBeCloseTo(a.pos.y + FP_EYE_HEIGHT, 9);
    expect(fp.origin.z).toBeCloseTo(a.pos.z, 9);
    expect(w.shotOrigin(a)).toEqual(fp.origin);
    // standing: the same point as the eye the sim always shot from
    expect(w.shotOrigin(a).y).toBeCloseTo(w.eyePos(a).y, 9);
  });

  it('a rider shoots from up in the saddle in first person', () => {
    const { w, a } = duel();
    w.equip(a.id, 'chitu');
    expect(a.hero!.mount).toBeTruthy();
    w.setInput('p2', { ...emptyInput(1), yaw: 0, pitch: 0, buttons: BTN_FIRST_PERSON });
    w.step();
    expect(w.shotOrigin(a).y).toBeCloseTo(a.pos.y + FP_EYE_HEIGHT_MOUNTED, 9);
  });

  it('close range: an aim point picked on the first-person centre ray is accepted and hit exactly', () => {
    const { w, a, b } = duel();
    // the target 1.6 m ahead and 0.5 m to the left: from the third-person shoulder camera the
    // point is far off its ray (it would be rejected and the ray rebuilt); from the eye it is dead centre
    place(w, b, -0.5, 28.4);
    w.step();
    const eye = { x: a.pos.x, y: a.pos.y + FP_EYE_HEIGHT, z: a.pos.z };
    const chest = { x: b.pos.x, y: b.pos.y + 1.2, z: b.pos.z };
    const ang = lookAt(eye, chest);
    // the entry point on the front of the capsule, like the client's pick returns
    const d = Math.hypot(chest.x - eye.x, chest.y - eye.y, chest.z - eye.z);
    const k = (d - 0.38) / d;
    const aimPoint = { x: eye.x + (chest.x - eye.x) * k, y: eye.y + (chest.y - eye.y) * k, z: eye.z + (chest.z - eye.z) * k };
    const frame = (buttons: number, seq: number): InputFrame => ({ ...emptyInput(seq), ...ang, aimPoint, aimTargetId: b.id, viewTick: w.tick, buttons: buttons | BTN_ADS });

    // third person: the same aim point is more than 4° off the shoulder camera's ray → rebuilt, not used
    w.setInput('p2', frame(0, 1));
    w.step();
    const tp = w.crosshairPoint(a, 100);
    expect(Math.hypot(tp.x - aimPoint.x, tp.y - aimPoint.y, tp.z - aimPoint.z)).toBeGreaterThan(0.2);

    // first person: accepted as sent, and the shot leaves the eye straight through it
    w.setInput('p2', frame(BTN_FIRST_PERSON, 2));
    w.step();
    const fp = w.crosshairPoint(a, 100);
    expect(fp.x).toBeCloseTo(aimPoint.x, 6);
    expect(fp.y).toBeCloseTo(aimPoint.y, 6);
    expect(fp.z).toBeCloseTo(aimPoint.z, 6);
    const hp = b.hp;
    w.drainEvents();
    w.setInput('p2', frame(BTN_FIRST_PERSON | BTN_FIRE, 3));
    w.step();
    const s = shots(w.drainEvents()).filter((e) => e.src === a.id);
    expect(s.length).toBe(1);
    expect(s[0].from.y).toBeCloseTo(eye.y, 6);
    expect(s[0].hit).toBe(b.id);
    expect(b.hp).toBeLessThan(hp);
  });

  it('the first-person bit is a view mode: never activity, kept by the hands-off frame', () => {
    const f: InputFrame = { ...emptyInput(3), yaw: 1, pitch: 0.2, buttons: BTN_FIRST_PERSON };
    expect(isActiveInput(f)).toBe(false);
    expect(isActiveInput({ ...f, buttons: BTN_FIRST_PERSON | BTN_FIRE })).toBe(true);
    expect(neutralInput(f)?.buttons).toBe(BTN_FIRST_PERSON);
    expect(neutralInput({ ...f, buttons: BTN_FIRE })?.buttons).toBe(0);
  });
});
