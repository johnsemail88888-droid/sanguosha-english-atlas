// Entry point: wires the UI shell to the netcode (sessions), the three.js
// renderer and the procedural audio engine.
import pkg from '../package.json';
import { audio } from './audio';
import type { GameEvent } from './core/types';
import type { GameSession } from './game/session';
import { createLocalSession, hostOnlineSession, joinOnlineSession } from './net';
import { mountGameView, mountHeroTurntable, renderHeroPortrait } from './render';
import type { ViewSource } from './render/view';
import { registerAllVfx } from './render/vfx/registerAll';
import { mountApp, type AppDeps, type GameHandle } from './ui/app';
import { DebugHooks, debugEnabled } from './game/debug';

registerAllVfx();

// `?debug=1`: window.__sgwl hooks for automated play-testing (see src/game/debug.ts)
const debug = debugEnabled() ? new DebugHooks(pkg.version, () => document.querySelector<HTMLElement>('.sg-root')) : null;

function mountGame(container: HTMLElement, view: ViewSource, session: GameSession): GameHandle {
  let pending: GameEvent[] = [];
  let lastIntensity = -1;
  // `handle` is assigned before the first frame calls onFrame (frames start after the staged build).
  // eslint-disable-next-line prefer-const
  let handle: ReturnType<typeof mountGameView>;
  handle = mountGameView(container, view, {
    onFrame: () => {
      const r = handle.renderer;
      if (r) {
        const pose = r.getCameraPose();
        audio.setListener(pose.pos, pose.yaw, pose.pitch);
      }
      // Audio also drives footsteps/loops from the view state, so call it every frame.
      const evs = pending;
      pending = [];
      audio.handleEvents(evs, view);
      const me = view.local();
      audio.setDowned(Boolean(me && me.downed && !me.dead));
      const intensity = Math.min(1, Math.max(0, view.zone().phase / 5));
      if (Math.abs(intensity - lastIntensity) > 0.01) {
        lastIntensity = intensity;
        audio.setIntensity(intensity);
      }
    },
  });
  const offEvents = handle.onEvents((evs) => {
    for (const e of evs) pending.push(e);
    debug?.onEvents(evs);
  });
  const offFire = handle.onLocalFire((weaponId) => audio.localFire(weaponId));
  const offProgress = handle.onProgress((p) => {
    debug?.mark(`load:${p.stage}`);
    if (p.stage === 'failed') console.error('[app] 3D view failed to start:', p.error);
  });
  const gameHandle: GameHandle = {
    input: handle.input,
    onEvents: (cb) => handle.onEvents(cb),
    setSpectateTarget: (id) => handle.setSpectateTarget(id),
    worldToScreen: (p) => handle.worldToScreen(p),
    onLoadProgress: (cb) => handle.onProgress(cb),
    isReady: () => handle.ready,
    dispose: () => {
      offDebug?.();
      offProgress();
      offEvents();
      offFire();
      audio.setDowned(false);
      handle.dispose();
    },
  };
  const offDebug = debug?.attachGame({ view, session, handle, gameHandle });
  return gameHandle;
}

const track = <T extends GameSession>(s: T): T => (debug ? debug.trackSession(s) : s);

const deps: AppDeps = {
  createLocalSession: (name) => track(createLocalSession({ name })),
  hostOnline: async (name, mode) => track(await hostOnlineSession({ name, mode })),
  joinOnline: async (code, name, mode) => track(await joinOnlineSession(code, { name, mode })),
  mountGame,
  renderHeroPortrait,
  mountHeroTurntable,
  audio: {
    ui: (name) => audio.ui(name),
    music: (track) => audio.music(track),
    unlock: () => audio.unlock(),
  },
};

const root = document.getElementById('app');
if (!root) throw new Error('#app root missing');
root.textContent = '';
const app = mountApp(root, deps, { version: pkg.version });
window.addEventListener('pagehide', () => {
  app.dispose();
  audio.dispose();
});
