// The access key of a keyed relay server on the page side: the SHARE LINK / invite link
// carries it (k=…), the page stores it per server and strips it from the address bar,
// invite links made on a keyed server carry it on, and 联机检测 says "needs key".
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, settings, type NetServerConfig } from '../../../src/game/settings';
import { setOfficialServerForTests } from '../../../src/net/official';
import { KEY_REFUSED, NEEDS_KEY, probeRelay } from '../../../src/net/netCheck';
import { keyFor, withKey } from '../../../src/net/relayKey';
import { PUBLIC_WEB_URL } from '../../../src/ui/desktop';
import { captureKeyFromPage, inviteLink, keyFromPageUrl, parseInvite, relayAddressPatch } from '../../../src/ui/invite';
import { checkVerdict, formatProbe } from '../../../src/ui/netHelp';

const KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5';
const B64_KEY = 'ab+cd/efGH12ij34KL56mn==';
const MINI = 'https://mini.tail1234.ts.net';
const MINI_WS = 'wss://mini.tail1234.ts.net/ws';
const OFF = { web: `${MINI}/`, relay: MINI_WS };
const net = (over: Partial<NetServerConfig> = {}): NetServerConfig => ({ ...DEFAULT_SETTINGS.net, ...over });
const net0 = settings.get().net;

beforeEach(() => settings.update({ net: { ...net0, keys: {} } }));
afterEach(() => {
  setOfficialServerForTests(undefined);
  settings.update({ net: net0 });
});

describe('page URL parsing', () => {
  it('the SHARE LINK https://<host>/?k=… : the key is for that host’s relay; the address bar keeps nothing of it', () => {
    const got = keyFromPageUrl(`${MINI}/?k=${KEY}`, null);
    expect(got).toEqual({ origin: 'wss://mini.tail1234.ts.net', key: KEY, cleanHref: `${MINI}/` });
  });

  it('an invite with ws= and k=: the key is for the ws= relay; room / mode / ws= stay in the address', () => {
    const href = `${MINI}/?room=KX7QD&mode=ws&ws=${encodeURIComponent('wss://other.example:8443/ws')}&k=${KEY}`;
    const got = keyFromPageUrl(href, null)!;
    expect(got.origin).toBe('wss://other.example:8443');
    expect(got.key).toBe(KEY);
    const clean = new URL(got.cleanHref);
    expect(clean.searchParams.get('k')).toBeNull();
    expect(parseInvite(clean.search)).toEqual({ room: 'KX7QD', mode: 'ws', net: { wsUrl: 'wss://other.example:8443/ws' } });
  });

  it('a key pasted inside ws=: taken out of the relay address, stored as the key', () => {
    const href = `${MINI}/?room=KX7QD&mode=ws&ws=${encodeURIComponent(`${MINI_WS}?k=${KEY}`)}`;
    expect(parseInvite(new URL(href).search)).toEqual({ room: 'KX7QD', mode: 'ws', net: { wsUrl: MINI_WS }, key: KEY });
    const got = keyFromPageUrl(href, null)!;
    expect(got.origin).toBe('wss://mini.tail1234.ts.net');
    expect(got.cleanHref).not.toContain(KEY);
    expect(new URL(got.cleanHref).searchParams.get('ws')).toBe(MINI_WS);
  });

  it('GitHub Pages / the offline file (no server of their own): the key is for this build’s official relay', () => {
    expect(keyFromPageUrl(`${PUBLIC_WEB_URL}?k=${KEY}`, { web: OFF.web, relay: OFF.relay })?.origin).toBe('wss://mini.tail1234.ts.net');
    expect(keyFromPageUrl(`file:///C:/game/index.html?k=${KEY}`, { web: '', relay: OFF.relay })?.origin).toBe('wss://mini.tail1234.ts.net');
    // …and nowhere without one
    expect(keyFromPageUrl(`${PUBLIC_WEB_URL}?k=${KEY}`, null)?.origin).toBeNull();
  });

  it('a standard base64 key survives an unencoded "+"; a junk k is only stripped; no k: nothing to do', () => {
    expect(keyFromPageUrl(`${MINI}/?k=${B64_KEY}`, null)?.key).toBe(B64_KEY);
    expect(keyFromPageUrl(`${MINI}/?k=${encodeURIComponent(B64_KEY)}`, null)?.key).toBe(B64_KEY);
    expect(keyFromPageUrl(`${MINI}/?room=AB12C&k=<x>`, null)).toEqual({ origin: null, key: null, cleanHref: `${MINI}/?room=AB12C` });
    expect(keyFromPageUrl(`${MINI}/?room=AB12C`, null)).toBeNull();
    expect(keyFromPageUrl('not a url', null)).toBeNull();
  });
});

