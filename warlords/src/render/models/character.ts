// CharacterRig: one procedural character = ONE skinned mesh (body + held
// weapon(s) merged, the weapon skinned to the weapon bone) + optional mount,
// driven by the CharacterAnimator. One draw call (+ its shadow) per character.
// Used by the in-game entity views, the portrait renderer and the turntable.
import * as THREE from 'three';
import { characterMaterial } from '../core/materials';
import { CharacterAnimator, type AnimInput, type RigBones } from '../anim/animator';
import { buildCharacter, specKey, type CharacterSpec } from './humanoid';
import { B, localRest, type BodyDims } from './rig';
import { buildWeapon, isAkimbo, type HoldStyle, type WeaponModel, type WeaponModelInfo } from './weapons';
import { MountRig, SADDLE_HIP, type MountKind } from './mounts';
import { loadHeroGlb } from './glb';

export interface RigUpdate {
  speed: number;
  moveX: number;
  moveZ: number;
  pitch: number;
  flags: number;
}

const mergedCache = new Map<string, THREE.BufferGeometry>();

/** Dispose and forget the body+weapon geometries merged so far (end of a match). */
export function releaseMergedGeometryCache(): void {
  for (const g of mergedCache.values()) g.dispose();
  mergedCache.clear();
}

let xrayMat: THREE.MeshBasicMaterial | null = null;
function xrayMaterial(): THREE.MeshBasicMaterial {
  if (!xrayMat) {
    xrayMat = new THREE.MeshBasicMaterial({
      color: '#ff4a2a',
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      depthFunc: THREE.GreaterDepth,
      fog: false,
    });
    xrayMat.name = 'xray';
  }
  return xrayMat;
}

interface MergePart {
  geo: THREE.BufferGeometry;
  bone: number;
  bind: THREE.Matrix4 | null;
}

