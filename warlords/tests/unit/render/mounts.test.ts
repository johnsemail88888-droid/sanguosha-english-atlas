// AI-art mounts: the code-built quadruped rig (calibration, normalisation,
// skin weights), coat variants / recolour, and the MountRig swap from the
// procedural mount to the rigged model (stub loader, no GPU).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MOUNT_BY_ID } from '../../../src/data';
import {
  ELEPHANT_CALIB,
  HORSE_CALIB,
  LEG_IDS,
  QUAD_CALIB,
  measureSeatTop,
  mountRigMatrix,
  quadBones,
  quadSkinWeights,
  refineJoints,
  segmentDistance,
  type QuadCalib,
} from '../../../src/render/models/quadrupedRig';
import {
  coatGamma,
  measureCoatRef,
  mountCoatVariant,
  mountModelPath,
  recolourCoat,
  releaseMountTemplates,
  rigMountMesh,
  setMountLoaderForTests,
  tackTexel,
} from '../../../src/render/models/mountGlb';
import { MOUNT_SCALE, MountRig, SADDLE_HIP, SEAT_TO_HIP, mountSeatHeight } from '../../../src/render/models/mounts';
import { CharacterRig } from '../../../src/render/models/character';
import { heroSpec } from '../../../src/render/models';
import { assetList, setAssetListForTests } from '../../../src/game/assets';

/**
 * A crude stand-in for a shipped mount: boxes along every bone segment of the
 * calibration (file coordinates, head +Z), plus a saddle block on the seat.
 */
function stubMountMesh(calib: QuadCalib): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const j = (n: string): THREE.Vector3 => new THREE.Vector3(...(calib.joints[n] ?? [calib.seat[0], -0.7, calib.seat[2]]));
  for (const b of calib.bones) {
    if (b.r <= 0) continue;
    const a = j(b.seg[0]);
    const e = j(b.seg[1]);
    const len = Math.max(0.02, a.distanceTo(e));
    const g = new THREE.BoxGeometry(b.r * 1.2, len, b.r * 1.2, 1, 6, 1);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), e.clone().sub(a).normalize());
    g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(e).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
    parts.push(g.toNonIndexed());
  }
  const saddle = new THREE.BoxGeometry(0.3, 0.08, 0.3).translate(calib.seat[0], calib.seat[1] - 0.04, calib.seat[2]);
  parts.push(saddle.toNonIndexed());
  // merge (positions + uvs)
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  let o = 0;
  for (const p of parts) {
    pos.set(p.getAttribute('position').array as Float32Array, o * 3);
    uv.set(p.getAttribute('uv').array as Float32Array, o * 2);
    o += p.getAttribute('position').count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
}

