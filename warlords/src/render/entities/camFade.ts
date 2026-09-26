// Near-camera fade for characters other than the local hero, so nothing ever
// fills the screen in the third-person view:
//   - any troop / NPC / hero whose body surface is closer than CAM_FADE_HIDE to
//     the camera is hidden outright (mesh, nameplate, badge, auras) — a body
//     ~1 m from the lens is never drawn as a giant translucent ghost — and eases
//     back in (smoothstep: barely visible just past the hide distance) until
//     CAM_FADE_NEAR;
//   - while your hero is downed the crawling camera sits ~0.7 m above the
//     ground: troops / NPCs inside its larger near volume (CAM_FADE_DOWNED_*)
//     fade so legs do not wall off the view;
//   - your OWN squad fades earlier (CAM_FADE_SQUAD_NEAR) and also by screen
//     coverage: a soldier whose projected height exceeds ~40 % of the viewport
//     turns translucent wherever it stands (they follow you around in formation);
//   - a character standing on the line between the camera and the hero it follows
//     turns translucent.
// Enemies are only faded when they are practically inside the camera: you must
// always be able to see what is shooting you.
// Pure math: unit-tested in tests/unit/render/camFade.test.ts.

export interface P3 {
  x: number;
  y: number;
  z: number;
}

/** Hidden (opacity 0) when the body surface is closer than this (m) to the camera. */
export const CAM_FADE_HIDE = 1.1;
/** Fully opaque from this distance (m) of the body surface to the camera. */
export const CAM_FADE_NEAR = 2.4;
/** Own squad: fully opaque only from this distance (m). */
export const CAM_FADE_SQUAD_NEAR = 3.5;
/** Downed (low camera), troops / NPCs: hidden closer than this (m)… */
export const CAM_FADE_DOWNED_HIDE = 1.5;
/** …and fully opaque only from this distance (m). */
export const CAM_FADE_DOWNED_NEAR = 3.6;
/** Own squad: start fading when the projected body height exceeds this fraction of the viewport height… */
export const CAM_FADE_COVER_START = 0.4;
/** …and reach CAM_FADE_COVER_MIN at this fraction. */
export const CAM_FADE_COVER_FULL = 0.62;
/** Opacity of an own soldier covering most of the view. */
export const CAM_FADE_COVER_MIN = 0.18;
/** Opacity of a character blocking the camera → followed hero line. */
export const CAM_FADE_BLOCKING = 0.22;
/** At or below this opacity the view hides the character entirely (visible = false). */
export const CAM_FADE_HIDDEN = 0.04;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v: number): number => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

export interface CamFadeOptions {
  /** the character belongs to the local player's squad (fades earlier and by screen coverage) */
  squad?: boolean;
  /** normalised camera forward (needed for the screen-coverage fade) */
  camDir?: P3 | null;
  /** vertical field of view in degrees (screen-coverage fade) */
  fovDeg?: number;
  /** the local hero is downed (low crawling camera) and this is a troop / NPC: larger near volume */
  downedCam?: boolean;
}

/**
 * Target opacity (0..1) for a character standing at `p` (feet) with body height
 * `height` and radius `radius` (a rider: the mount's half length). 0 = hide it.
 * `focus` = chest of the hero the camera follows (null: orbit / free camera).
 */
export function cameraFadeTarget(cam: P3, focus: P3 | null, p: P3, height: number, radius = 0.45, opts: CamFadeOptions = {}): number {
  const y0 = p.y + 0.05;
  const y1 = p.y + Math.max(0.5, height);
  // 1. distance from the camera to the body (vertical capsule axis)
  const cy = cam.y < y0 ? y0 : cam.y > y1 ? y1 : cam.y;
  const d = Math.max(0, Math.hypot(cam.x - p.x, cam.y - cy, cam.z - p.z) - radius);
  const hide = opts.downedCam ? CAM_FADE_DOWNED_HIDE : CAM_FADE_HIDE;
  let near = opts.squad ? CAM_FADE_SQUAD_NEAR : CAM_FADE_NEAR;
  if (opts.downedCam) near = Math.max(near, CAM_FADE_DOWNED_NEAR);
  let fade = smooth01((d - hide) / (near - hide));
  if (fade <= 0) return 0;
  // 2. own squad: projected height on screen (fraction of the viewport height)
  if (opts.squad && opts.camDir && opts.fovDeg) {
    const mx = p.x - cam.x;
    const my = (y0 + y1) * 0.5 - cam.y;
    const mz = p.z - cam.z;
    const depth = mx * opts.camDir.x + my * opts.camDir.y + mz * opts.camDir.z;
    if (depth > 0.05) {
      const cover = (y1 - y0) / (2 * depth * Math.tan(((opts.fovDeg * Math.PI) / 180) * 0.5));
      const k = clamp01((cover - CAM_FADE_COVER_START) / (CAM_FADE_COVER_FULL - CAM_FADE_COVER_START));
      fade = Math.min(fade, 1 - (1 - CAM_FADE_COVER_MIN) * k);
    }
  }
  // 3. standing between the camera and the followed hero
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
