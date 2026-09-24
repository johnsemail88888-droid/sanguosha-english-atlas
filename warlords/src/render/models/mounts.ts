// Procedural mounts: warhorse (heroes on a -1/+1 马, cavalry troops) and war
// elephant (战象). Rigidly skinned like the humanoids, with their own tiny
// skeletons and a gait animator.
import * as THREE from 'three';
import { GeoBuilder, PRIM, col, mixCol, shade, trs, segmentMatrix, type ColorLike } from '../core/geo';
import { characterMaterial } from '../core/materials';

export type MountKind = 'horse' | 'elephant';

interface BoneDef {
  name: string;
  parent: string | null;
  pos: [number, number, number];
}

const HORSE_BONES: BoneDef[] = [
  { name: 'root', parent: null, pos: [0, 0, 0] },
  { name: 'body', parent: 'root', pos: [0, 1.22, 0] },
  { name: 'neck', parent: 'body', pos: [0, 1.4, -0.66] },
  { name: 'head', parent: 'neck', pos: [0, 1.86, -1.0] },
  { name: 'FLu', parent: 'body', pos: [-0.17, 1.06, -0.58] },
  { name: 'FLl', parent: 'FLu', pos: [-0.17, 0.56, -0.58] },
  { name: 'FRu', parent: 'body', pos: [0.17, 1.06, -0.58] },
  { name: 'FRl', parent: 'FRu', pos: [0.17, 0.56, -0.58] },
  { name: 'BLu', parent: 'body', pos: [-0.17, 1.1, 0.6] },
  { name: 'BLl', parent: 'BLu', pos: [-0.17, 0.58, 0.66] },
  { name: 'BRu', parent: 'body', pos: [0.17, 1.1, 0.6] },
  { name: 'BRl', parent: 'BRu', pos: [0.17, 0.58, 0.66] },
  { name: 'tail', parent: 'body', pos: [0, 1.36, 0.82] },
];

const ELEPHANT_BONES: BoneDef[] = [
  { name: 'root', parent: null, pos: [0, 0, 0] },
  { name: 'body', parent: 'root', pos: [0, 2.0, 0] },
  { name: 'head', parent: 'body', pos: [0, 2.35, -1.45] },
  { name: 'trunk1', parent: 'head', pos: [0, 2.0, -2.05] },
  { name: 'trunk2', parent: 'trunk1', pos: [0, 1.25, -2.2] },
  { name: 'FL', parent: 'body', pos: [-0.55, 1.45, -0.95] },
  { name: 'FR', parent: 'body', pos: [0.55, 1.45, -0.95] },
  { name: 'BL', parent: 'body', pos: [-0.55, 1.45, 0.95] },
  { name: 'BR', parent: 'body', pos: [0.55, 1.45, 0.95] },
  { name: 'tail', parent: 'body', pos: [0, 2.2, 1.45] },
  { name: 'earL', parent: 'head', pos: [-0.5, 2.55, -1.5] },
  { name: 'earR', parent: 'head', pos: [0.5, 2.55, -1.5] },
];

/**
 * Uniform scale of each mount model. The rigs are authored at a heroic size;
 * they are drawn smaller so the rider sits inside the simulation's hit box
 * (sim/troops.ts unitSize: horse cavalry 0.6 x 2.3 m with the head sphere
 * centred at 2.02 m, war elephant 1.3 x 3.2 m with the head at 2.81 m;
 * mounted heroes use the cavalry box, see docs/CONTRACT_CHANGES.md).
 */
export const MOUNT_SCALE: Record<MountKind, number> = { horse: 0.86, elephant: 0.72 };

/** Height of the rider's hip bone above the ground (authored saddle height x MOUNT_SCALE). */
export const SADDLE_HIP: Record<MountKind, number> = { horse: 1.6 * MOUNT_SCALE.horse, elephant: 3.25 * MOUNT_SCALE.elephant };

export class MountRig {
  readonly object: THREE.Group;
  readonly mesh: THREE.SkinnedMesh;
  readonly kind: MountKind;
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly rest = new Map<string, THREE.Vector3>();
  private phase = 0;
  private gait = 0;
  readonly material: THREE.MeshStandardMaterial;

