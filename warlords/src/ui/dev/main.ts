// UI dev harness entry (ui-dev.html). Preview any screen with mock data:
//   ?screen=title|single|online|lobby|roles|heroSelect|hud|scoreboard|map|gameOver|gallery|help|settings
//   &lang=en  &touch=1  &state=downed|dead  &role=lord|rebel|traitor|bounty|...
//   &overlay=wheel|chat|pause|controls  &lordPhase=1  &freePick=1  &host=0  &outside=1
//   &double=1 (deal a 影武者; `role=double` makes it you)
//   &weapon=<weaponId> &ads=1 (crosshair / scope preview)
//   &portraits=real (use the renderer's portrait instead of the procedural mock)
//   &real=1 (single player runs the real HostSession + sim; the 3D view stays a painted backdrop)
//   &input=real (the in-match GameHandle uses the real InputController from src/game/input.ts)
//   &locked=0 (start without the simulated pointer lock → "click to play")
//   &persist=1 (let settings changed here persist; by default the harness never writes them)
import type { RoleId } from '../../core/types';
import { settings } from '../../game/settings';
import { renderHeroPortrait } from '../../render/portrait';
import { mountApp, type MountAppOptions } from '../app';
import type { ScreenId } from '../ctx';
import { createMockDeps } from './harness';
import { MockSession, type MockHeroState } from './mock';

type HarnessScreen = ScreenId | 'hud' | 'scoreboard' | 'map' | 'settings';

const params = new URLSearchParams(location.search);
const screenParam = params.get('screen') as HarnessScreen | null;
const screen: HarnessScreen = screenParam ?? 'title';
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const touch = params.get('touch') === '1';
const state = (params.get('state') ?? 'alive') as MockHeroState;
const role = (params.get('role') ?? undefined) as RoleId | undefined;
const overlay = params.get('overlay');

// The harness shares the game's origin (same localStorage). Its URL overrides and
// anything changed while previewing stay in memory: the persisted settings are
// restored after every update so `?touch=1` / `?lang=en` never leak into the game.
if (params.get('persist') !== '1') sandboxSettingsStorage();

settings.update({
  lang,
  touchControls: touch ? 'on' : 'off',
  showFps: params.get('fps') === '1',
  playerName: settings.get().playerName || '玩家',
});

const deps = createMockDeps(
  { role, state, freePick: params.get('freePick') === '1', double: params.get('double') === '1' },
  { realInput: params.get('input') === 'real', locked: params.get('locked') !== '0' },
);
if (params.get('portraits') === 'real') deps.renderHeroPortrait = renderHeroPortrait;
if (params.get('real') === '1') {
  // real single-player stack (net HostSession + sim) behind the painted mock backdrop
  const net = await import('../../net');
  deps.createLocalSession = (name) => net.createLocalSession({ name });
}

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

// `?nowebgl=1` previews the title screen of a browser without WebGL 2
const opts: MountAppOptions = { version: 'dev', ...(params.get('nowebgl') === '1' ? { webgl: false } : {}) };
const online = params.get('online') !== '0';
const isHost = params.get('host') !== '0';
const view = { weaponId: params.get('weapon') ?? undefined, ads: params.get('ads') === '1', outside: params.get('outside') === '1' };
const newSession = (): MockSession => {
  const s = new MockSession({ name: settings.get().playerName, isHost, online: screen === 'lobby' ? true : online && screen !== 'hud', role, state, freePick: params.get('freePick') === '1', asLord: role === 'lord', double: params.get('double') === '1', view });
  deps.lastSession = s;
  return s;
};

switch (screen) {
  case 'title':
    // without ?screen= the app decides (e.g. `?room=CODE` opens the online screen)
    if (screenParam) opts.initialScreen = 'title';
    break;
  case 'single':
  case 'online':
  case 'gallery':
  case 'help':
    opts.initialScreen = screen;
    break;
  case 'settings':
    opts.initialScreen = 'title';
    opts.initialSettings = (params.get('tab') as MountAppOptions['initialSettings']) ?? 'general';
    break;
  case 'lobby': {
    const s = newSession();
    opts.initialSession = { session: s, kind: 'online' };
    s.status('已连接到房间', 'Connected to the room');
    s.sendChat('大家好！');
    break;
  }
  case 'roles': {
    const s = newSession();
    s.jumpTo('roles');
    opts.initialSession = { session: s, kind: 'online' };
    break;
  }
  case 'heroSelect': {
    const s = newSession();
    s.jumpTo('heroSelect', { lordPhase: params.get('lordPhase') === '1' });
    opts.initialSession = { session: s, kind: 'online' };
    break;
  }
  case 'loading': {
    const s = newSession();
    s.jumpTo('loading');
    opts.initialSession = { session: s, kind: 'online' };
    break;
  }
  case 'hud':
  case 'scoreboard':
  case 'map':
  case 'match': {
    const s = newSession();
    s.jumpTo('playing');
    opts.initialSession = { session: s, kind: 'single' };
    break;
  }
  case 'gameOver': {
    const s = newSession();
    s.jumpTo('gameOver');
    opts.initialSession = { session: s, kind: params.get('single') === '1' ? 'single' : 'online' };
    break;
  }
  default:
    opts.initialScreen = 'title';
}

const app = mountApp(root, deps, opts);

// open in-match overlays through the same path the input controller uses
const afterMount = (): void => {
  const g = deps.lastGame;
  if (!g) return;
  if (screen === 'scoreboard') g.emitUiKey('scoreboard', true);
  if (screen === 'map') g.emitUiKey('map', true);
  if (overlay === 'wheel') g.emitUiKey('quickchat', true);
  if (overlay === 'chat') g.emitUiKey('chat', true);
  if (overlay === 'pause') g.emitUiKey('menu', true);
  if (overlay === 'controls') {
    g.emitUiKey('menu', true);
    setTimeout(() => (document.querySelectorAll('.pm-box .sg-btn')[2] as HTMLElement | undefined)?.click(), 50);
  }
};
setTimeout(afterMount, 60);

// dev shortcuts: F8 = end match, F9 = kick to error
window.addEventListener('keydown', (ev) => {
  if (ev.code === 'F8') deps.lastSession?.finish(ev.shiftKey ? 'rebel' : 'lord');
  if (ev.code === 'F9') deps.lastSession?.fail('hostLeft', '房主已离开，房间已关闭', 'The host left — the room is closed');
});

function sandboxSettingsStorage(): void {
  const PREFIX = 'sgwl.settings';
  let store: Storage | null = null;
  try {
    store = window.localStorage;
  } catch {
    return;
  }
  if (!store) return;
  const saved = new Map<string, string>();
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(PREFIX)) saved.set(k, store.getItem(k) ?? '');
  }
  const restore = (): void => {
    try {
      for (let i = store.length - 1; i >= 0; i--) {
        const k = store.key(i);
        if (k?.startsWith(PREFIX) && !saved.has(k)) store.removeItem(k);
      }
      for (const [k, v] of saved) if (store.getItem(k) !== v) store.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  };
  // settings.update() writes synchronously before notifying subscribers
  settings.subscribe(restore);
}

declare global {
  interface Window {
    __ui?: { deps: typeof deps; app: typeof app };
  }
}
window.__ui = { deps, app };