describe('quadruped rig', () => {
  it('normalises a mount: head to −Z, hooves on the ground, the seat over the origin at the seat height', () => {
    for (const calib of [HORSE_CALIB, ELEPHANT_CALIB]) {
      const minY = -0.72;
      const m = mountRigMatrix(calib, minY, 1.4);
      const seat = new THREE.Vector3(...calib.seat).applyMatrix4(m);
      expect(seat.x).toBeCloseTo(0, 6);
      expect(seat.z).toBeCloseTo(0, 6);
      expect(seat.y).toBeCloseTo(1.4, 6);
      const hoof = new THREE.Vector3(0, minY, 0).applyMatrix4(m);
      expect(hoof.y).toBeCloseTo(0, 6);
      // the muzzle / trunk is ahead: −Z in rig space
      const head = new THREE.Vector3(...(calib.joints.muzzle ?? calib.joints.trunk0)).applyMatrix4(m);
      expect(head.z).toBeLessThan(-0.5);
    }
  });

  it('builds a skeleton with left legs on the left (−X) and every parent known', () => {
    for (const calib of [HORSE_CALIB, ELEPHANT_CALIB]) {
      const joints = refineJoints(new Float32Array(0), calib, -0.72);
      const bones = quadBones(calib, joints, mountRigMatrix(calib, -0.72, 1.4));
      const names = new Set(bones.map((b) => b.name));
      for (const b of bones) if (b.parent) expect(names.has(b.parent), `${calib.kind}:${b.name}`).toBe(true);
      expect(bones[0].parent).toBeNull();
      for (const id of LEG_IDS) {
        const u = bones.find((b) => b.name === `${id}u`)!;
        expect(Math.sign(u.pos.x), `${calib.kind} ${id}`).toBe(id[1] === 'L' ? -1 : 1);
        expect(Math.sign(u.pos.z), `${calib.kind} ${id}`).toBe(id[0] === 'F' ? -1 : 1);
      }
    }
  });

  it('measures the leg columns from the mesh (a shifted leg moves its joints, within limits)', () => {
    const calib = HORSE_CALIB;
    const foot = calib.joints.FR4;
    const pts: number[] = [];
    // a column of vertices for the right front leg, 3 cm further out than calibrated
    for (let y = -0.74; y < -0.6; y += 0.01) for (const dx of [-0.02, 0, 0.02]) pts.push(foot[0] - 0.03 + dx, y, foot[2]);
    const joints = refineJoints(Float32Array.from(pts), calib, -0.746);
    expect(joints.FR4.x).toBeCloseTo(foot[0] - 0.03, 2);
    expect(joints.FR2.x).toBeCloseTo(calib.joints.FR2[0] - 0.03, 2);
    // the other legs keep their calibration
    expect(joints.FL4.x).toBeCloseTo(calib.joints.FL4[0], 6);
  });

  it('skins legs strictly to their own chain, rigid regions to one bone, weights normalised', () => {
    for (const kind of ['horse', 'elephant'] as const) {
      const calib = QUAD_CALIB[kind];
      const mesh = stubMountMesh(calib);
      const r = rigMountMesh(kind, mesh, 1.5);
      const g = r.geometry;
      const pos = g.getAttribute('position');
      const si = g.getAttribute('skinIndex');
      const sw = g.getAttribute('skinWeight');
      const bones = r.bones;
      const legOf = (i: number): string | null => (/^(F|B)(L|R)[ulch]$/.test(bones[i].name) ? bones[i].name.slice(0, 2) : null);
      const bodyBone = bones.findIndex((b) => b.name === 'body');
      let legVerts = 0;
      for (let v = 0; v < pos.count; v++) {
        let sum = 0;
        const legs = new Set<string>();
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(v, k);
          sum += w;
          if (w > 0) {
            expect(si.getComponent(v, k)).toBeLessThan(bones.length);
            const l = legOf(si.getComponent(v, k));
            if (l) legs.add(l);
          }
        }
        expect(sum).toBeCloseTo(1, 4);
        // never pulled by two legs
        expect(legs.size, `${kind} vertex ${v}`).toBeLessThanOrEqual(1);
        // a vertex low on a leg: that leg only, on the matching side / end
        const y = pos.getY(v);
        if (y < 0.25 * 1.5 && legs.size === 1) {
          legVerts++;
          const l = [...legs][0];
          for (let k = 0; k < 4; k++) if (sw.getComponent(v, k) > 0) expect(legOf(si.getComponent(v, k))).toBe(l);
          expect(Math.sign(pos.getX(v))).toBe(l[1] === 'L' ? -1 : 1);
        }
      }
      expect(legVerts).toBeGreaterThan(40);
      // the saddle block sits in the rigid region: 100 % body
      let rigid = 0;
      for (let v = 0; v < pos.count; v++) {
        // the saddle block's corners (±0.15 file units around the seat, top at the seat height)
        if (Math.abs(pos.getX(v)) < 0.25 && Math.abs(pos.getZ(v)) < 0.25 && pos.getY(v) > 1.39) {
          rigid++;
          expect(si.getX(v)).toBe(bodyBone);
          expect(sw.getX(v)).toBeCloseTo(1, 6);
        }
      }
      expect(rigid).toBeGreaterThan(0);
      g.dispose();
    }
  });

  it('keeps the rest pose: binding the skeleton leaves every vertex where it was', () => {
    const r = rigMountMesh('horse', stubMountMesh(HORSE_CALIB), 1.5);
    const index = new Map(r.bones.map((b, i) => [b.name, i]));
    const bones = r.bones.map((b) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      return bone;
    });
    r.bones.forEach((b, i) => {
      if (b.parent) {
        const p = index.get(b.parent)!;
        bones[p].add(bones[i]);
        bones[i].position.copy(b.pos).sub(r.bones[p].pos);
      } else bones[i].position.copy(b.pos);
    });
    const mesh = new THREE.SkinnedMesh(r.geometry, new THREE.MeshBasicMaterial());
    mesh.add(bones[0]);
    mesh.bind(new THREE.Skeleton(bones));
    const p = r.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 7) {
      mesh.getVertexPosition(i, v);
      expect(v.distanceTo(new THREE.Vector3().fromBufferAttribute(p, i))).toBeLessThan(1e-4);
    }
    // bending the front-left knee moves its hoof, not the right hoof nor the saddle
    bones[index.get('FLc')!].rotation.x = -0.8;
    mesh.updateMatrixWorld(true);
    let movedL = 0;
    let movedOther = 0;
    for (let i = 0; i < p.count; i++) {
      const rest = new THREE.Vector3().fromBufferAttribute(p, i);
      mesh.getVertexPosition(i, v);
      const d = v.distanceTo(rest);
      if (rest.y < 0.2 && rest.z < 0 && rest.x < -0.03) movedL = Math.max(movedL, d);
      else if (rest.y < 0.2) movedOther = Math.max(movedOther, d);
    }
    expect(movedL).toBeGreaterThan(0.05);
    expect(movedOther).toBeLessThan(1e-4);
  });

  it('measures the seat top on the mesh (the cantle and pommel around it do not count)', () => {
    const [x, y, z] = HORSE_CALIB.seat;
    const pts = [x, y + 0.02, z, x + 0.03, y + 0.015, z, x, y + 0.2, z - 0.15, x, y + 0.09, z + 0.2];
    expect(measureSeatTop(Float32Array.from(pts), HORSE_CALIB)).toBeCloseTo(y + 0.02, 6);
    expect(measureSeatTop(new Float32Array(0), HORSE_CALIB)).toBe(y);
  });

  it('measures segment distances', () => {
    const a = new THREE.Vector3(0, 0, 0);
    const b = new THREE.Vector3(0, 1, 0);
    expect(segmentDistance(1, 0.5, 0, a, b)).toBeCloseTo(1, 6);
    expect(segmentDistance(0, 2, 0, a, b)).toBeCloseTo(1, 6);
    expect(segmentDistance(0, -1, 0, a, a)).toBeCloseTo(1, 6);
  });
});

