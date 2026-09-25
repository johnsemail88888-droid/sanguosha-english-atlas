// Near-camera fade for characters other than the local hero: a troop / NPC /
// hero whose body is within ~1.6 m of the camera, or that stands on the line
// between the camera and the hero it follows, turns translucent (and its
// nameplate / pennant hides) so your own squad never fills the screen.
// Pure math: unit-tested in tests/unit/render/camFade.test.ts.

export interface P3 {
  x: number;
  y: number;
  z: number;
}

/** Fully opaque when the body surface is at least this far (m) from the camera. */
export const CAM_FADE_NEAR = 1.8;
/** Fully faded (CAM_FADE_MIN) when the body surface is this close (m). */
export const CAM_FADE_FULL = 0.5;
/** Minimum opacity of a faded character. */
export const CAM_FADE_MIN = 0.08;
/** Opacity of a character blocking the camera → followed hero line. */
export const CAM_FADE_BLOCKING = 0.22;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Target opacity (CAM_FADE_MIN..1) for a character standing at `p` (feet) with
 * body height `height` and radius `radius`.
 * `focus` = chest of the hero the camera follows (null: orbit / free camera).
 */
export function cameraFadeTarget(cam: P3, focus: P3 | null, p: P3, height: number, radius = 0.45): number {
  const y0 = p.y + 0.05;
  const y1 = p.y + Math.max(0.5, height);
  // 1. distance from the camera to the body (vertical capsule axis)
  const cy = cam.y < y0 ? y0 : cam.y > y1 ? y1 : cam.y;
  const d = Math.max(0, Math.hypot(cam.x - p.x, cam.y - cy, cam.z - p.z) - radius);
  let fade = CAM_FADE_MIN + (1 - CAM_FADE_MIN) * clamp01((d - CAM_FADE_FULL) / (CAM_FADE_NEAR - CAM_FADE_FULL));
  // 2. standing between the camera and the followed hero
  if (focus) {
    const dx = focus.x - cam.x;
    const dy = focus.y - cam.y;
    const dz = focus.z - cam.z;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 > 0.25) {
      const mx = p.x - cam.x;
      const my = (y0 + y1) * 0.5 - cam.y;
      const mz = p.z - cam.z;
      const t = (mx * dx + my * dy + mz * dz) / len2;
      const len = Math.sqrt(len2);
      // only in front of the camera and not beyond the followed hero (minus its body)
      if (t > 0 && t < 1 - 0.35 / len) {
        const qx = cam.x + dx * t;
        const qy = cam.y + dy * t;
        const qz = cam.z + dz * t;
        if (qy > y0 - 0.25 && qy < y1 + 0.25) {
          const r = Math.hypot(qx - p.x, qz - p.z);
          const k = clamp01((r - (radius + 0.25)) / 0.35);
          fade = Math.min(fade, CAM_FADE_BLOCKING + (1 - CAM_FADE_BLOCKING) * k);
        }
      }
    }
  }
  return fade;
}
