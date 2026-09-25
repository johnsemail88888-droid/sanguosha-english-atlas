// Playtest round-1 fixes (G1): invite links, phone defaults, settings reset,
// fire latch, 突袭 turn, hero-select auto-pick, portrait queue, short labels,
// duel indicator, notices, first-match guide.
import { afterEach, describe, expect, it } from 'vitest';
import { HEROES, ITEMS, isPassiveAbility } from '../../../src/data';
import { BTN_FIRE } from '../../../src/core/types';
import { DEFAULT_SETTINGS, defaultQuality, deviceHints, loadSettingsForTest, type NetServerConfig } from '../../../src/game/settings';
import { InputState, easeYaw, yawToward } from '../../../src/game/input';
import { overrideLang } from '../../../src/ui/i18n';
import { clearRejoin, customPeerServer, inviteLink, loadRejoin, netFor, netPatch, parseInvite, saveRejoin } from '../../../src/ui/invite';
import { inviteLink as lobbyInviteLink } from '../../../src/ui/screens/lobby';
import { isPrivateHost, resetSettings } from '../../../src/ui/screens/settings';
import { AUTO_PICK_AT, shouldAutoPick } from '../../../src/ui/screens/heroSelect';
import { PORTRAIT_SIZE, PortraitCache } from '../../../src/ui/widgets';
import { ABILITY_SHORT_EN, abilityShort, itemShort, shortEnglish, touchLabel } from '../../../src/ui/short';
import { duelState } from '../../../src/ui/hud/combat';
import { isNoticeCode, isFatalSessionError } from '../../../src/ui/app';
import { GUIDE_MATCHES, guideCount, shouldShowGuide } from '../../../src/ui/hud/guide';
import { orderLabel, TIMERLESS_STATUSES } from '../../../src/ui/hud/panels';
import { isRoomNotFound } from '../../../src/ui/screens/online';

afterEach(() => overrideLang(null));

const LOC = { origin: 'http://192.168.1.5:8787', pathname: '/' };
const net = (over: Partial<NetServerConfig> = {}): NetServerConfig => ({ ...DEFAULT_SETTINGS.net, ...over });