describe('mount coats', () => {
  const srgb = (hex: string): THREE.Color => new THREE.Color(hex); // linear, from sRGB hex
  const disp = (c: THREE.Color): [number, number, number] => [Math.sqrt(c.r), Math.sqrt(c.g), Math.sqrt(c.b)];

  it('maps every mount item (and the innate / troop horses) to a coat', () => {
    expect(mountCoatVariant(MOUNT_BY_ID.dawan.color).coat).toBeNull(); // the painted bay
    expect(mountCoatVariant('#6b4a2e').coat).toBeNull(); // default war horse
    const chitu = new THREE.Color(mountCoatVariant(MOUNT_BY_ID.chitu.color).coat!);
    expect(chitu.r).toBeGreaterThan(chitu.g * 3);
    const jue = new THREE.Color(mountCoatVariant(MOUNT_BY_ID.jueying.color).coat!);
    expect(jue.r + jue.g + jue.b).toBeLessThan(0.1);
    const dilu = mountCoatVariant(MOUNT_BY_ID.dilu.color);
    expect(new THREE.Color(dilu.coat!).getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace).l).toBeGreaterThan(0.75);
    expect(dilu.blaze).not.toBeNull();
    const zh = mountCoatVariant(MOUNT_BY_ID.zhuahuang.color);
    expect(zh.legs).not.toBeNull();
    expect(zh.blaze).toBeNull();
    const zi = new THREE.Color(mountCoatVariant(MOUNT_BY_ID.zixing.color).coat!);
    expect(zi.b).toBeGreaterThan(zi.g); // violet cast
    // an unknown colour recolours to itself; garbage keeps the painting
    expect(mountCoatVariant('#123456').coat).toBe('#123456');
    expect(mountCoatVariant('not a colour').coat).toBeNull();
  });

  it('keeps tack texels (brass, crimson lacquer, metal) and recolours the coat', () => {
    const coat = [srgb('#8a5236'), srgb('#6e3e28'), srgb('#a8653f'), srgb('#4a2a1c')];
    const tack = [srgb('#c8a040'), srgb('#8c1a2a'), srgb('#9a9a9e'), srgb('#d8d8dc')];
    for (const c of coat) expect(tackTexel(...disp(c)), c.getHexString()).toBeLessThan(0.1);
    for (const c of tack) expect(tackTexel(...disp(c)), c.getHexString()).toBeGreaterThan(0.8);
    const white = new THREE.Color('#e4ded2');
    const out = new THREE.Color();
    const ref = 0.08;
    for (const c of coat) {
      recolourCoat(c, white, ref, out);
      expect(Math.abs(out.r - out.b)).toBeLessThan(0.2 * out.r + 0.02); // no bay hue left
    }
    recolourCoat(coat[2], white, ref, out);
    expect(out.r).toBeGreaterThan(0.5); // a lit coat texel goes white
    for (const c of tack) {
      recolourCoat(c, white, ref, out);
      expect(Math.abs(out.r - c.r) + Math.abs(out.g - c.g) + Math.abs(out.b - c.b)).toBeLessThan(0.05);
    }
    // a light coat lifts the painted black points (mane / lower legs) to grey, a dark one does not
    const mane = srgb('#1a1412');
    const lifted = recolourCoat(mane, white, ref, new THREE.Color());
    const dark = recolourCoat(mane, new THREE.Color('#1e1e24'), ref, new THREE.Color());
    expect(lifted.r).toBeGreaterThan(0.1);
    expect(dark.r).toBeLessThan(0.02);
    expect(coatGamma(0.9)).toBeLessThan(coatGamma(0.02));
  });

  it('measures the painted coat luminance', () => {
    const px: number[] = [];
    for (let i = 0; i < 200; i++) px.push(0xa8, 0x65, 0x3f, 255); // coat
    for (let i = 0; i < 200; i++) px.push(0x10, 0x10, 0x10, 255); // black
    for (let i = 0; i < 100; i++) px.push(0xc8, 0xa0, 0x40, 255); // brass
    const ref = measureCoatRef(px);
    const c = new THREE.Color('#a8653f');
    expect(ref).toBeCloseTo(c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722, 3);
    expect(measureCoatRef([0, 0, 0, 255])).toBe(0.08);
  });
});

