// CharacterRig: one character = ONE skinned mesh + optional mount.
//   - GLB body (models/glbBody.ts, when the AI art is shipped and loaded): the
//     textured mocap-animated model with the procedural weapon in its hand;
//   - procedural body (the fallback: single-file build, no assets, load
//     failure, still loading): body + held weapon(s) merged, the weapon skinned
//     to the weapon bone, driven by the CharacterAnimator.
// One draw call (+ its shadow) per character either way (+ the weapon mesh for
// GLB bodies). Used by the in-game entity views, the portrait renderer and the
// turntable. A GLB body requested with useGlb() swaps in as soon as its model
// and the shared clips are loaded (immediately when they already are).
import * as THREE from 'three';
import { characterMaterial } from '../core/materials';
import { CharacterAnimator, type AnimInput, type RigBones } from '../anim/animator';
import type { GlbFrameInput } from '../anim/glbAnimator';
import { clipsReady, loadAllClips } from '../anim/glbClips';
import { WEAPON_BY_ID } from '../../data';
import { buildCharacter, specKey, type CharacterSpec } from './humanoid';
import { B, localRest, type BodyDims } from './rig';
import { buildWeapon, isAkimbo, weaponSpecOf, type HoldStyle, type WeaponModelInfo } from './weapons';
import { MountRig, SADDLE_HIP, type MountKind } from './mounts';
import { GLB_HERO_HEIGHT, charTemplateSync, heroModelPath, loadCharTemplate } from './glb';
import { GlbBody } from './glbBody';

export interface RigUpdate {
  speed: number;
  moveX: number;
  moveZ: number;
  pitch: number;
  flags: number;
  /** showcase idle (hero select / portraits): weapon held at low ready unless aiming (VF_ADS) */
  lowReady?: boolean;
}