class MemStore {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

describe('invite links carry the connection mode (task 6)', () => {
  it('round-trips room + P2P mode on the default server', () => {
    const link = inviteLink('KX7QD', LOC, { mode: 'peer', net: net() });
    expect(link).toBe('http://192.168.1.5:8787/?room=KX7QD&mode=peer');
    expect(parseInvite(new URL(link).search)).toEqual({ room: 'KX7QD', mode: 'peer', net: {} });
  });

  it('round-trips a custom PeerJS server (host / port / path / secure)', () => {
    const cfg = net({ peerHost: '192.168.1.5', peerPort: 8787, peerPath: '/peerjs', peerSecure: false });
    const link = inviteLink('AB12C', LOC, { mode: 'peer', net: cfg });
    const got = parseInvite(new URL(link).search);
    expect(got).toEqual({ room: 'AB12C', mode: 'peer', net: { peerHost: '192.168.1.5', peerPort: 8787, peerPath: '/peerjs', peerSecure: false } });
    // applying it to fresh settings reproduces the host's server
    expect(netPatch(DEFAULT_SETTINGS.net, got.net)).toEqual({ peerHost: '192.168.1.5', peerPort: 8787, peerPath: '/peerjs', peerSecure: false });
  });

  it('round-trips a relay URL; same-origin relays need no ws= at all', () => {
    const link = inviteLink('QQ7ZZ', LOC, { mode: 'ws', net: net({ wsUrl: 'ws://10.0.0.2:8787/ws' }) });
    expect(parseInvite(new URL(link).search)).toEqual({ room: 'QQ7ZZ', mode: 'ws', net: { wsUrl: 'ws://10.0.0.2:8787/ws' } });
    expect(inviteLink('QQ7ZZ', LOC, { mode: 'ws', net: net() })).toBe('http://192.168.1.5:8787/?room=QQ7ZZ&mode=ws');
  });

  it('keeps the old room-only form (and the lobby re-export) working', () => {
    expect(inviteLink('KX7QD', LOC)).toBe('http://192.168.1.5:8787/?room=KX7QD');
    expect(lobbyInviteLink('KX7QD', LOC)).toBe(inviteLink('KX7QD', LOC));
    expect(parseInvite('?room=kx7qd')).toEqual({ room: 'KX7QD', mode: null, net: {} });
  });

  it('ignores junk parameters', () => {
    expect(parseInvite('?room=A&mode=udp&pp=99999&ws=javascript:alert(1)&ps=2')).toEqual({ room: 'A', mode: null, net: {} });
    expect(customPeerServer(DEFAULT_SETTINGS.net)).toBe(false);
    expect(netFor('peer', net())).toEqual({});
    expect(netFor('ws', net({ wsUrl: ' ws://h/ws ' }))).toEqual({ wsUrl: 'ws://h/ws' });
    expect(netPatch(net({ wsUrl: 'ws://h/ws' }), { wsUrl: 'ws://h/ws' })).toBeNull();
  });

  it('remembers how this tab joined (F5 rejoin), expires stale records', () => {
    const st = new MemStore();
    saveRejoin({ code: 'KX7QD', mode: 'peer', net: { peerHost: '127.0.0.1' } }, st);
    const r = loadRejoin(st);
    expect(r).toMatchObject({ code: 'KX7QD', mode: 'peer', net: { peerHost: '127.0.0.1' } });
    expect(loadRejoin(st, Date.now() + 31 * 60_000)).toBeNull();
    clearRejoin(st);
    expect(loadRejoin(st)).toBeNull();
    st.setItem('sgwl.rejoin.v1', '{"code":"x","mode":"peer","at":1}');
    expect(loadRejoin(st)).toBeNull();
  });

  it('recognises 房间不存在 for the switch-mode suggestion', () => {
    expect(isRoomNotFound({ code: 'roomNotFound', zh: '房间不存在', en: 'Room not found' })).toBe(true);
    expect(isRoomNotFound({ code: 'timeout' })).toBe(false);
    expect(isRoomNotFound(new Error('x'))).toBe(false);
  });
});

describe('phones default to low quality (task 10)', () => {
  it('coarse pointer or a small screen → low; desktop → medium', () => {
    expect(defaultQuality({ coarse: true, minSide: 1080 })).toBe('low');
    expect(defaultQuality({ coarse: false, minSide: 390 })).toBe('low');
    expect(defaultQuality({ coarse: false, minSide: 1080 })).toBe('medium');
    expect(defaultQuality({ coarse: false, minSide: 0 })).toBe('medium');
  });

  it('reads matchMedia / screen (mocked)', () => {
    const phone = { matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' }), screen: { width: 390, height: 844 } };
    expect(deviceHints(phone)).toEqual({ coarse: true, minSide: 390 });
    expect(defaultQuality(deviceHints(phone))).toBe('low');
    const desk = { matchMedia: () => ({ matches: false }), screen: { width: 1920, height: 1080 } };
    expect(defaultQuality(deviceHints(desk))).toBe('medium');
    expect(deviceHints({})).toEqual({ coarse: false, minSide: 0 });
  });

  it('a fresh profile on a phone gets low; a stored choice is kept', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { matchMedia: g.matchMedia, localStorage: g.localStorage };
    try {
      g.matchMedia = (q: string) => ({ matches: q === '(pointer: coarse)' });
      const st = new MemStore();
      g.localStorage = st;
      expect(loadSettingsForTest().quality).toBe('low');
      st.setItem('sgwl.settings.v1', JSON.stringify({ lang: 'en' }));
      expect(loadSettingsForTest()).toMatchObject({ quality: 'low', lang: 'en' });
      st.setItem('sgwl.settings.v1', JSON.stringify({ quality: 'high' }));
      expect(loadSettingsForTest().quality).toBe('high');
    } finally {
      g.matchMedia = saved.matchMedia;
      g.localStorage = saved.localStorage;
    }
  });
});

describe('settings (task 15)', () => {
  it('reset keeps the name and the language', () => {
    const cur = { ...structuredClone(DEFAULT_SETTINGS), playerName: '关二', lang: 'en' as const, fov: 90, musicVolume: 0.1 };
    const r = resetSettings(cur);
    expect(r.playerName).toBe('关二');
    expect(r.lang).toBe('en');
    expect(r.fov).toBe(DEFAULT_SETTINGS.fov);
    expect(r.musicVolume).toBe(DEFAULT_SETTINGS.musicVolume);
  });

  it('HTTPS/WSS goes off for localhost and private addresses only', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.5', '169.254.3.4', '::1', '[::1]', 'nas.local', 'fd12:3456::1']) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ['', 'example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '0.peerjs.com']) expect(isPrivateHost(h), h).toBe(false);
  });
});