  constructor(kind: MountKind, coat: string, cloth: string, trim: string) {
    this.kind = kind;
    const defs = kind === 'horse' ? HORSE_BONES : ELEPHANT_BONES;
    const index = new Map<string, number>();
    const bones = defs.map((d, i) => {
      const b = new THREE.Bone();
      b.name = d.name;
      index.set(d.name, i);
      this.bones.set(d.name, b);
      return b;
    });
    defs.forEach((d, i) => {
      if (d.parent) {
        const p = defs[index.get(d.parent)!];
        bones[index.get(d.parent)!].add(bones[i]);
        bones[i].position.set(d.pos[0] - p.pos[0], d.pos[1] - p.pos[1], d.pos[2] - p.pos[2]);
      } else bones[i].position.set(...d.pos);
      this.rest.set(d.name, bones[i].position.clone());
    });
    const gb = new GeoBuilder({ skinned: true });
    const on = (n: string): void => {
      gb.bone = index.get(n)!;
    };
    if (kind === 'horse') buildHorse(gb, on, coat, cloth, trim);
    else buildElephant(gb, on, coat, cloth, trim);
    const geo = gb.build();
    this.material = characterMaterial();
    this.mesh = new THREE.SkinnedMesh(geo, this.material);
    this.mesh.add(bones[0]);
    this.mesh.bind(new THREE.Skeleton(bones));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.object = new THREE.Group();
    this.object.scale.setScalar(MOUNT_SCALE[kind]);
    this.object.add(this.mesh);
  }