/** Append (non-skinned) weapon geometries to a skinned body geometry, rigidly bound to their bones at bind pose. */
function mergeWeapon(body: THREE.BufferGeometry, weapons: MergePart[]): THREE.BufferGeometry {
  const parts: MergePart[] = [{ geo: body, bone: -1, bind: null }, ...weapons];
  let count = 0;
  for (const p of parts) count += p.geo.getAttribute('position').count;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const si = new Uint16Array(count * 4);
  const sw = new Float32Array(count * 4);
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  let o = 0;
  for (const p of parts) {
    const P = p.geo.getAttribute('position') as THREE.BufferAttribute;
    const N = p.geo.getAttribute('normal') as THREE.BufferAttribute;
    const Cc = p.geo.getAttribute('color') as THREE.BufferAttribute;
    const SI = p.geo.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const SW = p.geo.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    if (p.bind) nm.getNormalMatrix(p.bind);
    for (let i = 0; i < P.count; i++, o++) {
      v.fromBufferAttribute(P, i);
      if (p.bind) v.applyMatrix4(p.bind);
      pos[o * 3] = v.x;
      pos[o * 3 + 1] = v.y;
      pos[o * 3 + 2] = v.z;
      v.fromBufferAttribute(N, i);
      if (p.bind) v.applyMatrix3(nm).normalize();
      nrm[o * 3] = v.x;
      nrm[o * 3 + 1] = v.y;
      nrm[o * 3 + 2] = v.z;
      col[o * 3] = Cc.getX(i);
      col[o * 3 + 1] = Cc.getY(i);
      col[o * 3 + 2] = Cc.getZ(i);
      if (SI && SW) {
        si[o * 4] = SI.getX(i);
        si[o * 4 + 1] = SI.getY(i);
        si[o * 4 + 2] = SI.getZ(i);
        si[o * 4 + 3] = SI.getW(i);
        sw[o * 4] = SW.getX(i);
        sw[o * 4 + 1] = SW.getY(i);
        sw[o * 4 + 2] = SW.getZ(i);
        sw[o * 4 + 3] = SW.getW(i);
      } else {
        si[o * 4] = p.bone;
        sw[o * 4] = 1;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.computeBoundingSphere();
  return g;
}

export class CharacterRig {
  /** add this to the scene; position/rotate it at the entity */
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly material: THREE.MeshStandardMaterial;
  readonly animator = new CharacterAnimator();
  readonly spec: CharacterSpec;
  readonly rigBones: RigBones;
  private readonly bodyGeo: THREE.BufferGeometry;
  private readonly dims: BodyDims;
  private readonly key: string;
  private readonly leftHandBusy: boolean;
  private info: WeaponModelInfo | null = null;
  private weaponId: string | null = null;
  private hold: HoldStyle = 'none';
  private akimbo = false;
  mount: MountRig | null = null;
  private readonly mountKey: { kind: MountKind | null; coat: string; cloth: string; trim: string } = { kind: null, coat: '', cloth: '', trim: '' };
  private glbMixer: THREE.AnimationMixer | null = null;
  private glbObject: THREE.Object3D | null = null;
  private glbWeapons: WeaponModel[] = [];
  private disposed = false;
  private stealthed = false;
  private castShadows = true;
  private weaponShown = false;
  private fade = 1;
  private localView = false;
  private xray: THREE.SkinnedMesh | null = null;
  /** reused animator input (no per-frame allocation) */
  private readonly animIn: AnimInput = {
    dt: 0,
    time: 0,
    speed: 0,
    moveX: 0,
    moveZ: 0,
    pitch: 0,
    flags: 0,
    hold: 'none',
    mountHip: 0,
    mountBob: 0,
    leftHandBusy: false,
    akimbo: false,
  };

  constructor(spec: CharacterSpec) {
    this.spec = spec;
    this.key = specKey(spec);
    const built = buildCharacter(spec);
    this.bodyGeo = built.geometry;
    this.dims = built.dims;
    this.leftHandBusy = built.leftHandBusy;
    this.material = characterMaterial();
    this.mesh = new THREE.SkinnedMesh(built.geometry, this.material);
    this.mesh.add(built.bones[0]);
    this.mesh.bind(built.skeleton);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    // generous bounds so frustum culling never clips extreme poses (dance, death, back flags)
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0, 0), 2.4);
    this.mesh.name = 'body';
    this.root.add(this.mesh);
    const rest = localRest(built.rest);
    const d = built.dims;
    this.rigBones = {
      bones: built.bones,
      localRest: rest,
      armL1: d.shoulderY - d.elbowY,
      armL2: d.elbowY - d.wristY,
    };
  }

  /**
   * Height of the top of the head above the feet in world metres (standing,
   * or seated on the current mount), including the rig's root scale.
   */
  headHeight(): number {
    const d = this.dims;
    let top = d.headCY + 0.19 * d.h;
    if (this.mount) top += SADDLE_HIP[this.mount.kind] - d.hipY;
    return top * this.root.scale.y;
  }

  /** true once a GLB body replaced the procedural one (see models/glb.ts) */
  get usesGlb(): boolean {
    return this.glbObject !== null;
  }

  get currentWeapon(): string | null {
    return this.weaponId;
  }

  get holdStyle(): HoldStyle {
    return this.hold;
  }

  /** World-space muzzle position of the (right) weapon; false when no weapon is shown. */
  muzzleWorld(out: THREE.Vector3): boolean {
    if (!this.info || !this.weaponShown) return false;
    const bone = this.rigBones.bones[B.weapon];
    bone.updateWorldMatrix(true, false);
    out.copy(this.info.muzzle).applyMatrix4(bone.matrixWorld);
    return true;
  }

  /** Equip a weapon model by id (null = unarmed). Cheap when unchanged. */
  setWeapon(id: string | null | undefined): void {
    const wid = id ?? null;
    if (wid === this.weaponId) return;
    this.weaponId = wid;
    this.hold = 'none';
    this.akimbo = false;
    this.info = null;
    for (const w of this.glbWeapons) w.mesh.removeFromParent();
    this.glbWeapons = [];
    if (!wid) {
      this.mesh.geometry = this.bodyGeo;
      return;
    }
    const w = buildWeapon(wid);
    this.info = w.info;
    this.akimbo = isAkimbo(wid);
    this.hold = this.akimbo ? 'akimbo' : w.info.hold;
    if (this.hold === 'rifle' && w.info.length < 0.45) this.hold = 'pistol';
    const key = `${this.key}|${wid}`;
    let merged = mergedCache.get(key);
    if (!merged) {
      // bind transform of a bone = inverse of its bone inverse (rest pose, root space)
      const inv = this.mesh.skeleton.boneInverses;
      const parts: MergePart[] = [{ geo: w.mesh.geometry, bone: B.weapon, bind: inv[B.weapon].clone().invert() }];
      if (this.akimbo) parts.push({ geo: w.mesh.geometry, bone: B.weaponL, bind: inv[B.weaponL].clone().invert() });
      merged = mergeWeapon(this.bodyGeo, parts);
      mergedCache.set(key, merged);
    }
    this.mesh.geometry = merged;
    if (this.glbObject) this.attachGlbWeapons();
  }

  /** Ride a mount (null = on foot). Cheap (no allocation) when unchanged. */
  setMount(kind: MountKind | null, coat = '#6b4a2e', cloth = '#8a2a22', trim = '#d8ac4c'): void {
    const k = this.mountKey;
    if (kind === k.kind && (!kind || (coat === k.coat && cloth === k.cloth && trim === k.trim))) return;
    k.kind = kind;
    k.coat = coat;
    k.cloth = cloth;
    k.trim = trim;
    if (this.mount) {
      this.mount.object.removeFromParent();
      this.mount.dispose();
      this.mount = null;
    }
    if (kind) {
      this.mount = new MountRig(kind, coat, cloth, trim);
      this.mount.mesh.castShadow = this.castShadows && !this.stealthed;
      this.root.add(this.mount.object);
      this.applyOpacity();
    }
  }

  /** Swap the procedural body for a GLB if one exists for this hero (async, resolved once per id, silent on failure). */
  tryGlbOverride(heroId: string): void {
    void loadHeroGlb(heroId).then((glb) => {
      if (!glb || this.disposed) return;
      glb.scene.scale.setScalar(glb.scale);
      this.glbObject = glb.scene;
      this.root.add(glb.scene);
      this.mesh.visible = false;
      this.attachGlbWeapons();
      if (glb.animations.length) {
        this.glbMixer = new THREE.AnimationMixer(glb.scene);
        const clip =
          glb.animations.find((a) => /idle/i.test(a.name)) ?? glb.animations.find((a) => /walk|run/i.test(a.name)) ?? glb.animations[0];
        this.glbMixer.clipAction(clip).play();
      }
    });
  }

  /** With a GLB body the merged weapon hides with the procedural mesh: show separate weapon meshes on the (invisible) rig. */
  private attachGlbWeapons(): void {
    for (const w of this.glbWeapons) w.mesh.removeFromParent();
    this.glbWeapons = [];
    if (!this.weaponId) return;
    const w = buildWeapon(this.weaponId);
    this.rigBones.bones[B.weapon].add(w.mesh);
    this.glbWeapons.push(w);
    if (this.akimbo) {
      const w2 = buildWeapon(this.weaponId);
      this.rigBones.bones[B.weaponL].add(w2.mesh);
      this.glbWeapons.push(w2);
    }
  }

  /** Translucent shimmer (stealth seen by yourself / your squad). */
  setStealth(on: boolean): void {
    if (on === this.stealthed) return;
    this.stealthed = on;
    this.applyOpacity();
    this.setShadows(this.castShadows);
  }

  /** Through-wall silhouette (VF_EXPOSED / reveal): drawn only where the character is occluded. */
  setXray(on: boolean): void {
    if (!on) {
      if (this.xray) this.xray.visible = false;
      return;
    }
    if (!this.xray) {
      this.xray = new THREE.SkinnedMesh(this.mesh.geometry, xrayMaterial());
      this.xray.bind(this.mesh.skeleton, this.mesh.bindMatrix);
      this.xray.boundingSphere = this.mesh.boundingSphere;
      this.xray.renderOrder = 40;
      this.xray.castShadow = false;
      this.xray.name = 'xray';
      this.root.add(this.xray);
    }
    this.xray.geometry = this.mesh.geometry;
    this.xray.visible = true;
  }

  /**
   * Local over-the-shoulder view: tall head / back ornaments (吕布's pheasant
   * feathers, 靠旗 back flags) are shortened so they do not arc across the
   * crosshair or fill the top of the screen.
   */
  setLocalView(on: boolean): void {
    if (on === this.localView) return;
    this.localView = on;
    this.rigBones.bones[B.plume].scale.setScalar(on ? 0.3 : 1);
    this.rigBones.bones[B.backOrn].scale.setScalar(on ? 0.45 : 1);
  }

  /** Fade the whole character (1 = opaque); used when the TPS camera is pushed into the local hero. */
  setFade(alpha: number): void {
    const a = Math.max(0.05, Math.min(1, alpha));
    if (Math.abs(a - this.fade) < 0.01) return;
    this.fade = a;
    this.applyOpacity();
  }

  private applyOpacity(): void {
    const opacity = Math.min(this.stealthed ? 0.32 : 1, this.fade);
    const transparent = opacity < 0.999;
    const mats = [this.material, this.mount?.material].filter((m): m is THREE.MeshStandardMaterial => !!m);
    for (const m of mats) {
      if (m.transparent !== transparent) {
        m.transparent = transparent;
        m.depthWrite = !transparent;
        m.needsUpdate = true;
      }
      m.opacity = opacity;
    }
  }

  get isStealthed(): boolean {
    return this.stealthed;
  }

  setShadows(cast: boolean): void {
    this.castShadows = cast;
    const c = cast && !this.stealthed;
    this.mesh.castShadow = c;
    if (this.mount) this.mount.mesh.castShadow = c;
  }

  /** Advance animation and pose the bones. */
  update(dt: number, time: number, u: RigUpdate): void {
    let mountBob = 0;
    if (this.mount) mountBob = this.mount.update(dt, u.speed, time);
    const inp = this.animIn;
    inp.dt = dt;
    inp.time = time;
    inp.speed = u.speed;
    inp.moveX = u.moveX;
    inp.moveZ = u.moveZ;
    inp.pitch = u.pitch;
    inp.flags = u.flags;
    inp.hold = this.hold;
    inp.mountHip = this.mount ? SADDLE_HIP[this.mount.kind] : 0;
    inp.mountBob = mountBob;
    inp.leftHandBusy = this.leftHandBusy;
    inp.akimbo = this.akimbo;
    this.animator.update(inp);
    const info = this.info;
    this.animator.apply(this.rigBones, { fore: info?.fore ?? null, mag: info?.mag ?? null });
    // hide the merged weapon by collapsing its bone (downed / dead / dancing)
    this.weaponShown = !!info && this.animator.weaponVisible;
    const s = this.weaponShown ? 1 : 1e-4;
    this.rigBones.bones[B.weapon].scale.setScalar(s);
    this.rigBones.bones[B.weaponL].scale.setScalar(this.akimbo ? s : 1e-4);
    for (const w of this.glbWeapons) w.mesh.visible = this.weaponShown;
    if (this.glbMixer) this.glbMixer.update(dt);
    if (this.glbObject) {
      // keep GLB bodies roughly in sync with the procedural root motion
      const r = this.rigBones.bones[B.root];
      this.glbObject.position.copy(r.position);
      this.glbObject.quaternion.copy(r.quaternion);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    // geometries are shared through caches; only per-instance resources are freed
    this.material.dispose();
    this.mesh.skeleton.dispose();
    this.mount?.dispose();
    this.glbMixer?.stopAllAction();
  }
}
