// Server-run rooms (src/headless on the server): creating one over HTTP.
//
// hostOnlineSession in WebSocket mode first asks the server to run the room —
// POST /api/rooms next to the relay's /ws — and joins it as the room owner with
// the owner key it hands out. A server that cannot (an older server, no headless
// bundle, rooms full, down) makes the page host the room itself, as before; only
// "too many rooms from you right now" (429) is an error worth showing.
//
//   POST /api/rooms  {name?, lang?}  → 201 {code, ownerKey}
//                                    | 429 {error:'rate-limited'}
//                                    | 503 {error:'headless-unavailable' | 'rooms-full'}
//                                    | 500 {error:'worker-failed'}
//
// The body goes as text/plain: a "simple" CORS request, no preflight (the page may
// be served from GitHub Pages, the server is someone's Mac mini).
import { isValidRoomCode, normalizeRoomCode } from './roomCode';

/** How long the create request may take before the page hosts the room itself (ms). */
export const CREATE_ROOM_TIMEOUT_MS = 8000;

export type CreateRoomResult =
  /** the server runs the room: join `code` presenting `ownerKey` */
  | { kind: 'created'; code: string; ownerKey: string }
  /** the server cannot (network error, old server, no bundle, full…): host the room in this page */
  | { kind: 'fallback'; reason: string }
  /** the server refused another room right now (429): tell the player */
  | { kind: 'rateLimited' };

/**
 * The create-room endpoint next to a relay URL: wss://h/ws → https://h/api/rooms,
 * ws://h:8787/ws → http://h:8787/api/rooms (a relay mounted under a path keeps it:
 * wss://h/x/ws → https://h/x/api/rooms). null for anything that is not a ws(s) URL.
 */
export function roomsApiUrl(wsUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(wsUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  const base = u.pathname.replace(/\/ws\/?$/, '/').replace(/\/?$/, '/');
  return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}${base}api/rooms`;
}

/** `?host=browser` in the page URL: always host rooms in this page (debug / fallback). */
export function browserHostForced(search: string | undefined = pageSearch()): boolean {
  if (!search) return false;
  try {
    return new URLSearchParams(search).get('host') === 'browser';
  } catch {
    return false;
  }
}

function pageSearch(): string | undefined {
  return (globalThis as { location?: { search?: string } }).location?.search;
}

/** What an answer of POST /api/rooms means for the page (see CreateRoomResult). */
export function classifyCreateResponse(status: number, body: unknown): CreateRoomResult {
  if (status === 429) return { kind: 'rateLimited' };
  if (status === 201 || status === 200) {
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    const code = typeof b?.code === 'string' ? normalizeRoomCode(b.code) : null;
    const ownerKey = typeof b?.ownerKey === 'string' ? b.ownerKey : '';
    if (code && isValidRoomCode(code) && ownerKey.length >= 16 && ownerKey.length <= 128) return { kind: 'created', code, ownerKey };
    return { kind: 'fallback', reason: 'malformed answer' };
  }
  const err = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : '';
  // 404 / 405: an older server without the endpoint; 503: no headless bundle / rooms full; 5xx: the worker failed
  return { kind: 'fallback', reason: `HTTP ${status}${err ? ` ${err}` : ''}` };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface CreateRoomOptions {
  /** fetch override (tests) */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Ask the server behind relay URL `wsUrl` to run a room. Never throws. */
export async function createHeadlessRoom(
  wsUrl: string,
  body: { name?: string; lang?: 'zh' | 'en' },
  opts: CreateRoomOptions = {},
): Promise<CreateRoomResult> {
  const url = roomsApiUrl(wsUrl);
  if (!url) return { kind: 'fallback', reason: 'no http endpoint for this relay URL' };
  const f = opts.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) return { kind: 'fallback', reason: 'no fetch' };
  const Ctl = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  const ctl = Ctl ? new Ctl() : null;
  const timeoutMs = opts.timeoutMs ?? CREATE_ROOM_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      ctl?.abort();
      resolve('timeout');
    }, timeoutMs);
  });
  const request = (async (): Promise<CreateRoomResult> => {
    const res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(body),
      signal: ctl?.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON (an older server's 404 page) */
    }
    return classifyCreateResponse(res.status, json);
  })();
  try {
    const r = await Promise.race([request, timeout]);
    if (r === 'timeout') {
      request.catch(() => undefined);
      return { kind: 'fallback', reason: 'timeout' };
    }
    return r;
  } catch (e) {
    return { kind: 'fallback', reason: `network error${e instanceof Error && e.message ? `: ${e.message}` : ''}` };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
