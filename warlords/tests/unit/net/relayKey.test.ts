// Relay access keys (RELAY_KEY on the server, src/net/relayKey.ts): parsing, the per-origin
// store, the relay / API URLs the key is added to, and — against a small keyed server in
// this process — the bilingual 'keyRequired' error instead of "cannot reach the server".
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../../../src/game/settings';
import { createHeadlessRoom, classifyCreateResponse } from '../../../src/net/headlessRooms';
import { hostOnlineSession, joinOnlineSession, NetError } from '../../../src/net';
import {
  cleanKey,
  cleanKeys,
  diagnoseRelayFailure,
  relayKeyAccepted,
  keyedRelayUrl,
  keyFor,
  MAX_KEYS,
  noteRelayAccepted,
  relayKeyRequired,
  relayOrigin,
  resetRelayAcceptedForTests,
  resolveWsUrl,
  serverHttpBase,
  splitKey,
  withKey,
  withKeyParam,
} from '../../../src/net/relayKey';
import { netErrorText } from '../../../src/net/errors';
// @ts-expect-error plain .mjs without type declarations
import { createRelay } from '../../../server/relay.mjs';

const KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5'; // 28 chars, base64
const B64_KEY = 'ab+cd/efGH12ij34KL56mn=='; // standard base64 with '+' and '/'