describe('fire latch (task 13)', () => {
  it('a press and release between two frames fires exactly once', () => {
    const s = new InputState();
    s.setMouseButton('fire', true);
    s.setMouseButton('fire', false);
    expect(s.frame().buttons & BTN_FIRE).toBe(BTN_FIRE);
    expect(s.frame().buttons & BTN_FIRE).toBe(0);
  });

  it('touch taps too; a held button keeps firing; releaseAll drops a pending tap', () => {
    const s = new InputState();
    s.setTouchHeld('fire', true);
    s.setTouchHeld('fire', false);
    expect(s.frame().buttons & BTN_FIRE).toBe(BTN_FIRE);
    expect(s.frame().buttons & BTN_FIRE).toBe(0);
    s.setMouseButton('fire', true);
    expect(s.frame().buttons & BTN_FIRE).toBe(BTN_FIRE);
    expect(s.frame().buttons & BTN_FIRE).toBe(BTN_FIRE);
    s.setMouseButton('fire', false);
    expect(s.frame().buttons & BTN_FIRE).toBe(0);
    s.setMouseButton('fire', true);
    s.setMouseButton('fire', false);
    s.releaseAll();
    expect(s.frame().buttons & BTN_FIRE).toBe(0);
  });

  it('never latches while input is disabled', () => {
    const s = new InputState();
    s.enabled = false;
    s.setMouseButton('fire', true);
    s.setMouseButton('fire', false);
    s.enabled = true;
    expect(s.frame().buttons & BTN_FIRE).toBe(0);
  });
});

describe('张辽 突袭 turns the view to the target (task 22)', () => {
  it('yawToward follows the forward = (−sin yaw, −cos yaw) convention', () => {
    const f = (y: number): { x: number; z: number } => ({ x: -Math.sin(y), z: -Math.cos(y) });
    for (const y of [0, 0.7, -2, 3]) {
      const d = f(y);
      expect(Math.cos(yawToward({ x: 0, z: 0 }, { x: d.x * 5, z: d.z * 5 }) - y)).toBeCloseTo(1, 9);
    }
  });

  it('easeYaw arrives exactly at the end and takes the short way round', () => {
    let y = 3;
    let rem = 0.15;
    const want = -3; // 0.28 rad away across ±π, not 6 rad
    const steps: number[] = [];
    while (rem > 1e-6) {
      y = easeYaw(y, want, 0.05, rem);
      rem -= 0.05;
      steps.push(y);
    }
    expect(steps.length).toBe(3);
    expect(Math.cos(y - want)).toBeCloseTo(1, 9);
    // every step moved forward across π (no long way round)
    expect(Math.abs(Math.sin(steps[0]) - Math.sin(3))).toBeLessThan(0.2);
  });
});

describe('hero select auto-pick (task 5b)', () => {
  const base = { remaining: 1.2, focused: 'guanyu', userFocused: true, picked: false, options: ['guanyu', 'zhangfei', 'zhaoyun'], taken: new Set<string>() };
  it('locks the clicked card at ≤ 1.5 s', () => {
    expect(AUTO_PICK_AT).toBe(1.5);
    expect(shouldAutoPick(base)).toBe(true);
    expect(shouldAutoPick({ ...base, remaining: 1.5 })).toBe(true);
    expect(shouldAutoPick({ ...base, remaining: 1.6 })).toBe(false);
  });
  it('never for a default focus, a taken hero, or after a pick', () => {
    expect(shouldAutoPick({ ...base, userFocused: false })).toBe(false);
    expect(shouldAutoPick({ ...base, picked: true })).toBe(false);
    expect(shouldAutoPick({ ...base, taken: new Set(['guanyu']) })).toBe(false);
    expect(shouldAutoPick({ ...base, focused: 'lubu' })).toBe(false);
  });
});

