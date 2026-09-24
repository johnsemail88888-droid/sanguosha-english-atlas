// Decorative grass tufts around the camera (quality-scaled): one instanced
// mesh, re-scattered on a stable world grid whenever the camera crosses a
// cell, so tufts never "swim". Only on gentle, dry, collider-free ground.
import * as THREE from 'three';
import type { MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import { addWindSway } from '../core/materials';
import { hash2 } from '../core/noise';
import type { PickWorld } from '../camera/pick';
import { terrainColor } from './terrain';

const CELL = 1.6;
const RADIUS = 34;
const REBUILD_STEP = 6;

function tuftGeometry(): THREE.BufferGeometry {
  // blades carry a brightness multiplier (dark root → bright tip); the terrain
  // colour comes from the instance colour. Normals point up so tufts light
  // exactly like the ground they grow from.
  const pos: number[] = [];
  const clr: number[] = [];
  const blades = 5;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + i * 0.7;
    const lean = 0.12 + (i % 2) * 0.08;
    const h = 0.8 + (i % 3) * 0.12;
    const w = 0.07;
    const cx = Math.cos(a);
    const sz = Math.sin(a);
    const p0 = [-sz * w, 0, cx * w];
    const p1 = [sz * w, 0, -cx * w];
    const p2 = [cx * lean, h, sz * lean];
    for (const tri of [
      [p0, p1, p2],
      [p1, p0, p2],
    ]) {
      for (const v of tri) {
        pos.push(v[0], v[1], v[2]);
        const k = 0.55 + 0.8 * (v[1] / h);
        clr.push(k, k, k * 0.9);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(clr, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.computeBoundingSphere();
  return g;
}

export class GrassField {
  readonly mesh: THREE.InstancedMesh;
  private readonly map: MapData;
  private readonly pick: PickWorld;
  private readonly capacity: number;
  private density = 1;
  private lastKey = '';
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.MeshStandardMaterial;

  constructor(map: MapData, pick: PickWorld, capacity = 4200) {
    this.map = map;
    this.pick = pick;
    this.capacity = capacity;
    this.geo = tuftGeometry();
    // blades are duplicated with both windings, so FrontSide shows exactly one (up-normal) copy
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    addWindSway(this.mat, 0.12, 1.0);
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, capacity);
    this.mesh.name = 'grass';
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  setDensity(d: number): void {
    if (d !== this.density) {
      this.density = d;
      this.lastKey = '';
    }
    this.mesh.visible = d > 0;
  }

  update(cam: THREE.Vector3): void {
    if (this.density <= 0) return;
    const key = `${Math.round(cam.x / REBUILD_STEP)},${Math.round(cam.z / REBUILD_STEP)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.rebuild(cam);
  }

  private rebuild(cam: THREE.Vector3): void {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    const half = this.map.size / 2 - 6;
    const wl = this.map.waterLevel;
    let n = 0;
    const i0 = Math.floor((cam.x - RADIUS) / CELL);
    const i1 = Math.floor((cam.x + RADIUS) / CELL);
    const j0 = Math.floor((cam.z - RADIUS) / CELL);
    const j1 = Math.floor((cam.z + RADIUS) / CELL);
    const keep = 0.72 * this.density;
    for (let j = j0; j <= j1 && n < this.capacity; j++) {
      for (let i = i0; i <= i1 && n < this.capacity; i++) {
        const h0 = hash2(i, j);
        if (h0 > keep) continue;
        const x = (i + hash2(i + 91, j - 17)) * CELL;
        const z = (j + hash2(i - 33, j + 57)) * CELL;
        if (Math.abs(x) > half || Math.abs(z) > half) continue;
        const dx = x - cam.x;
        const dz = z - cam.z;
        if (dx * dx + dz * dz > RADIUS * RADIUS) continue;
        const y = terrainHeight(this.map, x, z);
        if (y < wl + 0.5) continue;
        const gx = terrainHeight(this.map, x + 1, z) - terrainHeight(this.map, x - 1, z);
        const gz = terrainHeight(this.map, x, z + 1) - terrainHeight(this.map, x, z - 1);
        const slope = Math.hypot(gx, gz) / 2;
        if (slope > 0.45) continue;
        if (this.pick.pointInCollider(x, y + 0.2, z)) continue;
        terrainColor(y, slope * 2.2, x, z, wl, c);
        // skip dirt / rock coloured ground (greenness test)
        if (c.g < c.r * 0.95) continue;
        const sc = 0.3 + hash2(i + 7, j + 3) * 0.35;
        e.set(0, hash2(i + 1, j + 1) * Math.PI * 2, 0);
        q.setFromEuler(e);
        p.set(x, y - 0.03, z);
        s.set(sc, sc * (0.8 + hash2(i + 5, j) * 0.6), sc);
        m.compose(p, q, s);
        this.mesh.setMatrixAt(n, m);
        c.multiplyScalar(0.95 + hash2(i, j + 9) * 0.3);
        this.mesh.setColorAt(n, c);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}
