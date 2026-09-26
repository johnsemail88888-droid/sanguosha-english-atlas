// A character model without the auto-rig (models/glb.ts RigidTemplate: a
// mod's static statue, a registered test box) shown in place of the procedural
// body: one rigid clone normalised to the requested height, feet on the ground,
// turned to the game's −Z forward (glTF models face +Z), riding the procedural
// rig's root bone — so it still rolls, falls when killed and sits on a mount —
// with the held weapon riding the rig's weapon bones (the procedural animator
// keeps aiming, reloading and hiding it). The procedural body itself is hidden
// (its bones still pose every frame).
import * as THREE from 'three';
import { releaseRigid, retainRigid, type RigidTemplate } from './glb';
import { B } from './rig';
import { buildWeapon, cloneKeepingDefines, heldMaterialOf, type WeaponModel } from './weapons';

const _m = new THREE.Matrix4();

export class RigidBody {
  /** child of the rig root: follows the procedural root bone every frame */
  readonly follower = new THREE.Group();
  /** the normalised model (scale = height / file height); children[0] = the clone, feet at 0 */
  readonly object = new THREE.Group();
  readonly template: RigidTemplate;
  readonly height: number;
  /** per-instance material clones, made on the first fade */
  private faded: Map<THREE.Material, THREE.Material> | null = null;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly weaponHolders: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private weapons: WeaponModel[] = [];
  private weaponFade: THREE.MeshStandardMaterial | null = null;
  private opacity = 1;

  constructor(tpl: RigidTemplate, height: number) {
    this.template = tpl;
    this.height = height;
    retainRigid(tpl);
    const clone = tpl.scene.clone(true);
    clone.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) this.meshes.push(o as THREE.Mesh);
    });
    this.object.add(clone);
    this.object.scale.setScalar(height / tpl.height);
    this.object.rotation.y = Math.PI;
    this.object.name = 'glbRigid';
    this.follower.add(this.object);
    this.follower.matrixAutoUpdate = false;
    this.follower.name = 'glbRigidFollower';
    for (const h of this.weaponHolders) {
      h.matrixAutoUpdate = false;
      h.name = 'glbRigidWeapon';
    }
  }

  /** Add to the rig root (next to the hidden procedural body). */
  attach(root: THREE.Object3D): void {
    root.add(this.follower, ...this.weaponHolders);
  }

  /** Show `id` in the weapon bones' places (null = unarmed); `akimbo` adds a mirrored copy on the left one. */
  setWeapon(id: string | null, akimbo: boolean): WeaponModel | null {
    for (const w of this.weapons) w.mesh.removeFromParent();
    this.weapons = [];
    if (!id) return null;
    // held like a GLB body holds it: the character fog clamp
    const main = buildWeapon(id);
    main.mesh.material = heldMaterialOf(main);
    this.weaponHolders[0].add(main.mesh);
    this.weapons.push(main);
    if (akimbo) {
      const second = buildWeapon(id);
      second.mesh.material = heldMaterialOf(second);
      second.mesh.scale.x = -1;
      this.weaponHolders[1].add(second.mesh);
      this.weapons.push(second);
    }
    this.applyOpacity();
    return main;
  }

  /**
   * After the procedural animator posed the bones: follow the root bone
   * (rest pose = identity) and put the weapons where the weapon bones are.
   */
  sync(skeleton: THREE.Skeleton): void {
    const bones = skeleton.bones;
    this.follower.matrix.multiplyMatrices(meshSpace(bones[B.root], _m), skeleton.boneInverses[B.root]);
    this.follower.matrixWorldNeedsUpdate = true;
    meshSpace(bones[B.weapon], this.weaponHolders[0].matrix);
    meshSpace(bones[B.weaponL], this.weaponHolders[1].matrix);
    for (const h of this.weaponHolders) h.matrixWorldNeedsUpdate = true;
  }

  /** World-space muzzle of the main weapon (false when unarmed). */
  muzzleWorld(out: THREE.Vector3): boolean {
    const w = this.weapons[0];
    if (!w) return false;
    w.mesh.updateWorldMatrix(true, false);
    out.copy(w.info.muzzle).applyMatrix4(w.mesh.matrixWorld);
    return true;
  }

  get weaponInfo(): WeaponModel['info'] | null {
    return this.weapons[0]?.info ?? null;
  }

  setShadows(cast: boolean, weapon = cast): void {
    for (const m of this.meshes) m.castShadow = cast;
    for (const w of this.weapons) w.mesh.castShadow = weapon;
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    this.applyOpacity();
  }

  private applyOpacity(): void {
    const faded = this.opacity < 0.999;
    if (faded && !this.faded) {
      this.faded = new Map();
      for (const m of this.meshes) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mt of mats) if (!this.faded.has(mt)) this.faded.set(mt, cloneKeepingDefines(mt as THREE.MeshStandardMaterial));
      }
    }
    if (this.faded) {
      for (const [src, c] of this.faded) {
        c.transparent = faded || src.transparent;
        c.depthWrite = !faded && src.depthWrite;
        c.opacity = faded ? this.opacity * src.opacity : src.opacity;
        c.needsUpdate = true;
      }
      for (const m of this.meshes) {
        if (Array.isArray(m.material)) m.material = m.material.map((mt) => this.faded?.get(mt) ?? mt);
        else m.material = this.faded.get(m.material) ?? m.material;
      }
    }
    for (const w of this.weapons) {
      const base = w.mesh.userData.baseMaterial ?? (w.mesh.userData.baseMaterial = w.mesh.material);
      if (!faded) {
        w.mesh.material = base;
        continue;
      }
      if (!this.weaponFade || this.weaponFade.userData.src !== base) {
        this.weaponFade?.dispose();
        this.weaponFade = cloneKeepingDefines(base as THREE.MeshStandardMaterial);
        this.weaponFade.userData.src = base;
        this.weaponFade.transparent = true;
        this.weaponFade.depthWrite = false;
      }
      this.weaponFade.opacity = this.opacity;
      w.mesh.material = this.weaponFade;
    }
  }

  dispose(): void {
    releaseRigid(this.template);
    this.follower.removeFromParent();
    for (const h of this.weaponHolders) h.removeFromParent();
    for (const w of this.weapons) w.mesh.removeFromParent();
    // geometry / textures / base materials are the template's (shared)
    if (this.faded) for (const c of this.faded.values()) c.dispose();
    this.weaponFade?.dispose();
  }
}

/** A bone's transform in the skinned mesh's frame (the rig root's: the procedural mesh sits at identity). */
function meshSpace(bone: THREE.Object3D, out: THREE.Matrix4): THREE.Matrix4 {
  bone.updateMatrix();
  out.copy(bone.matrix);
  let p = bone.parent;
  while (p && (p as THREE.Bone).isBone) {
    p.updateMatrix();
    out.premultiply(p.matrix);
    p = p.parent;
  }
  return out;
}
