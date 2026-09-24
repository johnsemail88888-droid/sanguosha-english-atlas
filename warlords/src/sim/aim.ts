// Third-person camera rig shared by the sim (crosshair reconstruction for
// hit resolution) and the renderer (so what you see is what the host resolves).
//   pivot  = feet + up CAM_PIVOT_HEIGHT
//   camera = pivot + right(yaw) * CAM_SHOULDER - aimDir(yaw, pitch) * CAM_DISTANCE
//   ray    = from camera along aimDir(yaw, pitch)
import type { Vec3 } from '../core/math';

export const CAM_PIVOT_HEIGHT = 1.65;
export const CAM_SHOULDER = 0.55;
export const CAM_DISTANCE = 2.8;
/** pivot height while downed (crawling) */
export const CAM_PIVOT_HEIGHT_DOWNED = 0.7;

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