const mergedCache = new Map<string, THREE.BufferGeometry>();

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
  /** the procedural body's material */
  readonly procMaterial: THREE.MeshStandardMaterial;
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
  private glb: GlbBody | null = null;
  /** requested GLB model path (null = procedural) and the height to normalise it to */
  private glbWant: string | null = null;
  private glbHeight = GLB_HERO_HEIGHT;
  private meleeStyle: 'heavy' | 'thrust' = 'thrust';
  private reloadTime = 2;
  private disposed = false;
  private stealthed = false;
  private castShadows = true;
  /** the held weapon's own shadow (a separate draw on GLB bodies; merged into the procedural body) */
  private weaponShadows = true;
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
  /** reused GLB animator input */
  private readonly glbIn: GlbFrameInput = {
    dt: 0,
    speed: 0,
    moveX: 0,
    moveZ: 0,
    pitch: 0,
    flags: 0,
    hold: 'none',
    mounted: false,
    meleeStyle: 'thrust',
    mountHip: 0,
    mountBob: 0,
    reloadTime: 2,
    lowReady: false,
  };

  constructor(spec: CharacterSpec) {
    this.spec = spec;
    this.key = specKey(spec);
    const built = buildCharacter(spec);
    this.bodyGeo = built.geometry;
    this.dims = built.dims;
    this.leftHandBusy = built.leftHandBusy;
    this.procMaterial = characterMaterial();
    this.mesh = new THREE.SkinnedMesh(built.geometry, this.procMaterial);
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
    const g = this.glb;
    if (g) {
      let top = g.headTop();
      if (this.mount) top += SADDLE_HIP[this.mount.kind] - g.template.landmarks.hipsY * g.scale;
      return top * this.root.scale.y;
    }
    const d = this.dims;
    let top = d.headCY + 0.19 * d.h;
    if (this.mount) top += SADDLE_HIP[this.mount.kind] - d.hipY;
    return top * this.root.scale.y;
  }

  /** Standing height of the procedural body (m, before the root scale): what a GLB body is normalised to. */
  standHeight(): number {
    const d = this.dims;
    return d.headCY + 0.19 * d.h;
  }

  /** true once a GLB body replaced the procedural one (see models/glbBody.ts) */
  get usesGlb(): boolean {
    return this.glb !== null;
  }

  /** The GLB body, when one is in use. */
  get glbBody(): GlbBody | null {
    return this.glb;
  }

  /** The material of the body currently shown (tints / hit flash go here). */
  get material(): THREE.MeshStandardMaterial {
    return this.glb ? this.glb.material : this.procMaterial;
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
    if (this.glb) return this.glb.muzzleWorld(out);
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
    if (!wid) {
      this.mesh.geometry = this.bodyGeo;
      this.glb?.setWeapon(null, 'none', false);
      return;
    }
    const w = buildWeapon(wid);
    this.info = w.info;
    this.akimbo = isAkimbo(wid);
    this.hold = this.akimbo ? 'akimbo' : w.info.hold;
    if (this.hold === 'rifle' && w.info.length < 0.45) this.hold = 'pistol';
    const style = weaponSpecOf(wid).spec.style;
    this.meleeStyle = style === 'spear' || (this.hold !== 'pole' && this.hold !== 'sword') ? 'thrust' : 'heavy';
    this.reloadTime = WEAPON_BY_ID[wid]?.reloadTime ?? 2;
    this.glb?.setWeapon(wid, this.hold, this.akimbo);
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

  /** Swap the procedural body for this hero's GLB when the deploy ships one (see useGlb). */
  tryGlbOverride(heroId: string): void {
    this.useGlb(heroModelPath(heroId), GLB_HERO_HEIGHT);
  }

  /**
   * Use a GLB body (asset path, see models/glb.ts) normalised to `height` m
   * (before the root scale); null = procedural. Swaps in right away when the
   * model and the shared clips are already loaded, else as soon as they are;
   * silently stays procedural when they are absent or broken.
   */
  useGlb(path: string | null, height = GLB_HERO_HEIGHT): void {
    if (path === this.glbWant && height === this.glbHeight) return;
    this.glbWant = path;
    this.glbHeight = height;
    this.dropGlb();
    if (!path || this.buildGlb()) return;
    void Promise.all([loadCharTemplate(path), loadAllClips()]).then(() => {
      if (!this.disposed && this.glbWant === path && !this.glb) this.buildGlb();
    });
  }

  private buildGlb(): boolean {
    const path = this.glbWant;
    if (!path || this.disposed) return false;
    const tpl = charTemplateSync(path);
    if (!tpl || !clipsReady()) return false;
    try {
      this.glb = new GlbBody(tpl, this.glbHeight);
    } catch (err) {
      console.warn('[render] GLB body failed, keeping the procedural one', err);
      this.glbWant = null;
      return false;
    }
    this.root.add(this.glb.group);
    this.mesh.visible = false;
    if (this.xray) this.xray.visible = false;
    this.glb.setWeapon(this.weaponId, this.hold, this.akimbo);
    this.glb.setShadows(this.castShadows && !this.stealthed, this.weaponShadows && this.castShadows && !this.stealthed);
    this.applyOpacity();
    return true;
  }

  private dropGlb(): void {
    if (!this.glb) return;
    this.glb.dispose();
    this.glb = null;
    this.mesh.visible = true;
  }

  /** Far LOD of a GLB body (fewer triangles, same animation); ignored for procedural bodies. */
  setLod(far: boolean): void {
    this.glb?.setLod(far);
  }

  // one-shot animation events (both animators: the GLB body may swap in mid-action)
  fire(strength = 1): void {
    this.animator.fire(strength);
    this.glb?.animator.fire(strength);
  }
  melee(): void {
    this.animator.melee();
    this.glb?.animator.melee(this.meleeStyle);
  }
  cast(): void {
    this.animator.cast();
    this.glb?.animator.cast();
  }
  hit(): void {
    this.animator.hit();
    this.glb?.animator.hit();
  }

  /** Translucent shimmer (stealth seen by yourself / your squad). */
  setStealth(on: boolean): void {
    if (on === this.stealthed) return;
    this.stealthed = on;
    this.applyOpacity();
    this.setShadows(this.castShadows, this.weaponShadows);
  }

  /** Through-wall silhouette (VF_EXPOSED / reveal): drawn only where the character is occluded. */
  setXray(on: boolean): void {
    if (this.glb) {
      this.glb.setXray(on);
      return;
    }
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
    this.glb?.setOpacity(opacity);
    const mats = [this.procMaterial, this.mount?.material].filter((m): m is THREE.MeshStandardMaterial => !!m);
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

  /** `weapon`: also the held weapon's shadow on a GLB body (skipped at range: a thin extra shadow draw per character). */
  setShadows(cast: boolean, weapon = cast): void {
    this.castShadows = cast;
    this.weaponShadows = weapon;
    const c = cast && !this.stealthed;
    this.mesh.castShadow = c;
    this.glb?.setShadows(c, c && weapon);
    if (this.mount) this.mount.mesh.castShadow = c;
  }

  /** Advance animation and pose the bones. */
  update(dt: number, time: number, u: RigUpdate): void {
    let mountBob = 0;
    if (this.mount) mountBob = this.mount.update(dt, u.speed, time);
    const g = this.glb;
    if (g) {
      const fi = this.glbIn;
      fi.dt = dt;
      fi.speed = u.speed;
      fi.moveX = u.moveX;
      fi.moveZ = u.moveZ;
      fi.pitch = u.pitch;
      fi.flags = u.flags;
      fi.hold = this.hold;
      fi.mounted = this.mount !== null;
      fi.meleeStyle = this.meleeStyle;
      fi.mountHip = this.mount ? SADDLE_HIP[this.mount.kind] : 0;
      fi.mountBob = mountBob;
      fi.reloadTime = this.reloadTime;
      fi.lowReady = u.lowReady === true;
      g.update(fi);
      this.weaponShown = !!this.info && g.animator.weaponVisible;
      return;
    }
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
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    // geometries are shared through caches; only per-instance resources are freed
    this.procMaterial.dispose();
    this.mesh.skeleton.dispose();
    this.mount?.dispose();
    this.dropGlb();
  }
}
