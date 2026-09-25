import { describe, expect, it } from 'vitest';
import {
  CAM_FADE_BLOCKING,
  CAM_FADE_COVER_MIN,
  CAM_FADE_HIDDEN,
  CAM_FADE_NEAR,
  cameraFadeTarget,
} from '../../../src/render/entities/camFade';

const cam = { x: 0, y: 2, z: 0 };
// followed hero 3.5 m in front of the camera (−z), chest height
const focus = { x: 0, y: 1.3, z: -3.5 };
// looking along −z, slightly down
const camDir = (() => {
  const v = { x: 0, y: -0.15, z: -1 };
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
})();
const squad = { squad: true, camDir, fovDeg: 70 };

describe('cameraFadeTarget (near-camera fade)', () => {
  it('keeps distant characters opaque', () => {
    expect(cameraFadeTarget(cam, focus, { x: 6, y: 0, z: -6 }, 1.8)).toBe(1);
    expect(cameraFadeTarget(cam, null, { x: 0, y: 0, z: 10 }, 1.8)).toBe(1);
  });

  it('hides a character whose body is within ~0.9 m of the camera', () => {
    // body surface ≈ 0.3 m away
    expect(cameraFadeTarget(cam, focus, { x: 0.7, y: 0, z: 0.3 }, 1.8)).toBeLessThanOrEqual(CAM_FADE_HIDDEN);
    // body surface 0.85 m away (the "huge ghost head" case)
    expect(cameraFadeTarget(cam, null, { x: 1.3, y: 0, z: 0 }, 1.8)).toBeLessThanOrEqual(CAM_FADE_HIDDEN);
  });

  it('is at most faint at 1 m and fades in steeply up to 2.4 m', () => {
    const at = (surface: number): number => cameraFadeTarget(cam, null, { x: surface + 0.45, y: 0, z: 0 }, 1.8);
    expect(at(1.0)).toBeLessThan(0.1);
    expect(at(1.6)).toBeGreaterThan(at(1.0));
    expect(at(2.0)).toBeGreaterThan(at(1.6));
    expect(at(2.0)).toBeLessThan(1);
    expect(at(CAM_FADE_NEAR + 0.01)).toBe(1);
  });

  it('fades your own soldiers earlier than other characters', () => {
    // 2.8 m beside the camera, at the edge of the frame
    const p = { x: 3.25, y: 0, z: -0.5 };
    expect(cameraFadeTarget(cam, focus, p, 1.8)).toBe(1);
    expect(cameraFadeTarget(cam, focus, p, 1.8, 0.45, squad)).toBeLessThan(0.9);
  });

  it('fades your own soldier that covers a large part of the view', () => {
    // right in front of the camera, 2.3 m deep: projected height ≈ 55 % of the viewport
    const p = { x: 0.9, y: 0, z: -2.3 };
    const f = cameraFadeTarget(cam, null, p, 1.8, 0.45, squad);
    expect(f).toBeLessThan(0.6);
    expect(f).toBeGreaterThanOrEqual(CAM_FADE_COVER_MIN - 1e-9);
    // a soldier far ahead stays opaque
    expect(cameraFadeTarget(cam, null, { x: 1, y: 0, z: -9 }, 1.8, 0.45, squad)).toBe(1);
  });

  it('fades a character standing between the camera and the followed hero', () => {
    const f = cameraFadeTarget(cam, focus, { x: 0.1, y: 0, z: -2.4 }, 1.8);
    expect(f).toBeLessThanOrEqual(CAM_FADE_BLOCKING + 0.01);
    // the same spot without a followed hero (orbit camera) is only distance-faded
    expect(cameraFadeTarget(cam, null, { x: 0.1, y: 0, z: -2.4 }, 1.8)).toBeGreaterThan(CAM_FADE_BLOCKING);
  });

  it('does not fade characters beside or beyond the followed hero', () => {
    expect(cameraFadeTarget(cam, focus, { x: 2.5, y: 0, z: -3.5 }, 1.8)).toBe(1);
    expect(cameraFadeTarget(cam, focus, { x: 0, y: 0, z: -6 }, 1.8)).toBe(1);
    // behind the camera
    expect(cameraFadeTarget(cam, focus, { x: 0, y: 0, z: 3 }, 1.8)).toBe(1);
  });
});

describe('cameraFadeTarget at 0.8 / 1.5 / 2.5 / 4 m from the camera', () => {
  // camera at chest height, looking along −z; a soldier (1.8 m, radius 0.45)
  // standing `d` m beside it (distance camera → body axis)
  const eye = { x: 0, y: 1.5, z: 0 };
  const fwd = { x: 0, y: 0, z: -1 };
  const beside = (d: number) => ({ x: d * Math.SQRT1_2, y: 0, z: -d * Math.SQRT1_2 });
  const troop = (d: number): number => cameraFadeTarget(eye, null, beside(d), 1.8);
  const own = (d: number): number => cameraFadeTarget(eye, null, beside(d), 1.8, 0.45, { squad: true, camDir: fwd, fovDeg: 70 });
  const downed = (d: number): number =>
    cameraFadeTarget({ x: 0, y: 0.75, z: 0 }, null, beside(d), 1.8, 0.45, { camDir: fwd, fovDeg: 70, downedCam: true });

  it('0.8 m: fully hidden, never a giant ghost', () => {
    expect(troop(0.8)).toBe(0);
    expect(own(0.8)).toBe(0);
    expect(downed(0.8)).toBe(0);
  });

  it('~1 m and 1.5 m: still hidden (the body would cover the whole view)', () => {
    expect(troop(1.0)).toBe(0);
    expect(troop(1.5)).toBeLessThanOrEqual(CAM_FADE_HIDDEN);
    expect(own(1.5)).toBeLessThanOrEqual(CAM_FADE_HIDDEN);
    // just past the hide distance it is barely visible, not a half-opaque wall
    expect(troop(1.8)).toBeLessThan(0.15);
  });

  it('2.5 m: soldiers beside the camera are faded (your own squad more)', () => {
    const t = troop(2.5);
    const o = own(2.5);
    expect(t).toBeGreaterThan(0.4);
    expect(t).toBeLessThan(1);
    expect(o).toBeGreaterThan(CAM_FADE_HIDDEN);
    expect(o).toBeLessThan(0.6);
    expect(o).toBeLessThan(t);
  });

  it('4 m: opaque', () => {
    expect(troop(4)).toBe(1);
    // own squad: no distance fade any more (only the screen-coverage fade while one fills ≥ 40 % of the view)
    expect(cameraFadeTarget(eye, null, beside(4), 1.8, 0.45, { squad: true })).toBe(1);
    expect(own(4)).toBeGreaterThan(0.8);
  });

  it('fades monotonically with distance', () => {
    let prev = -1;
    for (let d = 0.5; d <= 5; d += 0.1) {
      const f = troop(d);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it('downed (low camera): troops inside its near volume fade, a little further out than standing', () => {
    expect(downed(1.8)).toBe(0);
    expect(downed(2.5)).toBeGreaterThan(0);
    expect(downed(2.5)).toBeLessThan(troop(2.5));
    expect(downed(3.2)).toBeLessThan(1);
    expect(downed(4.2)).toBe(1);
  });

  it("a rider's mount counts: a horse's head 1 m from the lens hides the rider too", () => {
    // rider axis 2 m away, mount half length ≈ 1.05 m
    expect(cameraFadeTarget(eye, null, beside(2), 2.6, 1.05)).toBe(0);
    expect(cameraFadeTarget(eye, null, beside(2), 2.6, 0.45)).toBeGreaterThan(0);
  });
});
