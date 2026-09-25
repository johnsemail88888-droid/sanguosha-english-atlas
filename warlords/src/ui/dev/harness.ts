// DOM side of the dev harness: fake 3D backdrop + GameHandle, procedural
// portraits, and AppDeps wired to the mocks.
//
// The mock GameHandle mirrors the real InputController (src/game/input.ts):
// gameplay input goes through the same InputState, so actions pushed while the
// HUD has input disabled are dropped, key presses map through KEY_MAP, and the
// pointer lock is simulated (requestLock grants it, simulateUnlock loses it).
// `realInput` wires the actual InputController instead.
import type { GameEvent, InputAction } from '../../core/types';
import { HERO_BY_ID } from '../../data';
import { InputController, InputState, KEY_MAP } from '../../game/input';
import type { GameSession } from '../../game/session';
import type { ViewSource } from '../../render/view';
import type { AppDeps, GameHandle, UiKey } from '../app';
import { kingdomColor } from '../theme';
import { MockSession, type MockSessionOptions } from './mock';

export interface MockGameHandle extends GameHandle {
  /** simulate the input controller reporting a UI key (bypasses the enabled gate, like a harness shortcut) */
  emitUiKey(key: UiKey, down: boolean): void;
  /** every InputAction that reached the (fake) sim, in order */
  readonly actions: InputAction[];
  readonly spectate: (number | null)[];
  /** gameplay input enabled (the HUD disables it while modal overlays are open) */
  readonly enabled: boolean;
  /** true when the real InputController drives this handle */
  readonly realInput: boolean;
  /** simulate losing the pointer lock (Esc / alt-tab); no-op with the real controller */
  simulateUnlock(): void;
}

export interface MockGameOptions {
  /** start with the (simulated) pointer lock held — default true so HUD previews are not covered by "click to play" */
  locked?: boolean;
  /** drive the handle with the real InputController (src/game/input.ts) */
  realInput?: boolean;
}

