// One GLB character on screen: a SkeletonUtils clone of a CharTemplate
// (geometry / texture shared, per-instance material for tints and fades), its
// GlbAnimator, and the procedural weapon parented to the hand bone.
//
// Frames: the clone's Armature space faces +Z in model units (usually cm);
// `group` turns it to the game's −Z forward and scales it to the requested
// height. Weapon holders are children of the hand bones scaled back to metres,
// oriented from the reference aimed pose so the barrel lies along the line of
// the two hands (anim/glbAnimator then turns the torso until that barrel points
// at the camera aim).
import * as THREE from 'three';
import { GlbAnimator, type GlbFrameInput, type GlbWeaponAttach } from '../anim/glbAnimator';
import { clipSync } from '../anim/glbClips';
import { interpolantOf, trackBone, type PreparedClip } from '../anim/glbRetarget';
import { normalizeScale, releaseTemplate, retainTemplate, type CharTemplate } from './glb';
import { buildWeapon, weaponMaterial, type HoldStyle, type WeaponModel, type WeaponModelInfo } from './weapons';

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

/** How a weapon sits in the hand: the reference pose's hand frame → weapon frame. */
interface Grip {
  hand: 'RightHand' | 'LeftHand';
  /** weapon rotation in the hand bone's frame */
  q: THREE.Quaternion;
  /** weapon origin in the hand bone's frame (model units) */
  p: THREE.Vector3;
}

const chainTo = (joint: string): string[] => {
  const side = joint.startsWith('Left') ? 'Left' : 'Right';
  const arm = [`${side}Shoulder`, `${side}Arm`, `${side}ForeArm`, `${side}Hand`];
  return ['Hips', 'Spine02', 'Spine01', 'Spine', ...arm.slice(0, arm.indexOf(joint) + 1)];
};

/** Armature-space rotation + position of an arm joint in a clip's pose at time t (FK with the model's rest offsets). */
function poseOf(tpl: CharTemplate, clip: PreparedClip | null | undefined, t: number, joint: string, outQ: THREE.Quaternion, outP: THREE.Vector3): void {
  const tracks = new Map<string, THREE.Interpolant>();
  if (clip) for (const tr of clip.rot) tracks.set(trackBone(tr.name), interpolantOf(tr));
  outQ.identity();
  outP.set(0, 0, 0);
  const lq = new THREE.Quaternion();
  const off = new THREE.Vector3();
  for (const name of chainTo(joint)) {
    const r = tpl.rest.get(name);
    if (!r) continue;
    off.copy(r.p).applyQuaternion(outQ);
    outP.add(off);
    const it = tracks.get(name);
    lq.copy(r.q);
    if (it) lq.fromArray(it.evaluate(Math.min(t, clip?.duration ?? 0)) as unknown as number[]);
    outQ.multiply(lq);
  }
}

const grips = new WeakMap<CharTemplate, Map<string, Grip>>();

/**
 * Weapon-in-hand transform for a hold style, derived once per model from the
 * clip that holds it (aimed rifle / bow): barrel along the hands' line (bow:
 * along the extended bow arm), weapon up = world up, grip at the wrist.
 */
