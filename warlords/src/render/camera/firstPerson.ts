// First-person view (render side). The pose is the simulation's own
// first-person rig (sim/aim.ts firstPersonRig): the camera IS the hero's eye and
// the crosshair ray is the camera's centre ray — no shoulder offset. With
// BTN_FIRST_PERSON in the input the host rebuilds the same ray and starts the
// hero's shots at the eye, so hits land exactly where the crosshair points,
// however close. The local body is hidden from this camera only (its shadow
// stays; other players still see it); the weapon is the viewmodel
// (./viewmodel.ts). Default: first person with mouse + keyboard, third person on
// touch controls (setting cameraView; the toggle key flips it).
import * as THREE from 'three';
import type { Vec3 } from '../../core/math';
import type { PrivateHeroView, ViewEntity } from '../../core/types';
import { VF_ADS, VF_AIRBORNE, VF_CHANNELING, VF_DANCING, VF_DEAD, VF_DOWNED, VF_MOUNTED, VF_RELOADING, VF_SPRINTING, VF_STUNNED } from '../../core/types';
import { HERO_BY_ID, WEAPON_BY_ID } from '../../data';
import { firstPersonRig, fpEyeHeight } from '../../sim/aim';
import type { CameraPose } from './tpsCamera';
import { ViewModel } from './viewmodel';

export { CAMERA_TOGGLE_KEY, CAMERA_TOGGLE_LABEL, resolveCameraView, toggledCameraView } from './viewMode';
export type { CameraView, CameraViewSetting } from './viewMode';

type RideLike = Pick<ViewEntity, 'kind' | 'sub' | 'flags'>;

/** The hero sits on a mount (a mount item, or 马超 / 吕布's own horse) — sim/combat.ts ridesForHits. */
export function viewRides(e: RideLike): boolean {
  if (e.kind !== 'hero' || e.flags & (VF_DOWNED | VF_DEAD)) return false;
  if (e.flags & VF_MOUNTED) return true;
  return HERO_BY_ID[e.sub]?.visual.mount !== undefined;
}

/** First-person eye height of a hero entity (the sim's fpEyeHeight for its state). */
export function fpEyeOf(e: RideLike): number {
  return fpEyeHeight((e.flags & VF_DOWNED) !== 0, viewRides(e));
}

/** Eye height while kneeling beside a downed ally to revive him (render only: you cannot shoot meanwhile). */
export const FP_KNEEL_EYE = 1.0;

/** The first-person camera pose (== the host's crosshair ray) for a hero at `pos` looking (yaw, pitch). */
export function firstPersonPose(pos: Vec3, yaw: number, pitch: number, eyeHeight: number): CameraPose {
  const r = firstPersonRig(pos, yaw, pitch, eyeHeight);
  return { origin: r.origin, dir: r.dir, nearClip: 0 };
}

// ── own body: hidden from the first-person camera, shadow kept ──────────────

interface HideState {
  on: boolean;
  camera: THREE.Camera | null;
  saved: { color: boolean; depth: boolean }[];
}

/**
 * Hides meshes from one camera's colour / depth pass while they keep casting
 * their shadow: three draws the shadow map with its own depth materials, so
 * switching the mesh's material to no colour / no depth writes for exactly its
 * main-pass draw (onBeforeRender → onAfterRender, restored at once: shared
 * weapon materials stay untouched for everyone else) removes it from the
 * picture only. Meshes added later (a GLB body swapping in, another weapon)
 * are picked up by the next apply().
 */
export class ShadowOnlyBody {
  private readonly state: HideState = { on: false, camera: null, saved: [] };
  private readonly hooked = new WeakSet<THREE.Object3D>();
  private root: THREE.Object3D | null = null;

  /** Hide `root`'s meshes (all but those under `keep`, e.g. the mount) from `camera`; null root = show again. */
  apply(root: THREE.Object3D | null, camera: THREE.Camera, keep: THREE.Object3D | null = null): void {
    this.state.camera = camera;
    this.state.on = root !== null;
    if (root !== this.root) this.root = root;
    if (!root) return;
    const st = this.state;
    const visit = (o: THREE.Object3D): void => {
      if (o === keep) return;
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !this.hooked.has(mesh)) {
        this.hooked.add(mesh);
        const before = mesh.onBeforeRender;
        const after = mesh.onAfterRender;
        const owner = this;
        mesh.onBeforeRender = function (r, s, c, g, m, grp) {
          before.call(this, r, s, c, g, m, grp);
          if (!st.on || c !== st.camera || owner.root === null || !isUnder(this, owner.root)) return;
          st.saved.push({ color: m.colorWrite, depth: m.depthWrite });
          m.colorWrite = false;
          m.depthWrite = false;
        };
        mesh.onAfterRender = function (r, s, c, g, m, grp) {
          if (st.on && c === st.camera && owner.root !== null && isUnder(this, owner.root)) {
            const v = st.saved.pop();
            if (v) {
              m.colorWrite = v.color;
              m.depthWrite = v.depth;
            }
          }
          after.call(this, r, s, c, g, m, grp);
        };
      }
      for (const ch of o.children) visit(ch);
    };
    visit(root);
  }

  get active(): boolean {
    return this.state.on;
  }
}

function isUnder(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === root) return true;
  return false;
}

// ── orchestration (called by the renderer every frame) ──────────────────────

