// Creating a server-run room (net/headlessRooms.ts): where POST /api/rooms is, and which
// answers make the page host the room itself (old server, no bundle, full, unreachable)
// instead of showing an error — only 429 does.
import { describe, expect, it } from 'vitest';
import { browserHostForced, classifyCreateResponse, createHeadlessRoom, roomsApiUrl } from '../../../src/net/headlessRooms';

const OWNER_KEY = 'a'.repeat(43);

describe('roomsApiUrl', () => {
  it('derives the http(s) endpoint from the relay URL', () => {
    expect(roomsApiUrl('wss://h.example.ts.net/ws')).toBe('https://h.example.ts.net/api/rooms');
    expect(roomsApiUrl('ws://192.168.1.5:8787/ws')).toBe('http://192.168.1.5:8787/api/rooms');
    expect(roomsApiUrl('ws://localhost:8787/ws/')).toBe('http://localhost:8787/api/rooms');
    expect(roomsApiUrl('ws://h:8787/')).toBe('http://h:8787/api/rooms');
    expect(roomsApiUrl('wss://h/game/ws')).toBe('https://h/game/api/rooms');
    expect(roomsApiUrl('https://h/ws')).toBeNull();
    expect(roomsApiUrl('not a url')).toBeNull();
  });
});

describe('browserHostForced', () => {
  it('is on only for ?host=browser', () => {
    expect(browserHostForced('?host=browser')).toBe(true);
    expect(browserHostForced('?room=ABCDE&host=browser')).toBe(true);
    expect(browserHostForced('?host=server')).toBe(false);
    expect(browserHostForced('')).toBe(false);
    expect(browserHostForced(undefined)).toBe(false);
  });
});

describe('classifyCreateResponse', () => {
  it('201 with a code and owner key: join it as the owner', () => {
    expect(classifyCreateResponse(201, { code: 'ABCDE', ownerKey: OWNER_KEY })).toEqual({ kind: 'created', code: 'ABCDE', ownerKey: OWNER_KEY });
    expect(classifyCreateResponse(201, { code: 'abcde', ownerKey: OWNER_KEY })).toMatchObject({ kind: 'created', code: 'ABCDE' });
  });

  it('429 is the one error the player sees', () => {
    expect(classifyCreateResponse(429, { error: 'rate-limited' })).toEqual({ kind: 'rateLimited' });
  });

  it('anything else hosts the room in the page: old server, no bundle, full, worker failed, malformed', () => {
    for (const [status, body] of [
      [404, null],
      [405, null],
      [503, { error: 'headless-unavailable' }],
      [503, { error: 'rooms-full' }],
      [500, { error: 'worker-failed' }],
      [201, { code: 'ABCDE' }],
      [201, { code: 'OOOOO', ownerKey: OWNER_KEY }],
      [201, { code: 'ABCDE', ownerKey: 'short' }],
      [201, 'nope'],
    ] as const) {
      expect(classifyCreateResponse(status, body).kind, `${status} ${JSON.stringify(body)}`).toBe('fallback');
    }
    expect(classifyCreateResponse(503, { error: 'rooms-full' })).toEqual({ kind: 'fallback', reason: 'HTTP 503 rooms-full' });
  });
});

describe('createHeadlessRoom', () => {
  it('POSTs {name, lang} as text/plain (no CORS preflight) to the endpoint next to the relay', async () => {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
    const r = await createHeadlessRoom(
      'wss://mini.example.ts.net/ws',
      { name: '甲', lang: 'zh' },
      {
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return { status: 201, json: async () => ({ code: 'QWERT', ownerKey: OWNER_KEY }) };
        },
      },
    );
    expect(r).toEqual({ kind: 'created', code: 'QWERT', ownerKey: OWNER_KEY });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://mini.example.ts.net/api/rooms');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Content-Type']).toMatch(/^text\/plain/);
    expect(JSON.parse(calls[0].init.body)).toEqual({ name: '甲', lang: 'zh' });
  });

  it('falls back on a network error, a non-JSON 404 and a timeout; 429 is rateLimited', async () => {
    const url = 'ws://127.0.0.1:8787/ws';
    expect(
      await createHeadlessRoom(url, {}, {
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ).toEqual({ kind: 'fallback', reason: 'network error: Failed to fetch' });
    expect(
      await createHeadlessRoom(url, {}, {
        fetchImpl: async () => ({
          status: 404,
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        }),
      }),
    ).toEqual({ kind: 'fallback', reason: 'HTTP 404' });
    let aborted = false;
    const t0 = Date.now();
    expect(
      await createHeadlessRoom(url, {}, {
        timeoutMs: 60,
        fetchImpl: (_u, init) =>
          new Promise((_res, rej) => {
            init.signal?.addEventListener('abort', () => {
              aborted = true;
              rej(new Error('aborted'));
            });
          }),
      }),
    ).toEqual({ kind: 'fallback', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(aborted).toBe(true);
    expect(await createHeadlessRoom(url, {}, { fetchImpl: async () => ({ status: 429, json: async () => ({ error: 'rate-limited' }) }) })).toEqual({ kind: 'rateLimited' });
    // no usable endpoint for the configured relay
    expect((await createHeadlessRoom('not a url', {}, { fetchImpl: async () => ({ status: 201, json: async () => ({}) }) })).kind).toBe('fallback');
  });
});
