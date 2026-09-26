// Line-of-sight gating of the overhead UI that is drawn on top of the world
// (depthTest: false): hero nameplates, troop / NPC pennants and the 鬼谋 mark
// chevron. Anything behind a wall or a hill must not show — that would leak
// hidden positions (a wallhack) — except what you are entitled to see anyway:
//   - your own hero and your own squad,
//   - a hero revealed to you (VF_EXPOSED: 观星 / 狼顾 / 鬼谋 …).
// The line-of-sight test (PickWorld.segmentBlocked: static colliders + terrain
// heightfield) is cached per character and refreshed every LOS_STAGGER frames,
// staggered by entity id so only a few characters test per frame; heroes are
// also re-tested once their result is LOS_MAX_AGE_HERO old, so a plate comes
// back within ~0.3 s at any frame rate.
// Pure logic: unit-tested in tests/unit/render/occlusion.test.ts.

/** A character's line-of-sight result is refreshed every this many frames (staggered by id). */
export const LOS_STAGGER = 8;
/** Heroes: re-test at the latest when the cached result is this old (s). */
export const LOS_MAX_AGE_HERO = 0.1;
/** Opacity rates (1/s) towards hidden / shown. */
export const OCCLUSION_HIDE_RATE = 20;
export const OCCLUSION_SHOW_RATE = 14;
/** Characters closer than this to the camera are never LOS-tested (always shown). */
export const LOS_MIN_DIST = 4;

export interface OverheadVisibility {
  /** revealed to the viewer (VF_EXPOSED) */
  exposed: boolean;
  /** the viewer's own hero */
  local: boolean;
  /** a member of the viewer's own squad */
  squad: boolean;
}

/** Target opacity (0 or 1) of an overhead marker given the cached line-of-sight result. */
export function overheadTarget(blocked: boolean, v: OverheadVisibility): number {
  if (v.local || v.squad || v.exposed) return 1;
  return blocked ? 0 : 1;
}

/** Does this marker need a line-of-sight test at all? (Always-visible ones never pay for it.) */
export function needsLos(v: OverheadVisibility, dist: number): boolean {
  return !(v.local || v.squad || v.exposed) && dist > LOS_MIN_DIST;
}

/**
 * One smoothing step of the occlusion opacity towards `target`: hides fast,
 * shows a little slower; snaps to 0 / 1 at the ends.
 */
export function stepOcclusion(cur: number, target: number, dt: number): number {
  const rate = target < cur ? OCCLUSION_HIDE_RATE : OCCLUSION_SHOW_RATE;
  let next = cur + (target - cur) * (1 - Math.exp(-Math.max(0, dt) * rate));
  if (target <= 0 && next < 0.02) next = 0;
  if (target >= 1 && next > 0.98) next = 1;
  return next;
}

/** Cached, staggered line-of-sight result of one character. */
export class LosCache {
  blocked = false;
  private tested = false;
  private at = -Infinity;

  /**
   * True when a fresh test is due: never tested yet (a marker never shows
   * before its first test), this character's stagger slot, or the cached
   * result is older than `maxAge` seconds.
   */
  due(frame: number, time: number, id: number, maxAge = Infinity): boolean {
    return !this.tested || (frame + id) % LOS_STAGGER === 0 || time - this.at >= maxAge;
  }

  /** Store a fresh result; returns true the first time (the caller should not fade in from 0). */
  set(blocked: boolean, time: number): boolean {
    const first = !this.tested;
    this.blocked = blocked;
    this.tested = true;
    this.at = time;
    return first;
  }

  /** Forget the cached result (the marker went out of range / was hidden). */
  reset(): void {
    this.tested = false;
    this.blocked = false;
  }

  get fresh(): boolean {
    return this.tested;
  }
}
