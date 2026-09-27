// Camera rigs shared by the sim (crosshair reconstruction for hit resolution)
// and the renderer (so what you see is what the host resolves).
// Third person (default):
//   pivot  = feet + up CAM_PIVOT_HEIGHT
//   camera = pivot + right(yaw) * CAM_SHOULDER - aimDir(yaw, pitch) * CAM_DISTANCE
//   ray    = from camera along aimDir(yaw, pitch)
// First person (the input's BTN_FIRST_PERSON):
//   camera = feet + up fpEyeHeight(downed, mounted) — the hero's eye, no offset
//   ray    = from the eye along aimDir(yaw, pitch); the hero's shots start there too
import type { Vec3 } from '../core/math';

export const CAM_PIVOT_HEIGHT = 1.65;
export const CAM_SHOULDER = 0.55;
export const CAM_DISTANCE = 2.8;
/** pivot height while downed (crawling) */
export const CAM_PIVOT_HEIGHT_DOWNED = 0.7;

/**
 * First-person eye heights above the feet (m). Every hero has the same 1.8 m hit
 * capsule (head sphere centred at 1.58 m, sim/combat.ts hitbox), so the eye is
 * World.eyePos's 0.9 × 1.8 for everyone; a rider's hit box is 2.3 m (head at
 * 2.02 m, MOUNTED_HIT) and the seated rider's eyes are drawn at about 2.05 m
 * (render SADDLE_HIP 1.38 m + hip→eye 0.67 m); a downed hero crawls at 0.5 m.
 */
export const FP_EYE_HEIGHT = 1.62;
export const FP_EYE_HEIGHT_MOUNTED = 2.05;
export const FP_EYE_HEIGHT_DOWNED = 0.5;

/** First-person eye height for a hero in this state (a downed hero is never seated). */
export function fpEyeHeight(downed: boolean, mounted: boolean): number {
  if (downed) return FP_EYE_HEIGHT_DOWNED;
  return mounted ? FP_EYE_HEIGHT_MOUNTED : FP_EYE_HEIGHT;
}

export interface CameraRig {
  pivot: Vec3;
  origin: Vec3;
  dir: Vec3;
  /**
   * distance along the ray from `origin` to the point closest to the pivot:
   * hits nearer than this are behind the character and must be ignored when
   * finding the crosshair point.
   */
  nearClip: number;
}

export function cameraRig(pos: Vec3, yaw: number, pitch: number, downed = false): CameraRig {
  const cp = Math.cos(pitch);
  const dir = { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const pivot = { x: pos.x, y: pos.y + (downed ? CAM_PIVOT_HEIGHT_DOWNED : CAM_PIVOT_HEIGHT), z: pos.z };
  const origin = {
    x: pivot.x + rx * CAM_SHOULDER - dir.x * CAM_DISTANCE,
    y: pivot.y - dir.y * CAM_DISTANCE,
    z: pivot.z + rz * CAM_SHOULDER - dir.z * CAM_DISTANCE,
  };
  const nearClip =
    (pivot.x - origin.x) * dir.x + (pivot.y - origin.y) * dir.y + (pivot.z - origin.z) * dir.z;
  return { pivot, origin, dir, nearClip: Math.max(0, nearClip) };
}

/**
 * First-person rig: the camera is the eye (`eyeHeight` above the feet), the ray
 * leaves it along aimDir(yaw, pitch) — no shoulder offset, nothing behind the
 * character to clip (nearClip 0; the shooter's own capsule is ignored by every
 * crosshair raycast).
 */
export function firstPersonRig(pos: Vec3, yaw: number, pitch: number, eyeHeight: number): CameraRig {
  const cp = Math.cos(pitch);
  const dir = { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  const eye = { x: pos.x, y: pos.y + eyeHeight, z: pos.z };
  return { pivot: eye, origin: { x: eye.x, y: eye.y, z: eye.z }, dir, nearClip: 0 };
}

/**
 * yaw/pitch that make the third-person crosshair pass through `target` for a
 * character standing at `pos` (bots use this; converges in a few iterations
 * because the shoulder offset is small compared to typical distances).
 */
export function aimAnglesFor(pos: Vec3, target: Vec3, downed = false): { yaw: number; pitch: number } {
  const pivotY = pos.y + (downed ? CAM_PIVOT_HEIGHT_DOWNED : CAM_PIVOT_HEIGHT);
  let yaw = Math.atan2(-(target.x - pos.x), -(target.z - pos.z));
  let pitch = Math.atan2(target.y - pivotY, Math.hypot(target.x - pos.x, target.z - pos.z));
  for (let i = 0; i < 3; i++) {
    const rig = cameraRig(pos, yaw, pitch, downed);
    const dx = target.x - rig.origin.x;
    const dy = target.y - rig.origin.y;
    const dz = target.z - rig.origin.z;
    yaw = Math.atan2(-dx, -dz);
    pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }
  return { yaw, pitch };
}