describe('portrait cache (task 5d)', () => {
  it('renders each hero once at the largest size, whatever size is asked', async () => {
    const calls: [string, number | undefined][] = [];
    const c = new PortraitCache(async (id, size) => {
      calls.push([id, size]);
      return `data:${id}`;
    });
    const a = await c.get('guanyu', 128);
    const b = await c.get('guanyu', 256);
    const d = await c.get('guanyu', 192);
    expect([a, b, d]).toEqual(['data:guanyu', 'data:guanyu', 'data:guanyu']);
    expect(calls).toEqual([['guanyu', PORTRAIT_SIZE]]);
  });

  it('draws the prioritised options before earlier, lower-priority requests', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const c = new PortraitCache(async (id) => {
      order.push(id);
      if (id === 'first') await gate;
      return id;
    });
    const all = [c.get('first'), c.get('strip1'), c.get('strip2')];
    c.prioritize(['opt1', 'opt2', 'strip2']);
    all.push(c.get('opt1'), c.get('opt2'));
    expect(c.pending()).toEqual(['opt1', 'opt2', 'strip2', 'strip1']);
    release();
    await Promise.all(all);
    expect(order).toEqual(['first', 'opt1', 'opt2', 'strip2', 'strip1']);
  });

  it('a failed render resolves to "" and the queue goes on', async () => {
    const c = new PortraitCache(async (id) => {
      if (id === 'bad') throw new Error('boom');
      return id;
    });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(await Promise.all([c.get('bad'), c.get('ok')])).toEqual(['', 'ok']);
    } finally {
      console.warn = warn;
    }
  });
});

describe('English labels (tasks 14 / 16)', () => {
  it('every active ability has a short English label that fits a button', () => {
    for (const h of HEROES) {
      for (const a of h.abilities) {
        const en = abilityShort(a, 'en');
        expect(en.length, a.id).toBeGreaterThan(0);
        expect(en.length, `${a.id} → ${en}`).toBeLessThanOrEqual(10);
        expect(/[⺀-鿿]/.test(en), a.id).toBe(false);
        expect(abilityShort(a, 'zh')).toBe(a.nameZh.slice(0, 2));
        if (!isPassiveAbility(a)) expect(ABILITY_SHORT_EN[a.id], a.id).toBeDefined();
      }
    }
    expect(shortEnglish('Four Generations of Nobility')).toBe('Nobility');
  });

  it('every card has a short name in both languages', () => {
    for (const it of ITEMS) {
      const en = itemShort(it.id, 'en');
      expect(en.length, it.id).toBeLessThanOrEqual(8);
      expect(/[⺀-鿿]/.test(en), it.id).toBe(false);
      expect(itemShort(it.id, 'zh').length, it.id).toBeGreaterThan(0);
    }
    expect(itemShort('shandian', 'zh')).toBe('闪电');
    expect(itemShort('shandian', 'en')).toBe('Storm');
  });

  it('touch buttons and squad orders follow the language', () => {
    expect(touchLabel('fire', 'zh')).toBe('射');
    expect(touchLabel('fire', 'en')).toBe('Fire');
    expect(touchLabel('map', 'en')).toBe('Map');
    overrideLang('en');
    expect(['follow', 'hold', 'attack', 'charge'].map((o) => orderLabel(o as 'follow'))).toEqual(['Follow', 'Hold', 'Attack', 'Charge']);
    overrideLang('zh');
    expect(orderLabel('follow')).toBe('随');
  });
});

describe('HUD bits (tasks 18 / 19 / 20 / 21)', () => {
  it('刚烈 (thorns) shows no timer', () => {
    expect(TIMERLESS_STATUSES.has('thorns')).toBe(true);
    expect(TIMERLESS_STATUSES.has('burn')).toBe(false);
  });

  it('reads the duel from abilityState', () => {
    const me = { abilityState: { 'item:juedou:vs': 12, 'item:juedou:until': 30 } };
    expect(duelState(me, 24.5)).toEqual({ vs: 12, secs: 5.5 });
    expect(duelState(me, 30)).toBeNull();
    expect(duelState({ abilityState: {} }, 1)).toBeNull();
    expect(duelState(null, 1)).toBeNull();
  });

  it('kick / host-left are notices, not errors (still end the session)', () => {
    expect(isNoticeCode('kicked')).toBe(true);
    expect(isNoticeCode('hostLeft')).toBe(true);
    expect(isNoticeCode('connectionLost')).toBe(false);
    expect(isFatalSessionError('kicked')).toBe(true);
  });

  it('the first-match guide shows in the first two matches only', () => {
    expect(GUIDE_MATCHES).toBe(2);
    expect(shouldShowGuide(0)).toBe(true);
    expect(shouldShowGuide(1)).toBe(true);
    expect(shouldShowGuide(2)).toBe(false);
    const st = new MemStore();
    expect(guideCount(st)).toBe(0);
    st.setItem('sgwl.guide.v1', '1');
    expect(guideCount(st)).toBe(1);
    st.setItem('sgwl.guide.v1', 'junk');
    expect(guideCount(st)).toBe(0);
  });
});
