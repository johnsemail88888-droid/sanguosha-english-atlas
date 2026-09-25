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