/** A painted battlefield backdrop + a GameHandle that re-emits the view's events each frame. */
export function mountMockGame(container: HTMLElement, view: ViewSource, opts: MockGameOptions = {}): MockGameHandle {
  const canvas = document.createElement('canvas');
  canvas.className = 'mock-game-canvas';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  container.appendChild(canvas);
  const paint = (): void => {
    const w = Math.max(1, container.clientWidth);
    const hgt = Math.max(1, container.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const horizon = hgt * 0.52;
    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#6f8fae');
    sky.addColorStop(0.6, '#d9b98a');
    sky.addColorStop(1, '#f0c98a');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, horizon);
    // distant mountains
    const ridge = (base: number, amp: number, color: string, seed: number): void => {
      g.beginPath();
      g.moveTo(0, horizon);
      for (let x = 0; x <= w; x += 8) {
        const y = base - amp * (0.5 + 0.5 * Math.sin(x * 0.006 + seed) * Math.cos(x * 0.013 + seed * 2));
        g.lineTo(x, y);
      }
      g.lineTo(w, horizon);
      g.closePath();
      g.fillStyle = color;
      g.fill();
    };
    ridge(horizon - 10, hgt * 0.16, '#8f8a86', 1);
    ridge(horizon, hgt * 0.1, '#6c6a5a', 3);
    const ground = g.createLinearGradient(0, horizon, 0, hgt);
    ground.addColorStop(0, '#7d8a55');
    ground.addColorStop(1, '#4f5a32');
    g.fillStyle = ground;
    g.fillRect(0, horizon, w, hgt - horizon);
    // perspective lines
    g.strokeStyle = 'rgba(40, 50, 20, 0.25)';
    g.lineWidth = 1;
    for (let i = -12; i <= 12; i++) {
      g.beginPath();
      g.moveTo(w / 2, horizon);
      g.lineTo(w / 2 + i * w * 0.12, hgt);
      g.stroke();
    }
    // a pavilion silhouette and the hero's back
    g.fillStyle = '#3a2a22';
    g.fillRect(w * 0.12, horizon - hgt * 0.1, w * 0.1, hgt * 0.1);
    g.fillStyle = '#6a2418';
    g.beginPath();
    g.moveTo(w * 0.1, horizon - hgt * 0.1);
    g.quadraticCurveTo(w * 0.17, horizon - hgt * 0.17, w * 0.24, horizon - hgt * 0.1);
    g.fill();
    g.fillStyle = 'rgba(30, 60, 40, 0.95)';
    g.beginPath();
    g.ellipse(w * 0.46, hgt * 0.8, w * 0.05, hgt * 0.16, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#c98c5a';
    g.beginPath();
    g.arc(w * 0.46, hgt * 0.6, hgt * 0.045, 0, Math.PI * 2);
    g.fill();
  };
  paint();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(paint) : null;
  ro?.observe(container);

  const uiCbs = new Set<(key: UiKey, down: boolean) => void>();
  const evCbs = new Set<(evs: readonly GameEvent[]) => void>();
  const actions: InputAction[] = [];
  const spectate: (number | null)[] = [];
  const cleanup: (() => void)[] = [];
  const listen = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void => {
    window.addEventListener(type, fn);
    cleanup.push(() => window.removeEventListener(type, fn));
  };

  // ── input: the real controller, or a mirror of it built on the same InputState ──
  const real = opts.realInput ? new InputController(canvas) : null;
  const state = real ? real.state : new InputState();
  let locked = !real && (opts.locked ?? true);
  let touchMode = false;
  const setLocked = (on: boolean): void => {
    if (locked === on) return;
    locked = on;
    // the HUD reads isLocked() on this event, exactly as with the real pointer lock
    queueMicrotask(() => document.dispatchEvent(new Event('pointerlockchange')));
  };
  const isEditable = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  };
  if (!real) {
    const onKey = (down: boolean) => (ev: KeyboardEvent): void => {
      if (isEditable(ev.target)) return;
      const b = KEY_MAP[ev.code];
      if (b?.kind === 'ui') {
        // like InputController: UI keys are not reported while gameplay input is disabled
        if (!state.enabled || (down && ev.repeat)) return;
        if (b.key === 'scoreboard') ev.preventDefault();
        for (const cb of uiCbs) cb(b.key, down);
        return;
      }
      if (!state.enabled) return;
      if (down) state.keyDown(ev.code);
      else state.keyUp(ev.code);
    };
    listen('keydown', onKey(true));
    listen('keyup', onKey(false));
    listen('blur', () => state.releaseAll());
    const onDown = (): void => {
      if (!locked && !touchMode && state.enabled) setLocked(true);
    };
    canvas.addEventListener('mousedown', onDown);
    cleanup.push(() => canvas.removeEventListener('mousedown', onDown));
  }

  let raf = 0;
  let last = performance.now();
  const aim = { aimPoint: { x: 0, y: 0, z: 0 } };
  const loop = (now: number): void => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // sample input like the render loop does: queued actions reach the "sim" once per frame
    const frame = real ? real.sample({ pick: () => aim }) : state.frame(aim);
    if (frame.actions.length) actions.push(...frame.actions);
    view.pushInput(frame);
    view.update(dt);
    const evs = view.drainEvents();
    if (evs.length) for (const cb of evCbs) cb(evs);
  };
  raf = requestAnimationFrame(loop);

  const input: GameHandle['input'] = real ?? {
    setMove: (x, z) => state.setTouchMove(x, z),
    addLook: (dx, dy) => state.addLook(dx, dy),
    setHeld: (btn, down) => state.setTouchHeld(btn, down),
    // dropped while disabled, exactly like InputState.pushAction
    pushAction: (a) => state.pushAction(a),
    setTouchMode: (on) => {
      touchMode = on;
      if (on) setLocked(false);
    },
    onUiKey: (cb) => {
      uiCbs.add(cb);
      return () => uiCbs.delete(cb);
    },
    setEnabled: (on) => {
      state.enabled = on;
      if (!on) state.releaseAll();
    },
    requestLock: () => {
      if (!touchMode) setLocked(true);
    },
    // like InputController.exitLock: menus release the (simulated) pointer lock
    exitLock: () => setLocked(false),
    isLocked: () => locked,
  } as GameHandle['input'];

  const handle: MockGameHandle = {
    actions,
    spectate,
    realInput: !!real,
    get enabled() {
      return state.enabled;
    },
    input,
    onEvents: (cb) => {
      evCbs.add(cb);
      return () => evCbs.delete(cb);
    },
    setSpectateTarget: (id) => {
      spectate.push(id);
    },
    emitUiKey: (key, down) => {
      if (real) {
        // the real controller only reports UI keys from the keyboard
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code: UI_KEY_CODES[key] }));
        return;
      }
      for (const cb of uiCbs) cb(key, down);
    },
    simulateUnlock: () => {
      if (!real) setLocked(false);
    },
    dispose: () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      for (const c of cleanup) c();
      real?.dispose();
      canvas.remove();
    },
  };
  return handle;
}

const UI_KEY_CODES: Record<UiKey, string> = { scoreboard: 'Tab', map: 'KeyM', chat: 'Enter', menu: 'Escape', quickchat: 'KeyT' };

