// Camera-only occluders (G3-2): roof shells (eaves / thatch overhangs have no
// collider) and the space under dock decks shorten the TPS camera boom, so the
// camera never ends up inside a roof or under the planks looking at a black face.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { MapData, MapProp } from '../../../src/core/map';
import { dirFromYawPitch, rightFromYaw } from '../../../src/core/math';
import { CamOccluderSink, CameraOccluders } from '../../../src/render/camera/camOccluders';
import { PickWorld } from '../../../src/render/camera/pick';
import { CAM_BACK, resolveCameraCollision } from '../../../src/render/camera/tpsCamera';
import { buildPropGeometry } from '../../../src/render/world/world';
import { propColliders } from '../../../src/sim/map/props';

const flatMap = (colliders: MapData['colliders'] = [], waterLevel = -10): MapData => ({
  seed: 1,
  nameZh: '',
  nameEn: '',
  size: 100,
  res: 10,
  heights: new Float32Array(121),
  waterLevel,
  props: [],
  colliders,
  lordSpawn: { x: 0, y: 0, z: 0 },
  spawns: [],
  lootSpots: [],
  crateSpots: [],
  camps: [],
  regions: [],
});

describe('CameraOccluders', () => {
  it('shortens the boom when a roof occluder lies between the pivot and the camera', () => {
    // hero at the origin looking −Z: the camera sits ~2.8 m behind (+Z), 0.55 m right
    const free = resolveCameraCollision(new PickWorld(flatMap()), { x: 0, y: 0, z: 0 }, 0, 0);
    expect(free.back).toBe(CAM_BACK);
    // an eave overhang (no collider) 1.5 m behind the hero at head height
    const w = new PickWorld(flatMap());
    const sink = new CamOccluderSink();
    sink.addLocalBox(new THREE.Matrix4(), 0, 1.7, 1.6, 5, 0.3, 0.4);
    w.setCameraOccluders(new CameraOccluders(sink.boxes, 100));
    const res = resolveCameraCollision(w, { x: 0, y: 0, z: 0 }, 0, 0);
    expect(res.back).toBeLessThan(CAM_BACK);
    expect(res.pos.z).toBeLessThan(1.2 - 0.25);
    // the crosshair ray is unchanged: still on the line through the shoulder
    expect(res.pos.x).toBeCloseTo(0.55, 5);
    // the simulation's own static distance does not see it (camera-only)
    expect(w.staticDistance({ x: 0.55, y: 1.65, z: 0 }, { x: 0, y: 0, z: 1 }, 5)).toBe(Infinity);
  });

  it('ignores an occluder that contains the ray origin (hero standing on / in a roof)', () => {
    const sink = new CamOccluderSink();
    sink.addLocalBox(new THREE.Matrix4(), 0, 1.65, 0, 3, 1, 3);
    const occ = new CameraOccluders(sink.boxes, 100);
    expect(occ.rayEntry({ x: 0, y: 1.65, z: 0 }, { x: 0, y: 0, z: 1 }, 5)).toBe(Infinity);
    expect(occ.rayEntry({ x: 0, y: 1.65, z: -6 }, { x: 0, y: 0, z: 1 }, 5)).toBeCloseTo(3, 5);
  });

  it('keeps boxes registered in a rotated prop frame oriented', () => {
    const sink = new CamOccluderSink();
    const m = new THREE.Matrix4().compose(new THREE.Vector3(10, 2, -4), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7), new THREE.Vector3(1, 1, 1));
    sink.addLocalBox(m, 2, 0, 0, 1, 1, 0.2);
    const b = sink.boxes[0];
    expect(b.rot).toBeCloseTo(0.7, 6);
    // local (2, 0, 0) → world
    expect(b.cx).toBeCloseTo(10 + 2 * Math.cos(0.7), 6);
    expect(b.cz).toBeCloseTo(-4 - 2 * Math.sin(0.7), 6);
    const occ = new CameraOccluders(sink.boxes, 100);
    expect(occ.contains({ x: b.cx, y: 2, z: b.cz })).toBe(true);
    // 0.5 m along the box's short local Z axis is outside (hz 0.2)
    expect(occ.contains({ x: b.cx + 0.5 * Math.sin(0.7), y: 2, z: b.cz + 0.5 * Math.cos(0.7) })).toBe(false);
  });
});