describe('MountRig with the AI-art model', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    releaseMountTemplates();
  });
  afterEach(() => {
    setMountLoaderForTests(null);
    setAssetListForTests(null);
    releaseMountTemplates();
    warn.mockRestore();
  });

  const useStub = (): void => {
    setMountLoaderForTests({
      async loadAsync(url: string) {
        const kind = url.includes('elephant') ? 'elephant' : 'horse';
        const scene = new THREE.Group();
        scene.add(stubMountMesh(QUAD_CALIB[kind]));
        return { scene };
      },
    });
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('stays procedural when the deploy ships no mount', async () => {
    setAssetListForTests([]);
    await assetList();
    useStub();
    const m = new MountRig('horse', '#6b4a2e', '#8a2a22', '#d8ac4c');
    await settle();
    expect(m.usesGlb).toBe(false);
    expect(m.update(1 / 60, 5, 1)).toBeGreaterThanOrEqual(0);
    m.dispose();
  });

  it('swaps the procedural mount for the rigged model, keeping fades and shadows, and shares the geometry', async () => {
    setAssetListForTests([mountModelPath('horse'), mountModelPath('elephant')]);
    await assetList();
    useStub();
    const rig = new CharacterRig(heroSpec('guanyu'));
    rig.setMount('horse', MOUNT_BY_ID.dilu.color, '#c0392b', '#d8ac4c');
    const first = rig.mount!;
    expect(first.usesGlb).toBe(false); // not rigged yet: procedural first
    rig.setStealth(true);
    await settle();
    expect(first.usesGlb).toBe(true);
    expect(first.mesh.name).toBe('mount_horse');
    expect(first.material.transparent).toBe(true);
    expect(first.material.opacity).toBeLessThan(0.5);
    expect(first.mesh.castShadow).toBe(false);
    expect(first.object.children).toContain(first.mesh);
    expect(first.object.children.length).toBe(1);
    // the next mount of the kind is built from the template right away, same geometry
    const other = new MountRig('horse', MOUNT_BY_ID.chitu.color, '#c0392b', '#d8ac4c');
    expect(other.usesGlb).toBe(true);
    expect(other.mesh.geometry).toBe(first.mesh.geometry);
    expect(other.mesh.skeleton).not.toBe(first.mesh.skeleton);
    expect(other.material).not.toBe(first.material);
    // gait: bones move, the saddle bobs, nothing becomes NaN; the rider sits at SADDLE_HIP
    let bobMax = 0;
    for (let i = 0; i < 120; i++) bobMax = Math.max(bobMax, other.update(1 / 60, 7, i / 60));
    expect(bobMax).toBeGreaterThan(0.01);
    const bone = other.mesh.skeleton.bones.find((b) => b.name === 'FLu')!;
    expect(Number.isFinite(bone.rotation.x)).toBe(true);
    expect(rig.headHeight()).toBeGreaterThan(SADDLE_HIP.horse);
    // disposing a mount keeps the shared geometry
    const disposed = vi.fn();
    other.mesh.geometry.addEventListener('dispose', disposed);
    other.dispose();
    expect(disposed).not.toHaveBeenCalled();
    rig.dispose();
    // the war elephant too
    const ele = new MountRig('elephant', '#8a8580', '#c0392b', '#d8ac4c');
    await settle();
    expect(ele.usesGlb).toBe(true);
    for (let i = 0; i < 30; i++) ele.update(1 / 60, 2, i / 60);
    expect(ele.mesh.skeleton.bones.some((b) => b.name === 'trunk4')).toBe(true);
    ele.dispose();
  });

  it('puts the seat just under the rider\'s hips', () => {
    for (const kind of ['horse', 'elephant'] as const) {
      expect(mountSeatHeight(kind) * MOUNT_SCALE[kind] + SEAT_TO_HIP[kind]).toBeCloseTo(SADDLE_HIP[kind], 6);
    }
  });
});