  /** Advance gait from ground speed (m/s). Returns the vertical bob of the saddle (m). */
  update(dt: number, speed: number, t: number): number {
    const b = (n: string): THREE.Bone => this.bones.get(n)!;
    const targetGait = Math.min(1, speed / 7);
    this.gait += (targetGait - this.gait) * (1 - Math.exp(-dt * 6));
    const moving = speed > 0.3;
    // stride in world metres (the model is scaled): keeps hooves from sliding
    const stride = (this.kind === 'horse' ? 1.6 + this.gait * 1.6 : 2.4) * MOUNT_SCALE[this.kind];
    this.phase = (this.phase + (dt * speed) / stride) % 1;
    const P = this.phase * Math.PI * 2;
    let bob = 0;
    if (this.kind === 'horse') {
      const g = this.gait;
      // blend walk (4-beat) → gallop (paired) offsets
      const offs: Record<string, number> = {
        FL: 0,
        FR: 0.5 - 0.4 * g,
        BL: 0.25 + 0.25 * g,
        BR: 0.75 - 0.15 * g,
      };
      const amp = moving ? 0.35 + 0.35 * g : 0;
      for (const leg of ['FL', 'FR', 'BL', 'BR']) {
        const ph = P + offs[leg] * Math.PI * 2;
        const front = leg[0] === 'F';
        b(`${leg}u`).rotation.x = Math.sin(ph) * amp * (front ? 1 : 0.9);
        const bend = Math.max(0, Math.sin(ph + (front ? 1.2 : -1.2))) * amp * 1.4;
        b(`${leg}l`).rotation.x = front ? -bend : bend;
      }
      bob = moving ? Math.abs(Math.sin(P * (g > 0.5 ? 1 : 2))) * (0.03 + 0.07 * g) : Math.sin(t * 1.3) * 0.01;
      b('body').rotation.x = moving ? Math.sin(P) * 0.06 * g : 0;
      b('body').position.y = this.rest.get('body')!.y + bob;
      b('neck').rotation.x = moving ? -Math.sin(P + 0.5) * 0.12 * (0.4 + g) : Math.sin(t * 0.7) * 0.05;
      b('head').rotation.x = moving ? Math.sin(P) * 0.08 : Math.sin(t * 0.9 + 1) * 0.06;
      b('tail').rotation.x = -0.4 - (moving ? 0.5 * g : 0) + Math.sin(t * 2.3) * 0.08;
      b('tail').rotation.z = Math.sin(t * 1.7) * 0.15;
    } else {
      const amp = moving ? 0.28 : 0;
      const offs: Record<string, number> = { FL: 0, FR: 0.5, BL: 0.75, BR: 0.25 };
      for (const leg of ['FL', 'FR', 'BL', 'BR']) b(leg).rotation.x = Math.sin(P + offs[leg] * Math.PI * 2) * amp;
      bob = moving ? Math.abs(Math.sin(P * 2)) * 0.06 : Math.sin(t * 0.8) * 0.015;
      b('body').position.y = this.rest.get('body')!.y + bob;
      b('body').rotation.z = moving ? Math.sin(P) * 0.03 : 0;
      b('trunk1').rotation.x = 0.1 + Math.sin(t * 1.1) * 0.12 + (moving ? Math.sin(P) * 0.1 : 0);
      b('trunk2').rotation.x = 0.25 + Math.sin(t * 1.1 + 0.8) * 0.25;
      b('earL').rotation.y = -0.2 + Math.sin(t * 2.1) * 0.25;
      b('earR').rotation.y = 0.2 - Math.sin(t * 2.1 + 0.4) * 0.25;
      b('tail').rotation.z = Math.sin(t * 2) * 0.3;
    }
    // bone offsets are in model units; the rider's root is not scaled
    return bob * MOUNT_SCALE[this.kind];
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

function limb(gb: GeoBuilder, a: THREE.Vector3, b: THREE.Vector3, rA: number, rB: number, c: ColorLike): void {
  const ratio = Math.round((rB / rA) * 50) / 50;
  gb.add(PRIM.cyl(7, ratio), segmentMatrix(a, b, rA), c);
}

function buildHorse(gb: GeoBuilder, on: (n: string) => void, coat: string, cloth: string, trim: string): void {
  const dark = shade(coat, 0.55);
  const mane = shade(coat, 0.35);
  const hoof = '#2a2420';
  on('body');
  gb.add(PRIM.sphere(10, 7), trs(0, 1.24, 0, 0, 0, 0, 0.3, 0.33, 0.82), coat);
  gb.add(PRIM.sphere(8, 6), trs(0, 1.3, -0.5, 0, 0, 0, 0.29, 0.34, 0.35), coat); // chest
  gb.add(PRIM.sphere(8, 6), trs(0, 1.3, 0.55, 0, 0, 0, 0.3, 0.33, 0.35), coat); // rump
  // saddle cloth + saddle
  gb.add(PRIM.box(), trs(0, 1.5, 0.0, 0, 0, 0, 0.66, 0.2, 0.62), cloth);
  gb.add(PRIM.box(), trs(0, 1.4, 0.0, 0, 0, 0, 0.67, 0.04, 0.64), trim);
  gb.add(PRIM.box(), trs(0, 1.6, 0.0, 0, 0, 0, 0.36, 0.08, 0.46), '#4a3222');
  gb.add(PRIM.box(), trs(0, 1.66, -0.2, 0, 0, 0, 0.3, 0.1, 0.06), '#4a3222');
  gb.add(PRIM.box(), trs(0, 1.68, 0.2, 0, 0, 0, 0.34, 0.14, 0.06), '#4a3222');
  // stirrups
  for (const sx of [-1, 1]) {
    gb.rod(v(sx * 0.2, 1.55, 0), v(sx * 0.24, 1.05, 0), 0.008, '#3a2a1a', 3);
    gb.add(PRIM.torus(0.2, 3, 8), trs(sx * 0.24, 1.0, 0, 0, Math.PI / 2, 0, 0.05, 0.05, 0.05), '#8a8a8a');
  }
  on('neck');
  limb(gb, v(0, 1.3, -0.6), v(0, 1.88, -0.98), 0.2, 0.13, coat);
  gb.add(PRIM.box(), trs(0, 1.72, -0.72, 0.7, 0, 0, 0.06, 0.55, 0.12), mane); // mane
  on('head');
  gb.add(PRIM.box(), trs(0, 1.8, -1.2, 0.95, 0, 0, 0.17, 0.46, 0.22), coat);
  gb.add(PRIM.box(), trs(0, 1.68, -1.38, 0.95, 0, 0, 0.15, 0.16, 0.2), shade(coat, 0.85)); // muzzle
  for (const sx of [-1, 1]) {
    gb.add(PRIM.cone(4), trs(sx * 0.06, 2.02, -1.05, -0.2, 0, sx * 0.2, 0.03, 0.12, 0.03), coat); // ears
    gb.add(PRIM.box(), trs(sx * 0.088, 1.88, -1.18, 0, 0, 0, 0.01, 0.03, 0.04), '#101010'); // eyes
  }
  gb.add(PRIM.box(), trs(0, 1.95, -1.03, 0.9, 0, 0, 0.05, 0.2, 0.1), mane); // forelock
  gb.add(PRIM.box(), trs(0, 1.76, -1.24, 0.95, 0, 0, 0.19, 0.03, 0.24), trim); // bridle
  gb.add(PRIM.cone(6), trs(0, 1.6, -1.05, Math.PI, 0, 0, 0.06, 0.14, 0.06), '#c8322a'); // red tassel
  const legs: [string, string, number, number][] = [
    ['FLu', 'FLl', -0.17, -0.58],
    ['FRu', 'FRl', 0.17, -0.58],
    ['BLu', 'BLl', -0.17, 0.62],
    ['BRu', 'BRl', 0.17, 0.62],
  ];
  for (const [u, l, x, z] of legs) {
    const back = z > 0;
    on(u);
    limb(gb, v(x, back ? 1.2 : 1.12, z), v(x, 0.56, back ? z + 0.04 : z), back ? 0.13 : 0.1, 0.06, coat);
    on(l);
    limb(gb, v(x, 0.58, back ? z + 0.04 : z), v(x, 0.1, z), 0.055, 0.045, back ? coat : coat);
    limb(gb, v(x, 0.22, z), v(x, 0.08, z), 0.055, 0.058, dark);
    gb.add(PRIM.cyl(6), trs(x, 0.04, z, 0, 0, 0, 0.06, 0.08, 0.07), hoof);
  }
  on('tail');
  limb(gb, v(0, 1.4, 0.82), v(0, 0.75, 1.0), 0.07, 0.03, mane);
}

function buildElephant(gb: GeoBuilder, on: (n: string) => void, coat: string, cloth: string, trim: string): void {
  const skin = col(coat);
  const tusk = '#efe6cf';
  on('body');
  gb.add(PRIM.sphere(12, 8), trs(0, 2.05, 0, 0, 0, 0, 0.95, 0.9, 1.55), skin);
  // war blanket + howdah
  gb.add(PRIM.box(), trs(0, 2.75, 0, 0, 0, 0, 1.6, 0.35, 1.6), cloth);
  gb.add(PRIM.box(), trs(0, 2.6, 0, 0, 0, 0, 1.62, 0.06, 1.62), trim);
  gb.add(PRIM.box(), trs(0, 3.0, 0.1, 0, 0, 0, 1.1, 0.12, 1.2), '#5a3f28');
  for (const [px, pz] of [
    [-0.5, -0.45],
    [0.5, -0.45],
    [-0.5, 0.65],
    [0.5, 0.65],
  ]) {
    gb.rod(v(px, 3.0, pz), v(px, 4.75, pz), 0.03, '#9b2b22', 5);
  }
  gb.add(PRIM.box(), trs(0, 3.25, 0.1, 0, 0, 0, 1.12, 0.05, 1.22), trim);
  // parasol canopy high enough for the huge rider's head (model units; x MOUNT_SCALE in the world)
  gb.add(PRIM.cone(4), trs(0, 4.97, 0.1, 0, Math.PI / 4, 0, 0.95, 0.45, 0.95), cloth);
  on('head');
  gb.add(PRIM.sphere(10, 7), trs(0, 2.45, -1.55, 0, 0, 0, 0.62, 0.7, 0.6), skin);
  gb.add(PRIM.box(), trs(0, 2.75, -1.65, 0.2, 0, 0, 0.6, 0.35, 0.3), mixCol(cloth, trim, 0.3)); // head plate
  for (const sx of [-1, 1]) {
    gb.add(PRIM.box(), trs(sx * 0.22, 2.55, -2.06, 0, 0, 0, 0.05, 0.06, 0.04), '#141010');
    gb.add(PRIM.cone(6), trs(sx * 0.25, 1.85, -2.25, -2.1, 0, sx * 0.1, 0.07, 0.75, 0.07), tusk);
  }
  on('earL');
  gb.add(PRIM.sphere(8, 6), trs(-0.62, 2.45, -1.4, 0, 0.35, 0, 0.08, 0.55, 0.45), shade(coat, 0.9));
  on('earR');
  gb.add(PRIM.sphere(8, 6), trs(0.62, 2.45, -1.4, 0, -0.35, 0, 0.08, 0.55, 0.45), shade(coat, 0.9));
  on('trunk1');
  limb(gb, v(0, 2.2, -2.0), v(0, 1.25, -2.2), 0.24, 0.16, skin);
  on('trunk2');
  limb(gb, v(0, 1.28, -2.2), v(0, 0.55, -2.3), 0.16, 0.1, skin);
  for (const leg of [
    ['FL', -0.55, -0.95],
    ['FR', 0.55, -0.95],
    ['BL', -0.55, 0.95],
    ['BR', 0.55, 0.95],
  ] as [string, number, number][]) {
    on(leg[0]);
    limb(gb, v(leg[1], 1.7, leg[2]), v(leg[1], 0.05, leg[2]), 0.32, 0.3, skin);
    gb.add(PRIM.cyl(8), trs(leg[1], 0.25, leg[2], 0, 0, 0, 0.33, 0.1, 0.33), trim); // ankle band
  }
  on('tail');
  limb(gb, v(0, 2.2, 1.5), v(0, 1.3, 1.62), 0.06, 0.03, skin);
}
