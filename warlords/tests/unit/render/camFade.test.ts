import { describe, expect, it } from 'vitest';
import { CAM_FADE_BLOCKING, CAM_FADE_MIN, cameraFadeTarget } from '../../../src/render/entities/camFade';

const cam = { x: 0, y: 2, z: 0 };
// followed hero 3.5 m in front of the camera (−z), chest height
const focus = { x: 0, y: 1.3, z: -3.5 };

describe('cameraFadeTarget (near-camera fade)', () => {
  it('keeps distant characters opaque', () => {
    expect(cameraFadeTarget(cam, focus, { x: 6, y: 0, z: -6 }, 1.8)).toBe(1);
    expect(cameraFadeTarget(cam, null, { x: 0, y: 0, z: 10 }, 1.8)).toBe(1);
  });

  it('fades a troop right next to the camera almost completely', () => {
    const f = cameraFadeTarget(cam, focus, { x: 0.7, y: 0, z: 0.3 }, 1.8);
    expect(f).toBeLessThanOrEqual(CAM_FADE_MIN + 0.01);
  });

  it('fades progressively between 0.5 m and 1.8 m from the body surface', () => {
    const a = cameraFadeTarget(cam, null, { x: 1.3, y: 0, z: 0 }, 1.8);
    const b = cameraFadeTarget(cam, null, { x: 1.9, y: 0, z: 0 }, 1.8);
    expect(a).toBeGreaterThan(CAM_FADE_MIN);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1);
    expect(cameraFadeTarget(cam, null, { x: 2.4, y: 0, z: 0 }, 1.8)).toBe(1);
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
