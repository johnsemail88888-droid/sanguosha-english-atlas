// The official online server (src/net/official.ts): the constant / build-time env,
// what online play defaults to with and without it, the settings the choices write,
// and where invite links point (GitHub Pages / desktop app → the official page).
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type NetServerConfig } from '../../../src/game/settings';
import { isOfficialRelay, isOfficialWeb, normalizeRelayUrl, normalizeWebUrl, OFFICIAL_SERVER, officialFrom, officialServer, setOfficialServerForTests } from '../../../src/net/official';
import { PUBLIC_WEB_URL, resetLanUrlsForTests, shareBase } from '../../../src/ui/desktop';
import { choiceOf, choicePatch, customRelay, defaultChoice, inviteLink, modeOfChoice, parseInvite, relayNet } from '../../../src/ui/invite';

const OFF = { web: 'https://47-242-10-3.sslip.io/', relay: 'wss://47-242-10-3.sslip.io/ws' };
const official = officialFrom(OFF)!;
const g = globalThis as { sgwlDesktop?: unknown };
const net = (over: Partial<NetServerConfig> = {}): NetServerConfig => ({ ...DEFAULT_SETTINGS.net, ...over });

function memStore(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

afterEach(() => {
  setOfficialServerForTests(undefined);
  delete g.sgwlDesktop;
  resetLanUrlsForTests();
});

describe('official server constant + build-time override', () => {
  it('ships empty: no official server, today’s behaviour', () => {
    expect(OFFICIAL_SERVER).toEqual({ web: '', relay: '' });
    expect(officialFrom(OFFICIAL_SERVER)).toBeNull();
    expect(officialFrom(OFFICIAL_SERVER, {})).toBeNull();
    // this test run has no VITE_OFFICIAL_* set
    expect(officialServer()).toBeNull();
  });

  it('the constant, normalised (https → wss, /ws added, web ends in /)', () => {
    expect(officialFrom({ web: 'https://a.example', relay: 'https://a.example' })).toEqual({ web: 'https://a.example/', relay: 'wss://a.example/ws' });
    expect(officialFrom({ web: '', relay: 'ws://127.0.0.1:8793/ws' })).toEqual({ web: '', relay: 'ws://127.0.0.1:8793/ws' });
    expect(officialFrom({ web: 'nonsense', relay: 'wss://a.example/ws' })).toEqual({ web: '', relay: 'wss://a.example/ws' });
    expect(officialFrom({ web: 'https://a.example/', relay: 'not a url' })).toBeNull();
  });

  it('VITE_OFFICIAL_RELAY / VITE_OFFICIAL_WEB override the constant (an empty relay switches it off)', () => {
    expect(officialFrom(OFFICIAL_SERVER, { VITE_OFFICIAL_RELAY: 'ws://127.0.0.1:8793/ws', VITE_OFFICIAL_WEB: 'http://127.0.0.1:8793' })).toEqual({
      relay: 'ws://127.0.0.1:8793/ws',
      web: 'http://127.0.0.1:8793/',
    });
    expect(officialFrom(OFF, { VITE_OFFICIAL_RELAY: '' })).toBeNull();
    expect(officialFrom(OFF, { VITE_OFFICIAL_WEB: '' })).toEqual({ relay: OFF.relay, web: '' });
  });

  it('recognises the official relay / page in any spelling', () => {
    expect(isOfficialRelay('wss://47-242-10-3.sslip.io/ws', official)).toBe(true);
    expect(isOfficialRelay('https://47-242-10-3.sslip.io', official)).toBe(true);
    expect(isOfficialRelay(' wss://47-242-10-3.sslip.io/ws/ ', official)).toBe(true);
    expect(isOfficialRelay('ws://192.168.1.5:8787/ws', official)).toBe(false);
    expect(isOfficialRelay('', official)).toBe(false);
    expect(isOfficialRelay('wss://47-242-10-3.sslip.io/ws', null)).toBe(false);
    expect(isOfficialWeb('https://47-242-10-3.sslip.io', official)).toBe(true);
    expect(isOfficialWeb('https://johnsemail88888-droid.github.io', official)).toBe(false);
    expect(normalizeRelayUrl('ftp://x')).toBeNull();
    expect(normalizeWebUrl('http://x.example/play?room=1#a')).toBe('http://x.example/play/');
  });
});

describe('what online play defaults to', () => {
  it('without an official server: the saved mode, exactly as before', () => {
    expect(defaultChoice({ mode: 'peer', wsUrl: '', chosen: false }, null)).toBe('peer');
    expect(defaultChoice({ mode: 'ws', wsUrl: '', chosen: false }, null)).toBe('ws');
    expect(defaultChoice({ mode: 'ws', wsUrl: 'ws://10.0.0.2:8787/ws', chosen: true }, null)).toBe('ws');
    expect(choiceOf('ws', OFF.relay, null)).toBe('ws');
  });

  it('with one: 官方服务器 for everyone who has not picked since — P2P stays selectable', () => {
    expect(defaultChoice({ mode: 'peer', wsUrl: '', chosen: false }, official)).toBe('official');
    expect(defaultChoice({ mode: 'ws', wsUrl: '', chosen: false }, official)).toBe('official');
    // a pick made on this build is respected
    expect(defaultChoice({ mode: 'peer', wsUrl: '', chosen: true }, official)).toBe('peer');
    expect(defaultChoice({ mode: 'ws', wsUrl: OFF.relay, chosen: true }, official)).toBe('official');
    // a relay of their own (LAN / self-hosted) stays theirs
    expect(defaultChoice({ mode: 'ws', wsUrl: 'ws://10.0.0.2:8787/ws', chosen: false }, official)).toBe('ws');
    expect(modeOfChoice('official')).toBe('ws');
    expect(modeOfChoice('peer')).toBe('peer');
  });

  it('the settings each choice writes (the net layer, invites and rejoin records read them)', () => {
    const store = memStore();
    // picking 官方服务器 keeps the player's own relay aside…
    expect(choicePatch('official', net({ wsUrl: 'ws://10.0.0.2:8787/ws' }), official, store)).toEqual({ mode: 'ws', wsUrl: OFF.relay });
    expect(store.data.get('sgwl.ui.customWsUrl')).toBe('ws://10.0.0.2:8787/ws');
    // …and 自建服务器 brings it back
    expect(choicePatch('ws', net({ mode: 'ws', wsUrl: OFF.relay }), official, store)).toEqual({ mode: 'ws', wsUrl: 'ws://10.0.0.2:8787/ws' });
    expect(choicePatch('ws', net({ mode: 'ws', wsUrl: OFF.relay }), official, memStore())).toEqual({ mode: 'ws', wsUrl: '' });
    expect(choicePatch('ws', net({ wsUrl: 'ws://10.0.0.9/ws' }), official, store)).toEqual({ mode: 'ws' });
    expect(choicePatch('peer', net({ mode: 'ws', wsUrl: OFF.relay }), official, store)).toEqual({ mode: 'peer' });
    expect(choiceOf('ws', OFF.relay, official)).toBe('official');
    expect(choiceOf('ws', '', official)).toBe('ws');
    expect(customRelay(OFF.relay, official)).toBe(false);
    expect(customRelay('ws://10.0.0.2:8787/ws', official)).toBe(true);
  });

  it('a relay invite / rejoin record without ws= means the page’s own server, not a relay from an earlier room', () => {
    expect(relayNet('ws', {})).toEqual({ wsUrl: '' });
    expect(relayNet('ws', { wsUrl: OFF.relay })).toEqual({ wsUrl: OFF.relay });
    expect(relayNet('peer', {})).toEqual({});
  });
});

describe('invite links with an official server', () => {
  const PAGES = { origin: 'https://johnsemail88888-droid.github.io', pathname: '/sanguosha-english-atlas/warlords/' };
  const conn = { mode: 'ws' as const, net: net({ mode: 'ws', wsUrl: OFF.relay }) };

  it('from GitHub Pages: the official page, carrying mode=ws&ws=<relay>', () => {
    setOfficialServerForTests(OFF);
    const link = inviteLink('KX7QD', PAGES, conn);
    expect(link.startsWith(`${OFF.web}?`)).toBe(true);
    const inv = parseInvite(new URL(link).search);
    expect(inv).toEqual({ room: 'KX7QD', mode: 'ws', net: { wsUrl: OFF.relay } });
    // a P2P room too (the official page is the same build)
    expect(inviteLink('KX7QD', PAGES, { mode: 'peer', net: net() }).startsWith(`${OFF.web}?`)).toBe(true);
    // the offline single file (origin "null") as well
    expect(inviteLink('KX7QD', { origin: 'null', pathname: '/C:/game/index.html' }, conn).startsWith(`${OFF.web}?`)).toBe(true);
  });

  it('from the desktop app: the official page for official / P2P rooms, the LAN address for its own server', () => {
    setOfficialServerForTests(OFF);
    g.sgwlDesktop = { isDesktop: true, lanUrls: ['http://192.168.1.5:8787/'], port: 8787 };
    const app = { origin: 'http://127.0.0.1:8787', pathname: '/' };
    expect(shareBase(app, 'ws', OFF.relay)).toBe(OFF.web);
    expect(shareBase(app, 'peer')).toBe(OFF.web);
    expect(shareBase(app, 'ws', '')).toBe('http://192.168.1.5:8787/');
    // no official page: the public page (both reach the official relay)
    setOfficialServerForTests({ relay: OFF.relay });
    expect(shareBase(app, 'ws', OFF.relay)).toBe(PUBLIC_WEB_URL);
  });

  it('from any other page (the official page itself, a LAN server, a dev server): that page', () => {
    setOfficialServerForTests(OFF);
    expect(shareBase({ origin: 'https://47-242-10-3.sslip.io', pathname: '/' }, 'ws', OFF.relay)).toBe('https://47-242-10-3.sslip.io/');
    expect(shareBase({ origin: 'http://192.168.1.5:8787', pathname: '/' }, 'ws', '')).toBe('http://192.168.1.5:8787/');
    expect(shareBase({ origin: 'http://localhost:5173', pathname: '/' }, 'ws', OFF.relay)).toBe('http://localhost:5173/');
  });

  it('a home server behind Tailscale Funnel (*.ts.net, deploy/home-host.sh) works like any other', () => {
    const TS = { web: 'https://mac-mini.tail1234.ts.net/', relay: 'wss://mac-mini.tail1234.ts.net/ws' };
    // what home-host.sh passes to vite build
    expect(officialFrom(OFFICIAL_SERVER, { VITE_OFFICIAL_WEB: TS.web, VITE_OFFICIAL_RELAY: TS.relay })).toEqual(TS);
    setOfficialServerForTests(TS);
    expect(isOfficialRelay('https://mac-mini.tail1234.ts.net')).toBe(true);
    expect(isOfficialWeb('https://mac-mini.tail1234.ts.net')).toBe(true);
    expect(choiceOf('ws', TS.relay)).toBe('official');
    // GitHub Pages invites open the Mac's page; its own page invites to itself
    expect(inviteLink('KX7QD', PAGES, { mode: 'ws', net: net({ mode: 'ws', wsUrl: TS.relay }) }).startsWith(`${TS.web}?room=KX7QD`)).toBe(true);
    expect(shareBase({ origin: 'https://mac-mini.tail1234.ts.net', pathname: '/' }, 'ws', TS.relay)).toBe(TS.web);
  });

  it('without an official server: GitHub Pages links stay on GitHub Pages', () => {
    setOfficialServerForTests(null);
    expect(inviteLink('KX7QD', PAGES, conn)).toBe(`${PAGES.origin}${PAGES.pathname}?room=KX7QD&mode=ws&ws=${encodeURIComponent(OFF.relay)}`);
  });
});