describe('captureKeyFromPage (page start)', () => {
  it('stores the key for its server (settings.net.keys, not wsUrl) and rewrites the address bar', () => {
    const calls: string[] = [];
    const env = { location: { href: `${MINI}/?room=KX7QD&k=${KEY}` }, history: { state: { a: 1 }, replaceState: (_s: unknown, _t: string, url?: string | URL | null) => void calls.push(String(url)) } };
    const wsBefore = settings.get().net.wsUrl;
    expect(captureKeyFromPage(env, null)).toBe('wss://mini.tail1234.ts.net');
    expect(settings.get().net.keys).toEqual({ 'wss://mini.tail1234.ts.net': KEY });
    expect(settings.get().net.wsUrl).toBe(wsBefore);
    expect(calls).toEqual([`${MINI}/?room=KX7QD`]);
    // a second server's key is kept next to it
    captureKeyFromPage({ location: { href: `http://192.168.1.5:8787/?k=${B64_KEY}` }, history: env.history }, null);
    expect(settings.get().net.keys).toEqual({ 'wss://mini.tail1234.ts.net': KEY, 'ws://192.168.1.5:8787': B64_KEY });
    // a newer key (rotate-key) replaces the old one
    captureKeyFromPage({ location: { href: `${MINI}/?k=${B64_KEY}` }, history: env.history }, null);
    expect(keyFor(settings.get().net.keys, MINI_WS)).toBe(B64_KEY);
  });

  it('no key in the URL: the address bar is left alone; a blocked replaceState does not throw', () => {
    let called = false;
    expect(captureKeyFromPage({ location: { href: `${MINI}/?room=KX7QD` }, history: { state: null, replaceState: () => void (called = true) } }, null)).toBeNull();
    expect(called).toBe(false);
    const throwing = { state: null, replaceState: () => { throw new Error('SecurityError'); } };
    expect(captureKeyFromPage({ location: { href: `${MINI}/?k=${KEY}` }, history: throwing }, null)).toBe('wss://mini.tail1234.ts.net');
    expect(captureKeyFromPage({}, null)).toBeNull();
  });
});

describe('invite links on a keyed server', () => {
  const keys = withKey({}, 'wss://mini.tail1234.ts.net', KEY);

  it('a relay room carries k=; parseInvite reads it back (round trip), the link stays short', () => {
    setOfficialServerForTests(OFF);
    const conn = { mode: 'ws' as const, net: net({ mode: 'ws', wsUrl: MINI_WS, keys }) };
    const link = inviteLink('KX7QD', { origin: MINI, pathname: '/' }, conn);
    expect(link.startsWith(`${MINI}/?`)).toBe(true);
    expect(link.length).toBeLessThanOrEqual(500);
    expect(parseInvite(new URL(link).search)).toEqual({ room: 'KX7QD', mode: 'ws', net: { wsUrl: MINI_WS }, key: KEY });
    // the friend's page stores it for the same server the room is on
    expect(keyFromPageUrl(link, OFF)?.origin).toBe('wss://mini.tail1234.ts.net');
    // a base64 key with '+' / '/' makes the round trip too
    const link2 = inviteLink('KX7QD', { origin: MINI, pathname: '/' }, { mode: 'ws', net: net({ mode: 'ws', wsUrl: MINI_WS, keys: withKey({}, 'wss://mini.tail1234.ts.net', B64_KEY) }) });
    expect(parseInvite(new URL(link2).search).key).toBe(B64_KEY);
  });

  it('from GitHub Pages / the desktop app (shareBase → the official page) as well', () => {
    setOfficialServerForTests(OFF);
    const conn = { mode: 'ws' as const, net: net({ mode: 'ws', wsUrl: MINI_WS, keys }) };
    const pages = inviteLink('KX7QD', { origin: new URL(PUBLIC_WEB_URL).origin, pathname: new URL(PUBLIC_WEB_URL).pathname }, conn);
    expect(pages.startsWith(OFF.web)).toBe(true);
    expect(parseInvite(new URL(pages).search).key).toBe(KEY);
    const g = globalThis as { sgwlDesktop?: unknown };
    g.sgwlDesktop = { isDesktop: true, lanUrls: ['http://192.168.1.5:8787/'], port: 8787 };
    try {
      const desk = inviteLink('KX7QD', { origin: 'http://127.0.0.1:8787', pathname: '/' }, conn);
      expect(desk.startsWith(OFF.web)).toBe(true);
      expect(parseInvite(new URL(desk).search).key).toBe(KEY);
    } finally {
      delete g.sgwlDesktop;
    }
  });

  it('the page’s own server (no ws=): its key by the page origin', () => {
    const conn = { mode: 'ws' as const, net: net({ mode: 'ws', wsUrl: '', keys }) };
    const link = inviteLink('KX7QD', { origin: MINI, pathname: '/' }, conn);
    expect(parseInvite(new URL(link).search)).toEqual({ room: 'KX7QD', mode: 'ws', net: {}, key: KEY });
  });

  it('no key: P2P rooms, other servers and keyless setups get no k=', () => {
    expect(inviteLink('KX7QD', { origin: MINI, pathname: '/' }, { mode: 'peer', net: net({ keys }) })).not.toContain('k=');
    expect(inviteLink('KX7QD', { origin: MINI, pathname: '/' }, { mode: 'ws', net: net({ mode: 'ws', wsUrl: 'ws://192.168.1.5:8787/ws', keys }) })).not.toContain('k=');
    expect(inviteLink('KX7QD', { origin: MINI, pathname: '/' }, { mode: 'ws', net: net({ mode: 'ws', wsUrl: MINI_WS }) })).not.toContain('k=');
  });
});

