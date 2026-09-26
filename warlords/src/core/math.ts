// Plain-object vector math shared by sim, net and render. No three.js here:
// the simulation must stay headless (runs on the host and in unit tests).

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const vclone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const vset = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};
export const vcopy = (out: Vec3, a: Vec3): Vec3 => vset(out, a.x, a.y, a.z);
export const vadd = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vaddScaled = (a: Vec3, b: Vec3, s: number): Vec3 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
  z: a.z + b.z * s,
});
export const vdot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const vlen = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const vlen2d = (a: Vec3): number => Math.hypot(a.x, a.z);
export const vdist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const vdist2d = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
export const vnorm = (a: Vec3): Vec3 => {
  const l = vlen(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
};
export const vlerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Wrap an angle to (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
};
export const lerpAngle = (a: number, b: number, t: number): number => a + wrapAngle(b - a) * t;

/**
 * Coordinate convention (shared by sim + render, matches three.js):
 *   +Y is up. yaw = 0 faces -Z ("forward"), yaw increases counter-clockwise seen from above
 *   (turning left). pitch > 0 looks up.
 * forward(yaw) = (-sin(yaw), 0, -cos(yaw)); right(yaw) = (cos(yaw), 0, -sin(yaw)).
 */
export const forwardFromYaw = (yaw: number): Vec3 => ({ x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) });
export const rightFromYaw = (yaw: number): Vec3 => ({ x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) });
export const dirFromYawPitch = (yaw: number, pitch: number): Vec3 => {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
};
export const yawFromDir = (d: Vec3): number => Math.atan2(-d.x, -d.z);
export const pitchFromDir = (d: Vec3): number => Math.atan2(d.y, Math.hypot(d.x, d.z));
