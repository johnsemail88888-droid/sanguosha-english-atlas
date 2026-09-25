// Convenience glue for the match screen: creates the canvas, GameRenderer and
// InputController inside a container and runs the frame loop
//   input.sample(renderer) → view.pushInput(frame) → view.update(dt) → renderer.frame(dt)
// The returned handle is structurally compatible with the UI's GameHandle
// (src/ui/app.ts): input, onEvents, setSpectateTarget, worldToScreen, dispose.
//
// Staged loading: the canvas + input exist immediately; the renderer is built
// after the loading screen had a chance to paint, then shaders are warmed up
// and two frames are rendered before `ready` — onProgress() reports each stage
// so the loading screen can show real progress instead of a frozen HUD.
import type { Vec3 } from '../core/math';
import type { EntityId, GameEvent } from '../core/types';
import { InputController } from '../game/input';
import { GameRenderer } from './renderer';
import type { ViewSource } from './view';

export type LoadStage = 'scene' | 'shaders' | 'warmup' | 'ready' | 'failed';

export interface LoadProgress {
  /** 0..1 */
  progress: number;
  stage: LoadStage;
  /** set when stage = 'failed' */
  error?: string;
}

export interface GameViewHandle {
  /** null until the staged build created it (see onProgress / ready) */
  readonly renderer: GameRenderer | null;
  readonly input: InputController;
  readonly canvas: HTMLCanvasElement;
  /** the first frames have rendered (or the renderer failed) */
  readonly ready: boolean;
  /** current progress; `cb` is called right away with it and on every stage */
  onProgress(cb: (p: LoadProgress) => void): () => void;
  onEvents(cb: (evs: readonly GameEvent[]) => void): () => void;
  onLocalFire(cb: (weaponId: string) => void): () => void;
  setSpectateTarget(id: EntityId | null): void;
  worldToScreen(p: Vec3): { x: number; y: number } | null;
  dispose(): void;
}

export interface MountGameOptions {
  /** called after every rendered frame (HUD refresh etc.) */
  onFrame?(dt: number): void;
  /** build everything synchronously (dev harnesses / tests); default false */
  sync?: boolean;
}

/** Run `fn` after the browser had a chance to paint (hidden tabs: next task). */
function afterPaint(fn: () => void): void {
  if (typeof document !== 'undefined' && !document.hidden && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(fn, 0));
  } else {
    setTimeout(fn, 0);
  }
}

export function mountGameView(container: HTMLElement, view: ViewSource, opts: MountGameOptions = {}): GameViewHandle {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none';
  canvas.tabIndex = 0;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(canvas);
  const input = new InputController(canvas);

  let renderer: GameRenderer | null = null;
  let progress: LoadProgress = { progress: 0.4, stage: 'scene' };
  const progressSubs = new Set<(p: LoadProgress) => void>();
  const eventSubs = new Set<(evs: readonly GameEvent[]) => void>();
  const fireSubs = new Set<(weaponId: string) => void>();
  let spectate: EntityId | null = null;
  let disposed = false;
  let raf = 0;
  let last = performance.now();

  const setProgress = (p: LoadProgress): void => {
    progress = p;
    for (const cb of progressSubs) {
      try {
        cb(p);
      } catch (err) {
        console.error('[render] progress subscriber failed', err);
      }
    }
  };

  const resize = (): void => renderer?.resize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(container);
  window.addEventListener('resize', resize);

  const frame = (dt: number): void => {
    const r = renderer;
    if (!r) return;
    const f = input.sample(r);
    view.pushInput(f);
    view.update(dt);
    r.frame(dt);
    opts.onFrame?.(dt);
  };

  const loop = (now: number): void => {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    try {
      frame(dt);
    } catch (err) {
      console.error('[render] frame failed', err);
    }
  };

  const fail = (err: unknown): void => {
    console.error('[render] could not start the 3D view', err);
    setProgress({ progress: 1, stage: 'failed', error: err instanceof Error ? err.message : String(err) });
  };

  const build = (): boolean => {
    try {
      const r = new GameRenderer(canvas, view);
      renderer = r;
      r.onEvents((evs) => {
        for (const cb of eventSubs) cb(evs);
      });
      r.onLocalFire((id) => {
        for (const cb of fireSubs) cb(id);
      });
      r.setSpectateTarget(spectate);
      resize();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  };

  const start = (): void => {
    if (disposed) return;
    last = performance.now();
    setProgress({ progress: 1, stage: 'ready' });
    raf = requestAnimationFrame(loop);
  };

  /** two real frames: shadow-depth programs and anything the warm-up missed compile here */
  const primeFrames = (): void => {
    try {
      frame(1 / 60);
      frame(1 / 60);
    } catch (err) {
      console.error('[render] frame failed', err);
    }
  };

  if (opts.sync) {
    if (build()) primeFrames();
    start();
  } else {
    afterPaint(() => {
      if (disposed) return;
      if (!build()) return;
      setProgress({ progress: 0.62, stage: 'shaders' });
      afterPaint(() => {
        if (disposed || !renderer) return;
        // shaders: 0.62 → 0.88 as the warm-up batches link
        void renderer.warmup((f) => setProgress({ progress: 0.62 + 0.26 * Math.min(1, f), stage: 'shaders' })).then(() => {
          if (disposed) return;
          setProgress({ progress: 0.88, stage: 'warmup' });
          afterPaint(() => {
            if (disposed) return;
            primeFrames();
            start();
          });
        });
      });
    });
  }

  return {
    get renderer() {
      return renderer;
    },
    input,
    canvas,
    get ready() {
      return progress.stage === 'ready' || progress.stage === 'failed';
    },
    onProgress(cb) {
      progressSubs.add(cb);
      cb(progress);
      return () => progressSubs.delete(cb);
    },
    onEvents(cb) {
      eventSubs.add(cb);
      return () => eventSubs.delete(cb);
    },
    onLocalFire(cb) {
      fireSubs.add(cb);
      return () => fireSubs.delete(cb);
    },
    setSpectateTarget(id) {
      spectate = id;
      renderer?.setSpectateTarget(id);
    },
    worldToScreen: (p) => renderer?.worldToScreen(p) ?? null,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      progressSubs.clear();
      eventSubs.clear();
      fireSubs.clear();
      input.dispose();
      renderer?.dispose();
      canvas.remove();
    },
  };
}
