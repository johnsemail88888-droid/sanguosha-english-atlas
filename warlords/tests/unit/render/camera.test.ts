import { describe, expect, it } from 'vitest';
import type { MapData } from '../../../src/core/map';
import { dirFromYawPitch } from '../../../src/core/math';
import { cameraRig } from '../../../src/sim/aim';
import { CAM_BACK, CameraShake, resolveCameraCollision, tpsCameraPose } from '../../../src/render/camera/tpsCamera';
import { PickWorld } from '../../../src/render/camera/pick';

const emptyMap = (colliders: MapData['colliders'] = []): MapData => ({
  seed: 1,
  nameZh: '',
  nameEn: '',
  size: 100,
  res: 10,
  heights: new Float32Array(121),
  waterLevel: -10,
  props: [],
  colliders,
  lordSpawn: { x: 0, y: 0, z: 0 },
  spawns: [],
  lootSpots: [],
  crateSpots: [],
  camps: [],
  regions: [],
});

describe('TPS camera', () => {
  it('matches the simulation aim reconstruction exactly', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [1.2, 0.4],
      [-2.5, -0.9],
      [3.1, 1.4],
    ]) {
      const pos = { x: 3, y: 1.5, z: -7 };
      const a = tpsCameraPose(pos, yaw, pitch);
      const b = cameraRig(pos, yaw, pitch);
      expect(a.origin.x).toBeCloseTo(b.origin.x, 9);
      expect(a.origin.y).toBeCloseTo(b.origin.y, 9);
      expect(a.origin.z).toBeCloseTo(b.origin.z, 9);
      const d = dirFromYawPitch(yaw, pitch);
      expect(a.dir.x).toBeCloseTo(d.x, 9);
      expect(a.dir.y).toBeCloseTo(d.y, 9);
      expect(a.dir.z).toBeCloseTo(d.z, 9);
    }
  });

  it('sits right of the hero, behind and above (yaw 0 looks -Z)', () => {
    const p = tpsCameraPose({ x: 0, y: 0, z: 0 }, 0, 0);
    expect(p.origin.x).toBeCloseTo(0.55, 6);
    expect(p.origin.z).toBeCloseTo(2.8, 6);
    expect(p.origin.y).toBeCloseTo(1.65, 6);
    expect(p.nearClip).toBeCloseTo(2.8, 6);
  });

  it('pulls in along the aim ray when a wall is behind the hero', () => {
    const wall = { kind: 'box' as const, cx: 0, cy: 2, cz: 1.5, hx: 5, hy: 3, hz: 0.25, rot: 0 };
    const w = new PickWorld(emptyMap([wall]));
    const res = resolveCameraCollision(w, { x: 0, y: 0, z: 0 }, 0, 0);
    expect(res.back).toBeLessThan(CAM_BACK);
    expect(res.pos.z).toBeLessThan(1.25);
    // same crosshair ray: camera stays on the line through the shoulder along −Z
    expect(res.pos.x).toBeCloseTo(0.55, 5);
    const free = resolveCameraCollision(new PickWorld(emptyMap()), { x: 0, y: 0, z: 0 }, 0, 0);
    expect(free.back).toBe(CAM_BACK);
  });

  it('shake decays to zero and recoil kick recovers', () => {
    const s = new CameraShake();
    s.add(1);
    s.kick(0.05, 0);
    s.update(0.016);
    expect(Math.abs(s.sample().pitch) + Math.abs(s.sample().yaw)).toBeGreaterThan(0);
    for (let i = 0; i < 200; i++) s.update(0.016);
    const o = s.sample();
    expect(Math.abs(o.pitch)).toBeLessThan(1e-4);
    expect(Math.abs(o.roll)).toBeLessThan(1e-4);
  });
});