describe('keys', () => {
  it('cleanKey: 8–256 base64 / base64url / hex characters; a "+" that arrived as a space is put back', () => {
    expect(cleanKey(KEY)).toBe(KEY);
    expect(cleanKey(`  ${KEY}  `)).toBe(KEY);
    expect(cleanKey(B64_KEY)).toBe(B64_KEY);
    expect(cleanKey(B64_KEY.replace('+', ' '))).toBe(B64_KEY);
    // what URLSearchParams makes of an unencoded '+'
    expect(cleanKey(new URLSearchParams(`k=${B64_KEY}`).get('k'))).toBe(B64_KEY);
    expect(cleanKey('short')).toBeNull();
    expect(cleanKey('x'.repeat(257))).toBeNull();
    expect(cleanKey('bad<script>key')).toBeNull();
    expect(cleanKey('a"b\'c;d&e=f')).toBeNull();
    expect(cleanKey(undefined)).toBeNull();
    expect(cleanKey(12345678)).toBeNull();
  });

  it('relayOrigin: one origin for the page and its relay (http(s) → ws(s)), default ports dropped', () => {
    expect(relayOrigin('https://mini.tail1234.ts.net/?k=x')).toBe('wss://mini.tail1234.ts.net');
    expect(relayOrigin('wss://mini.tail1234.ts.net/ws')).toBe('wss://mini.tail1234.ts.net');
    expect(relayOrigin('wss://MINI.tail1234.ts.net:443/ws')).toBe('wss://mini.tail1234.ts.net');
    expect(relayOrigin('http://192.168.1.5:8787/')).toBe('ws://192.168.1.5:8787');
    expect(relayOrigin('ws://192.168.1.5:8787/ws?k=1')).toBe('ws://192.168.1.5:8787');
    expect(relayOrigin('192.168.1.5:8787')).toBeNull();
    expect(relayOrigin('file:///C:/game/index.html')).toBeNull();
    expect(relayOrigin('')).toBeNull();
  });

  it('the store: per server origin, migration-safe (junk from any older / hand-edited profile is dropped), bounded', () => {
    let keys = withKey(undefined, 'wss://a.example', KEY);
    keys = withKey(keys, 'ws://192.168.1.5:8787', B64_KEY);
    expect(keyFor(keys, 'wss://a.example/ws')).toBe(KEY);
    expect(keyFor(keys, 'https://a.example/')).toBe(KEY);
    expect(keyFor(keys, 'wss://a.example:443/other/ws?x=1')).toBe(KEY);
    expect(keyFor(keys, 'ws://192.168.1.5:8787/ws')).toBe(B64_KEY);
    expect(keyFor(keys, 'wss://b.example/ws')).toBeNull();
    expect(keyFor(keys, 'ws://a.example/ws')).toBeNull(); // another scheme: another server
    expect(keyFor(undefined, 'wss://a.example/ws')).toBeNull();
    expect(keyFor({ __proto__: KEY } as never, 'wss://a.example/ws')).toBeNull();
    // replacing and forgetting
    expect(keyFor(withKey(keys, 'wss://a.example', B64_KEY), 'wss://a.example/ws')).toBe(B64_KEY);
    expect(keyFor(withKey(keys, 'wss://a.example', null), 'wss://a.example/ws')).toBeNull();
    // cleanKeys: only normalised origins with valid keys
    expect(cleanKeys(keys)).toEqual(keys);
    expect(cleanKeys({ 'wss://a.example': KEY, 'wss://b.example': 'no', 'https://c.example': KEY, 'wss://D.example': KEY, junk: KEY })).toEqual({ 'wss://a.example': KEY });
    expect(cleanKeys(null)).toEqual({});
    expect(cleanKeys('wss://a.example')).toEqual({});
    expect(cleanKeys([KEY])).toEqual({});
    // bounded: the newest MAX_KEYS servers
    let many = {};
    for (let i = 0; i < MAX_KEYS + 5; i++) many = withKey(many, `wss://h${i}.example`, KEY);
    expect(Object.keys(many)).toHaveLength(MAX_KEYS);
    expect(keyFor(many, `wss://h${MAX_KEYS + 4}.example/ws`)).toBe(KEY);
    expect(keyFor(many, 'wss://h0.example/ws')).toBeNull();
  });

  it('settings load it migration-safe: an older profile without keys gets {}, a broken keys field is cleaned', async () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const had = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    try {
      const { loadSettingsForTest } = await import('../../../src/game/settings');
      store.set('sgwl.settings.v1', JSON.stringify({ lang: 'en', net: { mode: 'ws', wsUrl: 'wss://a.example/ws' } }));
      expect(loadSettingsForTest().net).toMatchObject({ mode: 'ws', wsUrl: 'wss://a.example/ws', keys: {} });
      store.set('sgwl.settings.v1', JSON.stringify({ net: { keys: { 'wss://a.example': KEY, evil: '<x>', 'wss://b.example': 42 } } }));
      expect(loadSettingsForTest().net.keys).toEqual({ 'wss://a.example': KEY });
      store.set('sgwl.settings.v1', JSON.stringify({ net: { keys: 'oops' } }));
      expect(loadSettingsForTest().net.keys).toEqual({});
    } finally {
      g.localStorage = had;
    }
  });
});

