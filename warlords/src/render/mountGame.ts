// Convenience glue for the match screen: creates the canvas, GameRenderer and
// InputController inside a container and runs the frame loop
//   input.sample(renderer) → view.pushInput(frame) → view.update(dt) → renderer.frame(dt)
// The returned handle is structurally compatible with the UI's GameHandle
// (src/ui/app.ts): input, onEvents, setSpectateTarget, worldToScreen, dispose.
import type { Vec3 } from '../core/math';
import type { EntityId, GameEvent } from '../core/types';
import { InputController } from '../game/input';
import { GameRenderer } from './renderer';
import type { ViewSource } from './view';

export interface GameViewHandle {
  readonly renderer: GameRenderer;
  readonly input: InputController;
  readonly canvas: HTMLCanvasElement;
  onEvents(cb: (evs: readonly GameEvent[]) => void): () => void;
  setSpectateTarget(id: EntityId | null): void;
  worldToScreen(p: Vec3): { x: number; y: number } | null;
  dispose(): void;
}

export interface MountGameOptions {
  /** called after every rendered frame (HUD refresh etc.) */
  onFrame?(dt: number): void;
}

export function mountGameView(container: HTMLElement, view: ViewSource, opts: MountGameOptions = {}): GameViewHandle {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none';
  canvas.tabIndex = 0;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(canvas);
  const renderer = new GameRenderer(canvas, view);
  const input = new InputController(canvas);
  const resize = (): void => renderer.resize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(container);
  window.addEventListener('resize', resize);
  resize();

  let raf = 0;
  let last = performance.now();
  let disposed = false;
  const loop = (now: number): void => {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    try {
      const frame = input.sample(renderer);
      view.pushInput(frame);
      view.update(dt);
      renderer.frame(dt);
      opts.onFrame?.(dt);
    } catch (err) {
      console.error('[render] frame failed', err);
    }
  };
  raf = requestAnimationFrame(loop);

  return {
    renderer,
    input,
    canvas,
    onEvents: (cb) => renderer.onEvents(cb),
    setSpectateTarget: (id) => renderer.setSpectateTarget(id),
    worldToScreen: (p) => renderer.worldToScreen(p),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', resize);
      input.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