describe('a relay address typed in the settings', () => {
  it('a k=… in it goes to the key store; the address is saved without it', () => {
    expect(relayAddressPatch(`${MINI_WS}?k=${KEY}`, { keys: {} }, null)).toEqual({ wsUrl: MINI_WS, keys: { 'wss://mini.tail1234.ts.net': KEY } });
    expect(relayAddressPatch(`  ${MINI}/?k=${KEY}  `, { keys: {} }, null)).toEqual({ wsUrl: `${MINI}/`, keys: { 'wss://mini.tail1234.ts.net': KEY } });
    expect(relayAddressPatch(`192.168.1.5:8787?k=${KEY}`, { keys: {} }, { protocol: 'http:', host: 'x' })).toEqual({
      wsUrl: '192.168.1.5:8787/',
      keys: { 'ws://192.168.1.5:8787': KEY },
    });
    expect(relayAddressPatch(' ws://10.0.0.2:8787/ws ', { keys: {} }, null)).toEqual({ wsUrl: 'ws://10.0.0.2:8787/ws' });
  });
});

describe('联机检测 (connection check): "needs key"', () => {
  class Refused {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) {
      setTimeout(() => this.onerror?.(), 1);
    }
    close(): void {}
  }
  const Ws = Refused as unknown as new (url: string) => WebSocket;

  it('a refused socket on a server that requires a key: needs key / key refused, in both languages', async () => {
    const needs = await probeRelay(MINI_WS, 1000, Ws, async () => true);
    expect(needs).toMatchObject({ id: 'relay', ok: false, detail: NEEDS_KEY, target: 'mini.tail1234.ts.net' });
    expect(formatProbe(needs, 'zh')).toContain('需要密钥');
    expect(formatProbe(needs, 'en')).toContain('invite link');
    expect(formatProbe(needs, 'en')).not.toContain(KEY);
    const refused = await probeRelay(`${MINI_WS}?k=${KEY}`, 1000, Ws, async () => true);
    expect(refused.detail).toBe(KEY_REFUSED);
    expect(formatProbe(refused, 'zh')).toContain('新的邀请链接');
    // the row names the host, never the key
    expect(formatProbe(refused, 'zh')).not.toContain(KEY);
    // an open server that refuses: the plain error
    expect((await probeRelay(MINI_WS, 1000, Ws, async () => false)).detail).toBe('error');
    expect((await probeRelay(MINI_WS, 1000, Ws, async () => null)).detail).toBe('error');
  });

  it('the verdict says what to do', () => {
    const rows = [
      { id: 'signal' as const, ok: false, ms: 10 },
      { id: 'ice' as const, ok: false, ms: 10 },
      { id: 'relay' as const, ok: false, ms: 10, detail: NEEDS_KEY },
    ];
    expect(checkVerdict(rows).zh).toContain('房主发的邀请链接（带密钥）');
    expect(checkVerdict(rows).en).toContain('invite link');
    const p2pOk = rows.map((r) => (r.id === 'relay' ? r : { ...r, ok: true }));
    expect(checkVerdict(p2pOk).zh).toContain('公共P2P');
  });
});
