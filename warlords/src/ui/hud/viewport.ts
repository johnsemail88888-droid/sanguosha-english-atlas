// Cached viewport size for per-frame HUD code. Reading window.innerWidth /
// innerHeight inside the frame loop (after style writes) can force a
// synchronous layout, so the values are refreshed from 'resize' events only.

export interface ViewportSize {
  readonly w: number;
  readonly h: number;
}

const size = { w: 1280, h: 720 };
let bound = false;

function read(): void {
  size.w = window.innerWidth || size.w;
  size.h = window.innerHeight || size.h;
}

/**
 * Start tracking the viewport (idempotent). Call once outside the frame loop,
 * e.g. when the HUD is created.
 */
export function trackViewport(): void {
  if (bound || typeof window === 'undefined') return;
  bound = true;
  read();
  window.addEventListener('resize', read, { passive: true });
  window.visualViewport?.addEventListener('resize', read, { passive: true });
}

/** Last known viewport size in CSS pixels (never forces layout). */
export function viewport(): ViewportSize {
  return size;
}