/** What the renderer knows about the local look this frame. */
export interface FpLook {
  yaw: number;
  pitch: number;
  ads: boolean;
  /** eased aim progress (game/aimFeel.ts): the weapon comes up at the class's own pace */
  adsBlend?: number;
}

/** The local character view's parts the first-person view needs (entities/characterView.ts). */
export interface FpCharacter {
  rig: { root: THREE.Object3D; mount: { object: THREE.Object3D } | null };
}

const _qv = new THREE.Quaternion();

export class FirstPersonView {
  readonly viewmodel = new ViewModel();
  private readonly body = new ShadowOnlyBody();
  private eye = -1;
  /** the first-person camera is on this frame */
  active = false;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /**
   * Eye height to put the camera at (eased when it changes: mounting, going down, getting up,
   * `kneel`ing beside a downed ally you revive — so he is in view, not under the item bar).
   */
  eyeHeight(e: RideLike, dt: number, kneel = false): number {
    const want = kneel ? Math.min(fpEyeOf(e), FP_KNEEL_EYE) : fpEyeOf(e);
    if (this.eye < 0 || dt <= 0) this.eye = want;
    else this.eye += (want - this.eye) * (1 - Math.exp(-dt * 9));
    if (Math.abs(this.eye - want) < 1e-3) this.eye = want;
    return this.eye;
  }

  /**
   * After the entities are synced: hide / show the local body and pose the
   * viewmodel. `scoped`: a scope overlay fills the screen (the weapon is hidden).
   */
  sync(
    dt: number,
    ent: ViewEntity | undefined,
    local: PrivateHeroView | null,
    view: FpCharacter | undefined,
    look: FpLook,
    scoped: boolean,
    spectate: { ent: ViewEntity; view: FpCharacter | undefined } | null = null,
  ): void {
    if (spectate) {
      this.syncSpectate(dt, spectate.ent, spectate.view);
      return;
    }
    const on = this.active && !!ent && !!local && !local.dead;
    this.body.apply(on && view ? view.rig.root : null, this.camera, view?.rig.mount?.object ?? null);
    if (!on || !ent || !local) {
      this.eye = -1;
      this.viewmodel.update(dt, {
        weaponId: null,
        heroId: '',
        ads: false,
        hidden: true,
        sprinting: false,
        reloading: false,
        lowered: false,
        airborne: false,
        speed: 0,
        yaw: look.yaw,
        pitch: look.pitch,
        cameraQuat: this.camera.quaternion,
      });
      return;
    }
    const w = local.weapons[local.activeSlot];
    let disarmed = false;
    for (const st of local.statuses) if (st.remaining > 0 && (st.id === 'disarm' || st.id === 'stun' || st.id === 'dance')) disarmed = true;
    this.viewmodel.update(dt, {
      weaponId: w?.id ?? ent.weapon ?? null,
      heroId: ent.sub,
      ads: look.ads,
      adsBlend: look.adsBlend,
      hidden: scoped || local.downed || (ent.flags & (VF_DOWNED | VF_DEAD)) !== 0,
      sprinting: (ent.flags & VF_SPRINTING) !== 0,
      reloading: local.reloading > 0,
      lowered: disarmed || (ent.flags & (VF_STUNNED | VF_DANCING | VF_CHANNELING)) !== 0,
      airborne: (ent.flags & VF_AIRBORNE) !== 0,
      speed: ent.speed,
      yaw: look.yaw,
      pitch: look.pitch,
      cameraQuat: this.camera.getWorldQuaternion(_qv),
    });
  }

  /**
   * Spectating in first person (V): the watched hero's body is hidden from this camera and his
   * weapon is the viewmodel, posed from what everyone can see (his flags, weapon and aim).
   */
  private syncSpectate(dt: number, e: ViewEntity, view: FpCharacter | undefined): void {
    this.body.apply(view ? view.rig.root : null, this.camera, view?.rig.mount?.object ?? null);
    this.eye = -1;
    this.viewmodel.update(dt, {
      weaponId: e.weapon ?? null,
      heroId: e.sub,
      ads: (e.flags & VF_ADS) !== 0,
      hidden: (e.flags & (VF_DOWNED | VF_DEAD)) !== 0,
      sprinting: (e.flags & VF_SPRINTING) !== 0,
      reloading: (e.flags & VF_RELOADING) !== 0,
      lowered: (e.flags & (VF_STUNNED | VF_DANCING | VF_CHANNELING)) !== 0,
      airborne: (e.flags & VF_AIRBORNE) !== 0,
      speed: e.speed,
      yaw: e.yaw,
      pitch: e.pitch,
      cameraQuat: this.camera.getWorldQuaternion(_qv),
    });
  }

  /** A predicted local shot of this weapon: recoil kick / melee swing on the viewmodel. */
  onShot(weaponId: string): void {
    const def = WEAPON_BY_ID[weaponId];
    this.viewmodel.fire(def?.recoil ?? 1, !!def?.melee);
  }

  /** World point the muzzle flash / tracer should start from (false: no viewmodel weapon shown). */
  muzzleWorld(out: THREE.Vector3): boolean {
    return this.active && this.viewmodel.muzzleWorld(this.camera, out);
  }

  dispose(): void {
    this.body.apply(null, this.camera);
    this.viewmodel.dispose();
  }
}