const portraitCache = new Map<string, string>();

/** Procedural portrait for the harness: kingdom backdrop + ink bust + name glyph. */
export function mockPortrait(heroId: string, size = 256): Promise<string> {
  const key = `${heroId}@${size}`;
  const hit = portraitCache.get(key);
  if (hit) return Promise.resolve(hit);
  const def = HERO_BY_ID[heroId];
  const c = document.createElement('canvas');
  c.width = size;
  c.height = Math.round(size * 1.4);
  const g = c.getContext('2d');
  if (!g) return Promise.resolve('');
  const W = c.width;
  const H = c.height;
  const kc = kingdomColor(def?.kingdom);
  const bg = g.createRadialGradient(W * 0.5, H * 0.35, W * 0.05, W * 0.5, H * 0.45, W * 0.9);
  bg.addColorStop(0, '#f3e2b8');
  bg.addColorStop(0.45, kc);
  bg.addColorStop(1, '#140c06');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const v = def?.visual;
  // shoulders / robe
  g.fillStyle = v?.primary ?? '#444';
  g.beginPath();
  g.moveTo(W * 0.08, H);
  g.quadraticCurveTo(W * 0.14, H * 0.62, W * 0.5, H * 0.6);
  g.quadraticCurveTo(W * 0.86, H * 0.62, W * 0.92, H);
  g.fill();
  g.fillStyle = v?.secondary ?? '#666';
  g.fillRect(W * 0.36, H * 0.62, W * 0.28, H * 0.38);
  g.fillStyle = v?.accent ?? '#d9b24a';
  g.fillRect(W * 0.36, H * 0.62, W * 0.28, H * 0.02);
  // head
  g.fillStyle = v?.face ?? v?.skin ?? '#c98c5a';
  g.beginPath();
  g.ellipse(W * 0.5, H * 0.43, W * 0.15, H * 0.13, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = v?.hair ?? '#111';
  g.beginPath();
  g.ellipse(W * 0.5, H * 0.34, W * 0.16, H * 0.07, 0, Math.PI, Math.PI * 2);
  g.fill();
  if (v?.beard && v.beard !== 'none') {
    g.beginPath();
    g.moveTo(W * 0.42, H * 0.48);
    g.quadraticCurveTo(W * 0.5, H * (v.beard === 'long' ? 0.66 : 0.56), W * 0.58, H * 0.48);
    g.fill();
  }
  // name glyph watermark
  g.fillStyle = 'rgba(255, 245, 220, 0.18)';
  g.font = `900 ${Math.round(W * 0.42)}px "STKaiti","KaiTi",serif`;
  g.textAlign = 'right';
  g.textBaseline = 'top';
  g.fillText(def?.nameZh.slice(-1) ?? '?', W * 0.98, H * 0.02);
  const url = c.toDataURL('image/png');
  portraitCache.set(key, url);
  return Promise.resolve(url);
}

export interface MockDeps extends AppDeps {
  lastGame: MockGameHandle | null;
  lastSession: MockSession | null;
  audioLog: string[];
}

export function createMockDeps(sessionOpts: MockSessionOptions = {}, gameOpts: MockGameOptions = {}): MockDeps {
  const deps: MockDeps = {
    lastGame: null,
    lastSession: null,
    audioLog: [],
    createLocalSession(name) {
      const s = new MockSession({ ...sessionOpts, name, auto: true, isHost: true });
      deps.lastSession = s;
      return s;
    },
    hostOnline(name) {
      return new Promise((resolve) => {
        setTimeout(() => {
          const s = new MockSession({ ...sessionOpts, name, auto: true, isHost: true, online: true });
          deps.lastSession = s;
          resolve(s);
        }, 700);
      });
    },
    joinOnline(code, name) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (code === 'FAIL0') {
            reject(Object.assign(new Error('Room not found'), { code: 'roomNotFound', zh: '房间不存在', en: 'Room not found' }));
            return;
          }
          const s = new MockSession({ ...sessionOpts, name, auto: true, isHost: false, online: true, roomCode: code });
          deps.lastSession = s;
          resolve(s);
        }, 700);
      });
    },
    mountGame(container: HTMLElement, view: ViewSource, _session: GameSession) {
      const h = mountMockGame(container, view, gameOpts);
      deps.lastGame = h;
      return h;
    },
    renderHeroPortrait: mockPortrait,
    audio: {
      ui: (name) => {
        deps.audioLog.push(`ui:${name}`);
      },
      music: (track) => {
        deps.audioLog.push(`music:${track}`);
      },
      unlock: async () => {
        deps.audioLog.push('unlock');
      },
    },
  };
  return deps;
}