function gripFor(tpl: CharTemplate, hold: HoldStyle, left: boolean): Grip {
  const bow = hold === 'bow';
  // every non-bow hold shares the aimed-rifle grip
  const key = `${bow ? 'bow' : 'gun'}${left ? 'L' : 'R'}`;
  let m = grips.get(tpl);
  if (!m) {
    m = new Map();
    grips.set(tpl, m);
  }
  const hit = m.get(key);
  if (hit) return hit;
  const hand: 'RightHand' | 'LeftHand' = bow || left ? 'LeftHand' : 'RightHand';
  const clip = bow ? (clipSync('bow') ?? clipSync('aim')) : clipSync('aim');
  const qR = new THREE.Quaternion();
  const pR = new THREE.Vector3();
  const qL = new THREE.Quaternion();
  const pL = new THREE.Vector3();
  poseOf(tpl, clip, 0, 'RightHand', qR, pR);
  poseOf(tpl, clip, 0, 'LeftHand', qL, pL);
  const dir = new THREE.Vector3();
  // bow: along the extended bow arm (shoulder → hand); guns: along the line of the two hands
  if (bow) {
    const qs = new THREE.Quaternion();
    const shoulder = new THREE.Vector3();
    poseOf(tpl, clip, 0, 'LeftArm', qs, shoulder);
    dir.copy(pL).sub(shoulder).normalize();
  } else dir.copy(pL).sub(pR).normalize();
  if (!(dir.lengthSq() > 0.5)) dir.set(0, 0, 1);
  // weapon axes in armature space: −Z = barrel, +Y = up
  const z = dir.clone().negate();
  const up = new THREE.Vector3(0, 1, 0);
  const y = up.addScaledVector(z, -up.dot(z)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  const qW = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  const qHand = hand === 'RightHand' ? qR : qL;
  const g: Grip = { hand, q: qHand.clone().invert().multiply(qW), p: new THREE.Vector3() };
  m.set(key, g);
  return g;
}

export class GlbBody {
  /** add to the rig root; faces −Z, feet at 0 */
  readonly group = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly material: THREE.MeshStandardMaterial;
  readonly animator: GlbAnimator;
  readonly template: CharTemplate;
  /** normalisation scale (template units → requested height) */
  readonly scale: number;
  /** metres (rig-root frame) per model unit */
  readonly unitM: number;
  private readonly bones: Partial<Record<string, THREE.Bone>> = {};
  private readonly holders: [THREE.Group, THREE.Group];
  private weapons: [WeaponModel | null, WeaponModel | null] = [null, null];
  private info: WeaponModelInfo | null = null;
  private attach: GlbWeaponAttach | null = null;
  private xray: THREE.SkinnedMesh | null = null;
  private readonly height: number;
  /** per-instance weapon material, only while the body is translucent (stealth / camera fade) */
  private weaponFade: THREE.MeshStandardMaterial | null = null;
  private opacity = 1;

  constructor(tpl: CharTemplate, height: number) {
    this.template = tpl;
    this.height = height;
    retainTemplate(tpl);
    const scene = tpl.cloneScene(tpl.scene);
    let mesh: THREE.SkinnedMesh | null = null;
    scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh;
    });
    this.mesh = mesh as unknown as THREE.SkinnedMesh;
    for (const b of this.mesh.skeleton.bones) this.bones[b.name] = b;
    this.material = tpl.material.clone();
    this.mesh.material = this.material;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    // generous fixed bounds (model units): posed limbs, rolls and falls never get culled
    const u = tpl.unit || 0.01;
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9 / u, 0), 2.1 / u);
    this.mesh.name = 'glbBody';
    this.scale = normalizeScale(tpl.landmarks, height);
    this.unitM = u * this.scale;
    this.group.rotation.y = Math.PI;
    this.group.scale.setScalar(this.scale);
    this.group.add(scene);
    this.group.name = 'glb';
    this.animator = new GlbAnimator(tpl, scene, this.bones, this.unitM);
    const mk = (hand: string): THREE.Group => {
      const g = new THREE.Group();
      g.name = `weapon_${hand}`;
      g.scale.setScalar(1 / this.unitM);
      this.bones[hand]?.add(g);
      return g;
    };
    this.holders = [mk('RightHand'), mk('LeftHand')];
  }

  private far = false;

  /** Far LOD (simplified index buffer, same skinning); no-op when the model has none. */
  setLod(far: boolean): void {
    if (far === this.far) return;
    this.far = far;
    const lod = this.template.lod;
    const geo = far && lod ? lod : this.template.mesh.geometry;
    this.mesh.geometry = geo;
    if (this.xray) this.xray.geometry = geo;
  }

  /** Top of the head above the feet (m, rig-root frame, standing). */
  headTop(): number {
    const lm = this.template.landmarks;
    return Math.min(this.height * 1.08, Math.max(this.height * 0.92, lm.headTopY * this.scale));
  }

  /** Equip (null = unarmed). `hold` / `akimbo` as resolved by the rig. */
  setWeapon(id: string | null, hold: HoldStyle, akimbo: boolean): void {
    for (const w of this.weapons) w?.mesh.removeFromParent();
    this.weapons = [null, null];
    this.info = null;
    this.attach = null;
    if (!id || hold === 'none') return;
    const main = buildWeapon(id);
    this.info = main.info;
    const g = gripFor(this.template, hold, false);
    const holder = g.hand === 'RightHand' ? this.holders[0] : this.holders[1];
    holder.position.copy(g.p);
    holder.quaternion.copy(g.q);
    holder.add(main.mesh);
    this.weapons[0] = main;
    const dirInHand = new THREE.Vector3(0, 0, -1).applyQuaternion(g.q);
    let foreInHand: THREE.Vector3 | null = null;
    if (main.info.fore && hold !== 'bow') foreInHand = main.info.fore.clone().divideScalar(this.unitM).applyQuaternion(g.q).add(g.p);
    this.attach = { hand: g.hand, dirInHand, foreInHand };
    if (akimbo) {
      const gl = gripFor(this.template, hold, true);
      const second = buildWeapon(id);
      this.holders[1].position.copy(gl.p);
      this.holders[1].quaternion.copy(gl.q);
      this.holders[1].add(second.mesh);
      this.weapons[1] = second;
    }
    this.applyWeaponOpacity();
  }

  get weaponInfo(): WeaponModelInfo | null {
    return this.info;
  }

  update(fi: GlbFrameInput): void {
    this.animator.update(fi, this.attach);
    const show = this.animator.weaponVisible;
    for (const w of this.weapons) if (w) w.mesh.visible = show;
  }

  /** World-space muzzle of the main weapon; false when none is shown. */
  muzzleWorld(out: THREE.Vector3): boolean {
    const w = this.weapons[0];
    if (!w || !w.mesh.visible || !this.info) return false;
    w.mesh.updateWorldMatrix(true, false);
    out.copy(this.info.muzzle).applyMatrix4(w.mesh.matrixWorld);
    return true;
  }

  /** World position of a bone (e.g. 'Head'); false when absent. */
  boneWorld(name: string, out: THREE.Vector3): boolean {
    const b = this.bones[name];
    if (!b) return false;
    b.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(b.matrixWorld);
    return true;
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    const m = this.material;
    const transparent = opacity < 0.999;
    if (m.transparent !== transparent) {
      m.transparent = transparent;
      m.depthWrite = !transparent;
      m.needsUpdate = true;
    }
    m.opacity = opacity;
    this.applyWeaponOpacity();
  }

  /** The held weapon fades with the body (a stealthed hero must not leave a floating gun). */
  private applyWeaponOpacity(): void {
    const faded = this.opacity < 0.999;
    if (faded && !this.weaponFade) {
      this.weaponFade = weaponMaterial().clone();
      this.weaponFade.transparent = true;
      this.weaponFade.depthWrite = false;
    }
    if (this.weaponFade) this.weaponFade.opacity = this.opacity;
    const mat = faded && this.weaponFade ? this.weaponFade : weaponMaterial();
    for (const w of this.weapons) if (w && w.mesh.material !== mat) w.mesh.material = mat;
  }

  setShadows(cast: boolean): void {
    this.mesh.castShadow = cast;
    for (const w of this.weapons) if (w) w.mesh.castShadow = cast;
  }

  setXray(on: boolean): void {
    if (!on) {
      if (this.xray) this.xray.visible = false;
      return;
    }
    if (!this.xray) {
      const x = new THREE.SkinnedMesh(this.mesh.geometry, xrayMaterial());
      x.bind(this.mesh.skeleton, this.mesh.bindMatrix);
      x.boundingSphere = this.mesh.boundingSphere;
      x.position.copy(this.mesh.position);
      x.quaternion.copy(this.mesh.quaternion);
      x.scale.copy(this.mesh.scale);
      x.renderOrder = 40;
      x.castShadow = false;
      x.name = 'xray';
      this.mesh.parent?.add(x);
      this.xray = x;
    }
    this.xray.visible = true;
  }

  dispose(): void {
    releaseTemplate(this.template);
    this.group.removeFromParent();
    this.animator.dispose();
    // geometry / texture / base material are the template's (shared); only the instance's own resources go
    this.material.dispose();
    this.weaponFade?.dispose();
    this.mesh.skeleton.dispose();
    this.xray?.removeFromParent();
    for (const w of this.weapons) w?.mesh.removeFromParent();
  }
}
