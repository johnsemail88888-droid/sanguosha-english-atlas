// Over-the-shoulder third-person camera. The pose is the simulation's own aim
// reconstruction (sim/aim.ts cameraRig), so the crosshair ray the player sees
// is exactly the ray the host resolves:
//   pivot  = hero.pos + up * CAM_PIVOT_HEIGHT (0.7 while downed)
//   camera = pivot + right(yaw) * CAM_SHOULDER − dir(yaw, pitch) * CAM_DISTANCE
//   look   = dir(yaw, pitch)
// Collision pulls the camera forward ALONG the aim ray first (keeping the ray
// identical), then toward the pivot when a wall hugs the shoulder.
import * as THREE from 'three';
import type { Vec3 } from '../../core/math';
import { clamp, dirFromYawPitch, lerpAngle, rightFromYaw, wrapAngle } from '../../core/math';
import { cameraRig, CAM_DISTANCE, CAM_PIVOT_HEIGHT, CAM_PIVOT_HEIGHT_DOWNED, CAM_SHOULDER } from '../../sim/aim';
import type { PickWorld } from './pick';

export const CAM_UP = CAM_PIVOT_HEIGHT;
export const CAM_RIGHT = CAM_SHOULDER;
export const CAM_BACK = CAM_DISTANCE;
export const PITCH_LIMIT = 1.45;

export interface CameraPose {
  origin: Vec3;
  dir: Vec3;
  /** hits nearer than this along the ray are behind the character */
  nearClip: number;
}

/** Canonical TPS camera pose for a hero standing at `pos` looking (yaw, pitch). */
export function tpsCameraPose(pos: Vec3, yaw: number, pitch: number, downed = false): CameraPose {
  const r = cameraRig(pos, yaw, pitch, downed);
  return { origin: r.origin, dir: r.dir, nearClip: r.nearClip };
}

const pivotHeight = (downed: boolean): number => (downed ? CAM_PIVOT_HEIGHT_DOWNED : CAM_PIVOT_HEIGHT);

export interface CollisionResult {
  /** adjusted camera origin */
  pos: Vec3;
  /** distance behind the shoulder along the aim ray (≤ CAM_BACK) */
  back: number;
  /** right offset actually used (≤ CAM_RIGHT) */
  right: number;
}

/**
 * Resolve camera collision: first slide forward along the aim ray (the
 * crosshair ray is unchanged), and if the shoulder offset itself is inside
 * geometry, reduce the right offset.
 */
export function resolveCameraCollision(
  world: PickWorld,
  pos: Vec3,
  yaw: number,
  pitch: number,
  downed = false,
  pad = 0.3,
): CollisionResult {
  const pivot = { x: pos.x, y: pos.y + pivotHeight(downed), z: pos.z };
  const r = rightFromYaw(yaw);
  const d = dirFromYawPitch(yaw, pitch);
  let right = CAM_RIGHT;
  const sideDist = world.staticDistance(pivot, r, CAM_RIGHT + pad);
  if (Number.isFinite(sideDist)) right = Math.max(0, sideDist - pad);
  const shoulder = { x: pivot.x + r.x * right, y: pivot.y, z: pivot.z + r.z * right };
  const back = { x: -d.x, y: -d.y, z: -d.z };
  let dist = CAM_BACK;
  const hit = world.staticDistance(shoulder, back, CAM_BACK + pad);
  if (Number.isFinite(hit)) dist = Math.max(0.35, hit - pad);
  return {
    pos: { x: shoulder.x + back.x * dist, y: shoulder.y + back.y * dist, z: shoulder.z + back.z * dist },
    back: dist,
    right,
  };
}

export type CameraMode = 'follow' | 'spectate' | 'orbit' | 'free';

/** Trauma-based screen shake + recoil kick, shared by every mode. */
export class CameraShake {
  private trauma = 0;
  private kickPitch = 0;
  private kickYaw = 0;
  private t = 0;

  add(intensity: number): void {
    this.trauma = clamp(this.trauma + intensity, 0, 1);
  }

  kick(pitch: number, yaw: number): void {
    this.kickPitch = clamp(this.kickPitch + pitch, 0, 0.12);
    this.kickYaw += yaw;
  }

  update(dt: number): void {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const k = Math.exp(-dt * 14);
    this.kickPitch *= k;
    this.kickYaw *= k;
  }

  /** offsets: [pitch, yaw, roll] radians, [x, y] metres */
  sample(): { pitch: number; yaw: number; roll: number } {
    const s = this.trauma * this.trauma;
    const t = this.t;
    return {
      pitch: s * 0.05 * Math.sin(t * 41.3 + 1.1) * Math.cos(t * 23.1) + this.kickPitch,
      yaw: s * 0.05 * Math.sin(t * 37.7 + 2.3) + this.kickYaw,
      roll: s * 0.04 * Math.sin(t * 29.9 + 0.3),
    };
  }
}