// the thatch house of the 长坂坡 village repro (-93, 4): the camera rose into its eave
const house: MapProp = { type: 'house', variant: 3, x: 0, y: 0, z: 0, sx: 6.33, sy: 4.04, sz: 4.94, rot: -5.621 };

function houseWorld(): { w: PickWorld; occ: CameraOccluders } {
  const map = flatMap(propColliders(house));
  const sink = new CamOccluderSink();
  const g = buildPropGeometry(house, map, sink);
  g?.opaque.dispose();
  g?.cloth.dispose();
  g?.glow.dispose();
  const occ = new CameraOccluders(sink.boxes, map.size);
  const w = new PickWorld(map);
  w.setCameraOccluders(occ);
  return { w, occ };
}

/** prop-local (lx, ly, lz) → world */
function local(lx: number, ly: number, lz: number): { x: number; y: number; z: number } {
  const c = Math.cos(house.rot);
  const s = Math.sin(house.rot);
  return { x: house.x + lx * c + lz * s, y: house.y + ly, z: house.z - lx * s + lz * c };
}

describe('roof and dock occluders from the prop builders', () => {
  it('a house roof registers its whole shell, eave overhang included', () => {
    const { occ } = houseWorld();
    expect(occ.count).toBeGreaterThanOrEqual(5);
    const wallH = 0.58 * house.sy;
    // inside the eave overhang (0.3 m outside the wall, just under the eave line)
    expect(occ.contains(local(house.sx / 2 + 0.3, wallH - 0.1, 0))).toBe(true);
    // under the ridge
    expect(occ.contains(local(0, house.sy - 0.2, 0))).toBe(true);
    // well above the roof, and at head height beside the wall: free
    expect(occ.contains(local(0, house.sy + 1, 0))).toBe(false);
    expect(occ.contains(local(house.sx / 2 + 0.5, 1.6, 0))).toBe(false);
  });

  it('a hero hugging the house wall: the camera stops short of the eave instead of entering it', () => {
    const { w, occ } = houseWorld();
    // outside the east wall, facing along it (the house on the right, like the repro)
    const pos = local(house.sx / 2 + 0.45, 0, 0.5);
    const s = Math.sin(house.rot);
    const c = Math.cos(house.rot);
    const yaw = Math.atan2(-s, -c); // facing local +Z
    for (const pitch of [-0.45, -0.2, 0.1]) {
      const res = resolveCameraCollision(w, pos, yaw, pitch);
      expect(occ.contains(res.pos), `pitch ${pitch}`).toBe(false);
    }
    // looking down the boom rises into the eave: it must have been shortened
    const res = resolveCameraCollision(w, pos, yaw, -0.2);
    expect(res.back).toBeLessThan(CAM_BACK);
    // sanity: without the roof occluders the camera would sit inside the eave
    const bare = new PickWorld(flatMap(propColliders(house)));
    const raw = resolveCameraCollision(bare, pos, yaw, -0.2);
    expect(occ.contains(raw.pos)).toBe(true);
    void dirFromYawPitch;
    void rightFromYaw;
  });

  it('a hero wading beside a dock: the camera is not under the deck', () => {
    // dock deck top at y = 3.25 over water 2 (the 赤壁 dock), hero in the water north of it
    const dock: MapProp = { type: 'dock', variant: 0, x: 0, y: 3.25, z: 0, sx: 46, sy: 3.5, sz: 4, rot: 0 };
    const map = flatMap(propColliders(dock), 2);
    const sink = new CamOccluderSink();
    buildPropGeometry(dock, map, sink);
    const occ = new CameraOccluders(sink.boxes, map.size);
    expect(occ.contains({ x: 0, y: 2.6, z: 0 })).toBe(true);
    expect(occ.contains({ x: 0, y: 4, z: 0 })).toBe(false);
    const w = new PickWorld(map);
    w.setCameraOccluders(occ);
    // hero at z = 3.2 (0.8 m off the dock edge), looking +Z (away from the dock), standing in the water
    const pos = { x: 0, y: 0.8, z: 3.2 };
    const res = resolveCameraCollision(w, pos, Math.PI, -0.05);
    expect(res.pos.z).toBeGreaterThan(2);
    expect(occ.contains(res.pos)).toBe(false);
    const bare = resolveCameraCollision(new PickWorld(map), pos, Math.PI, -0.05);
    expect(bare.pos.z).toBeLessThan(2); // what used to happen: under the planks
  });
});