describe('URLs the key goes into', () => {
  it('the relay URL at connect time: k added, every other query parameter kept, a k in it replaced', () => {
    const keys = withKey(undefined, 'wss://mini.example', KEY);
    expect(keyedRelayUrl('wss://mini.example/ws', keys)).toBe(`wss://mini.example/ws?k=${KEY}`);
    expect(keyedRelayUrl('wss://mini.example/ws?room=1&x=y', keys)).toBe(`wss://mini.example/ws?room=1&x=y&k=${KEY}`);
    expect(keyedRelayUrl('wss://mini.example/ws?k=old&x=y', keys)).toBe(`wss://mini.example/ws?k=${KEY}&x=y`);
    // no key stored for that server: the URL as it is (a key typed into the address still reaches it)
    expect(keyedRelayUrl('wss://other.example/ws?k=typed', keys)).toBe('wss://other.example/ws?k=typed');
    expect(keyedRelayUrl('ws://192.168.1.5:8787/ws', keys)).toBe('ws://192.168.1.5:8787/ws');
    // '+' and '/' of a standard base64 key are encoded (the server decodes them back)
    const url = withKeyParam('wss://mini.example/ws', B64_KEY);
    expect(url).not.toContain('+');
    expect(new URL(url).searchParams.get('k')).toBe(B64_KEY);
    expect(withKeyParam('not a url', KEY)).toBe('not a url');
    expect(withKeyParam('wss://mini.example/ws', null)).toBe('wss://mini.example/ws');
  });

  it('resolveWsUrl keeps a configured address’s query (and still resolves the usual forms)', () => {
    expect(resolveWsUrl('wss://h.example/ws?x=1', null)).toBe('wss://h.example/ws?x=1');
    expect(resolveWsUrl('https://h.example', null)).toBe('wss://h.example/ws');
    expect(resolveWsUrl('h.example:8787', { protocol: 'https:', host: 'x' })).toBe('wss://h.example:8787/ws');
    expect(resolveWsUrl('', { protocol: 'https:', host: 'mini.example' })).toBe('wss://mini.example/ws');
  });

  it('splitKey: a key pasted into a relay address comes out of it', () => {
    expect(splitKey(`wss://mini.example/ws?k=${KEY}`)).toEqual({ url: 'wss://mini.example/ws', key: KEY });
    expect(splitKey(`https://mini.example/?k=${KEY}&x=1`)).toEqual({ url: 'https://mini.example/?x=1', key: KEY });
    expect(splitKey(`192.168.1.5:8787/ws?k=${KEY}`)).toEqual({ url: '192.168.1.5:8787/ws', key: KEY });
    expect(splitKey('wss://mini.example/ws')).toEqual({ url: 'wss://mini.example/ws', key: null });
    expect(splitKey('wss://mini.example/ws?k=<bad>')).toEqual({ url: 'wss://mini.example/ws', key: null });
    expect(splitKey('')).toEqual({ url: '', key: null });
  });

  it('/api/rooms and /sgwl.json sit next to the relay; POST /api/rooms carries ?k=', async () => {
    expect(serverHttpBase('wss://mini.example/ws?k=1')).toBe('https://mini.example/');
    expect(serverHttpBase('ws://h:8787/x/ws')).toBe('http://h:8787/x/');
    expect(serverHttpBase('https://h/ws')).toBeNull();
    const urls: string[] = [];
    await createHeadlessRoom('wss://mini.example/ws', {}, {
      key: B64_KEY,
      fetchImpl: async (url) => {
        urls.push(url);
        return { status: 503, json: async () => ({ error: 'headless-unavailable' }) };
      },
    });
    await createHeadlessRoom('wss://mini.example/ws', {}, {
      fetchImpl: async (url) => {
        urls.push(url);
        return { status: 503, json: async () => ({}) };
      },
    });
    expect(new URL(urls[0]).searchParams.get('k')).toBe(B64_KEY);
    expect(urls[0].startsWith('https://mini.example/api/rooms?k=')).toBe(true);
    expect(urls[1]).toBe('https://mini.example/api/rooms');
  });

  it('401 from /api/rooms: keyRequired (the page cannot host on that relay either), not a fallback', () => {
    expect(classifyCreateResponse(401, { error: 'key-required' })).toEqual({ kind: 'keyRequired', reason: 'key-required' });
    expect(classifyCreateResponse(401, { error: 'bad-key' })).toEqual({ kind: 'keyRequired', reason: 'bad-key' });
    expect(classifyCreateResponse(401, null)).toEqual({ kind: 'keyRequired', reason: 'HTTP 401' });
  });
});