const _dir = new THREE.Vector3();
const _look = new THREE.Vector3();

/**
 * Stateful camera rig: smoothing, ADS zoom, spectator follow, free orbit.
 * The renderer feeds it targets each frame.
 */
export class TpsCameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly shake = new CameraShake();
  mode: CameraMode = 'orbit';
  baseFov = 75;
  /** current ADS zoom factor applied to the FOV (1 = none) */
  private zoom = 1;
  private readonly pos = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private initialised = false;
  private orbitAngle = 0;
  private collisionDist = CAM_BACK;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  /** Current (unshaken) pose, for pick() and nameplates. */
  pose(): { pos: Vec3; yaw: number; pitch: number } {
    return { pos: { x: this.pos.x, y: this.pos.y, z: this.pos.z }, yaw: this.yaw, pitch: this.pitch };
  }

  /** Hard-set the pose (used for the local hero every frame: no lag on the crosshair ray). */
  setPose(p: Vec3, yaw: number, pitch: number): void {
    this.pos.set(p.x, p.y, p.z);
    this.yaw = yaw;
    this.pitch = pitch;
    this.initialised = true;
  }

  /** Smoothly approach a pose (spectating / orbit). */
  approach(p: Vec3, yaw: number, pitch: number, dt: number, rate = 8): void {
    if (!this.initialised) {
      this.setPose(p, yaw, pitch);
      return;
    }
    const k = 1 - Math.exp(-dt * rate);
    this.pos.x += (p.x - this.pos.x) * k;
    this.pos.y += (p.y - this.pos.y) * k;
    this.pos.z += (p.z - this.pos.z) * k;
    this.yaw = wrapAngle(lerpAngle(this.yaw, yaw, k));
    this.pitch += (pitch - this.pitch) * k;
  }

  /** Follow a hero with the canonical TPS pose (+collision). Collision pulls in instantly, eases back out. */
  follow(world: PickWorld | null, target: Vec3, yaw: number, pitch: number, dt: number, smooth: boolean, downed = false): void {
    const p = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    let camPos: Vec3;
    if (world) {
      const res = resolveCameraCollision(world, target, yaw, p, downed);
      this.collisionDist =
        res.back < this.collisionDist ? res.back : this.collisionDist + (res.back - this.collisionDist) * (1 - Math.exp(-dt * 5));
      const d = dirFromYawPitch(yaw, p);
      const r = rightFromYaw(yaw);
      camPos = {
        x: target.x + r.x * res.right - d.x * this.collisionDist,
        y: target.y + pivotHeight(downed) - d.y * this.collisionDist,
        z: target.z + r.z * res.right - d.z * this.collisionDist,
      };
    } else camPos = tpsCameraPose(target, yaw, p, downed).origin;
    if (smooth) this.approach(camPos, yaw, p, dt, 14);
    else this.setPose(camPos, yaw, p);
  }

  /** Slow cinematic orbit around a point (before spawn / dead without a spectate target). */
  orbit(center: Vec3, radius: number, height: number, dt: number): void {
    this.orbitAngle += dt * 0.06;
    const px = center.x + Math.cos(this.orbitAngle) * radius;
    const pz = center.z + Math.sin(this.orbitAngle) * radius;
    const py = center.y + height;
    _dir.set(center.x - px, center.y + 2 - py, center.z - pz).normalize();
    const yaw = Math.atan2(-_dir.x, -_dir.z);
    const pitch = Math.asin(clamp(_dir.y, -1, 1));
    this.approach({ x: px, y: py, z: pz }, yaw, pitch, dt, 2);
  }

  setZoom(target: number, dt: number): void {
    const k = 1 - Math.exp(-dt * 12);
    this.zoom += (target - this.zoom) * k;
  }

  get currentZoom(): number {
    return this.zoom;
  }

  /** Write the pose (+shake) into the three.js camera. */
  apply(dt: number): void {
    this.shake.update(dt);
    const s = this.shake.sample();
    const cam = this.camera;
    cam.position.copy(this.pos);
    const yaw = this.yaw + s.yaw;
    const pitch = clamp(this.pitch + s.pitch, -1.55, 1.55);
    const d = dirFromYawPitch(yaw, pitch);
    _look.set(this.pos.x + d.x, this.pos.y + d.y, this.pos.z + d.z);
    cam.up.set(Math.sin(s.roll) * Math.cos(yaw), Math.cos(s.roll), -Math.sin(s.roll) * Math.sin(yaw));
    cam.lookAt(_look);
    const fov = clamp(this.baseFov / Math.max(1, this.zoom), 8, 110);
    if (Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }
}
