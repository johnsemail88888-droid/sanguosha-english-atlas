// Page focus / visibility watcher. When a tab is hidden, requestAnimationFrame
// stops, so a view's pushInput/update stop too — the player's last input would
// otherwise stay applied (running into the zone, firing). Sessions use this to
// release input immediately, outside the render loop. No-op outside browsers.

export interface PageFocusHandlers {
  /** the page became hidden (tab switch, minimized, navigating away) */
  onHidden(): void;
  /** the page is visible again */
  onVisible(): void;
  /** the window lost keyboard focus (alt-tab while still visible) */
  onBlur?(): void;
}

interface EventTargetLike {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

/** True when running in a browser page that is currently hidden. */
export function isPageHidden(): boolean {
  const doc = (globalThis as { document?: { hidden?: boolean } }).document;
  return doc?.hidden === true;
}

/** Subscribe to page visibility / focus changes. Returns the unsubscribe function. */
export function watchPageFocus(h: PageFocusHandlers): () => void {
  const g = globalThis as { document?: EventTargetLike & { hidden?: boolean }; window?: EventTargetLike };
  const doc = g.document;
  const win = g.window;
  if (!doc || typeof doc.addEventListener !== 'function') return () => {};
  let hidden = doc.hidden === true;
  const onVisibility = (): void => {
    const now = doc.hidden === true;
    if (now === hidden) return;
    hidden = now;
    if (now) h.onHidden();
    else h.onVisible();
  };
  const onPageHide = (): void => {
    if (hidden) return;
    hidden = true;
    h.onHidden();
  };
  const onBlur = (): void => h.onBlur?.();
  doc.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('pagehide', onPageHide);
  win?.addEventListener('blur', onBlur);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('pagehide', onPageHide);
    win?.removeEventListener('blur', onBlur);
  };
}