describe('error mapping', () => {
  beforeEach(() => resetRelayAcceptedForTests());

  it('the bilingual text', () => {
    expect(netErrorText('keyRequired')).toEqual({ zh: '需要房主发的邀请链接（带密钥）', en: 'Ask the host for the invite link (it carries the key)' });
    const e = new NetError('keyRequired', 'no key');
    expect(e.zh).toBe('需要房主发的邀请链接（带密钥）');
    expect(e.toPayload().code).toBe('keyRequired');
  });

  it('relayKeyRequired reads /sgwl.json; diagnoseRelayFailure trusts a key the relay accepted before', async () => {
    const info = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });
    const url = `wss://mini.example/ws?k=${KEY}`;
    expect(await relayKeyRequired(url, { fetchImpl: info({ app: 'sanguo-warlords', keyRequired: true }) })).toBe(true);
    expect(await relayKeyRequired(url, { fetchImpl: info({ app: 'sanguo-warlords', relay: '/ws' }) })).toBe(false); // an older / open server
    expect(await relayKeyRequired(url, { fetchImpl: info({ app: 'other', keyRequired: true }) })).toBeNull();
    expect(await relayKeyRequired(url, { fetchImpl: info(null, false) })).toBeNull();
    expect(
      await relayKeyRequired(url, {
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ).toBeNull();
    const hang = (): Promise<never> => new Promise(() => undefined);
    const t0 = Date.now();
    expect(await relayKeyRequired(url, { fetchImpl: hang, timeoutMs: 50 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    const seen: string[] = [];
    await relayKeyRequired('ws://h:8787/x/ws?k=1', { fetchImpl: async (u) => (seen.push(u), { ok: true, json: async () => ({}) }) });
    expect(seen).toEqual(['http://h:8787/x/sgwl.json']);

    const needs = info({ app: 'sanguo-warlords', keyRequired: true });
    expect(await diagnoseRelayFailure(url, { fetchImpl: needs })).toBe('keyRequired');
    noteRelayAccepted(url);
    // the same key worked a minute ago: this failure is the network, not the key (rejoin keeps trying)
    expect(await diagnoseRelayFailure(url, { fetchImpl: needs })).toBeNull();
    expect(await diagnoseRelayFailure(`wss://mini.example/ws?k=${B64_KEY}`, { fetchImpl: needs })).toBe('keyRequired');
  });

  it('diagnoseRelayFailure asks the server about the key itself (GET /api/rooms?k=: 401 = refused): a right key refused for another reason is not "needs the invite link"', async () => {
    const asked: string[] = [];
    // a keyed server: /sgwl.json says so, /api/rooms checks the key before the method (405 = right key)
    const server = (right: string) => async (u: string) => {
      asked.push(u);
      if (u.endsWith('/sgwl.json')) return { ok: true, status: 200, json: async () => ({ app: 'sanguo-warlords', keyRequired: true }) };
      const k = new URL(u).searchParams.get('k');
      return k === right ? { ok: false, status: 405, json: async () => ({ error: 'method-not-allowed' }) } : { ok: false, status: 401, json: async () => ({ error: 'bad-key' }) };
    };
    // the right key, the relay refused anyway (429: too many sockets from one address)
    expect(await diagnoseRelayFailure(`wss://mini.example/ws?k=${KEY}`, { fetchImpl: server(KEY) })).toBeNull();
    expect(asked).toEqual(['https://mini.example/sgwl.json', `https://mini.example/api/rooms?k=${encodeURIComponent(KEY)}`]);
    expect(await relayKeyAccepted(`wss://mini.example/ws?k=${B64_KEY}`, B64_KEY, { fetchImpl: server(B64_KEY) })).toBe(true); // (+ / = survive)
    // a wrong / outdated key, and none at all (no second question then)
    expect(await diagnoseRelayFailure(`wss://mini.example/ws?k=${B64_KEY}`, { fetchImpl: server(KEY) })).toBe('keyRequired');
    asked.length = 0;
    expect(await diagnoseRelayFailure('wss://mini.example/ws', { fetchImpl: server(KEY) })).toBe('keyRequired');
    expect(asked).toEqual(['https://mini.example/sgwl.json']);
    // the key question unanswered (network / timeout): as before, the key is the likely cause
    const noRooms = async (u: string) => {
      if (u.endsWith('/sgwl.json')) return { ok: true, status: 200, json: async () => ({ app: 'sanguo-warlords', keyRequired: true }) };
      throw new TypeError('Failed to fetch');
    };
    expect(await diagnoseRelayFailure(`wss://mini.example/ws?k=${KEY}`, { fetchImpl: noRooms })).toBe('keyRequired');
    expect(await relayKeyAccepted(`wss://mini.example/ws?k=${KEY}`, KEY, { fetchImpl: () => new Promise(() => undefined), timeoutMs: 50 })).toBeNull();
  });
});

// ── a keyed server, end to end through the net layer ─────────────────────────

describe('a server that requires a key (hostOnlineSession / joinOnlineSession)', () => {
  let server: http.Server;
  let port = 0;
  let keyRequired = true;
  const relay = createRelay({ log: () => undefined }) as { handleUpgrade(req: http.IncomingMessage, socket: import('node:net').Socket, head: Buffer): void; close?(): void };
  const net0 = settings.get().net;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/sgwl.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ app: 'sanguo-warlords', relay: '/ws', keyRequired }));
        return;
      }
      if (u.pathname === '/api/rooms') {
        const k = u.searchParams.get('k') ?? req.headers['x-sgwl-key'];
        res.writeHead(k ? (k === KEY ? 503 : 401) : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: k ? (k === KEY ? 'headless-unavailable' : 'bad-key') : 'key-required' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.on('upgrade', (req, socket, head) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.searchParams.get('k') !== KEY) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      relay.handleUpgrade(req, socket as import('node:net').Socket, head);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    relay.close?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    keyRequired = true;
    resetRelayAcceptedForTests();
    settings.update({ net: { ...net0, mode: 'ws', wsUrl: `ws://127.0.0.1:${port}/ws`, keys: {} } });
  });

  afterEach(() => settings.update({ net: net0 }));

  const setKey = (k: string): void => settings.update({ net: { ...settings.get().net, keys: withKey({}, `ws://127.0.0.1:${port}`, k) } });

  it('no key: joining says 需要房主发的邀请链接（带密钥）, not 无法连接服务器', async () => {
    const err = await joinOnlineSession('ABCDE', { name: 'A', mode: 'ws' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetError);
    expect(err).toMatchObject({ code: 'keyRequired', zh: '需要房主发的邀请链接（带密钥）' });
    expect((err as NetError).en).toMatch(/^Ask the host for the invite link \(it carries the key\) \(no key\)$/);
  });

  it('no key: creating a room says so too (401 from /api/rooms), a wrong key as well', async () => {
    await expect(hostOnlineSession({ name: 'A', mode: 'ws' })).rejects.toMatchObject({ code: 'keyRequired' });
    setKey(B64_KEY);
    await expect(hostOnlineSession({ name: 'A', mode: 'ws' })).rejects.toMatchObject({ code: 'keyRequired', en: expect.stringContaining('key refused') });
    await expect(joinOnlineSession('ABCDE', { name: 'A', mode: 'ws' })).rejects.toMatchObject({ code: 'keyRequired', en: expect.stringContaining('key refused') });
  });

  it('the right key: the room is created on the relay (key appended at connect time only) and a guest joins it', async () => {
    setKey(KEY);
    const host = await hostOnlineSession({ name: '房主', mode: 'ws' });
    try {
      expect(host.isHost).toBe(true);
      const code = host.lobby?.roomCode ?? '';
      expect(code).toMatch(/^[A-Z0-9]{5}$/);
      // the saved address never holds the key
      expect(settings.get().net.wsUrl).toBe(`ws://127.0.0.1:${port}/ws`);
      const guest = await joinOnlineSession(code, { name: '客', mode: 'ws' });
      expect(guest.isHost).toBe(false);
      guest.leave();
    } finally {
      host.leave();
    }
  });

  it('an open server that refuses the socket is still "cannot reach the server"', async () => {
    keyRequired = false;
    await expect(joinOnlineSession('ABCDE', { name: 'A', mode: 'ws' })).rejects.toMatchObject({ code: 'serverUnreachable' });
  });
});
