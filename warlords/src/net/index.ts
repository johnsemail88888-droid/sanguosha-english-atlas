// Public API of the network layer (GAME_SPEC §3, §11).
//
//   createLocalSession()            single player: this client hosts in-process, bots fill every seat
//   hostOnlineSession({name,mode})  create a room (PeerJS or WebSocket relay); lobby.roomCode is set.
//                                   WebSocket mode: a server that can run the match itself (POST
//                                   /api/rooms, src/headless) does, and this page joins it as the room
//                                   owner (canManage); otherwise this page hosts it (?host=browser forces that)
//   joinOnlineSession(code, …)      join a room by its 5-character code
//
// A relay server may require an access key (RELAY_KEY, src/net/relayKey.ts): the page's
// stored key for that server is added to the relay URL (k=…) and to POST /api/rooms; a
// server that refuses the page for want of a (right) key says 'keyRequired'.
//
// All three return a GameSession (src/game/session.ts). Connection problems
// reject with a NetError carrying bilingual text (err.zh / err.en / err.code).
import type { GameSession } from '../game/session';
import { settings } from '../game/settings';
import { ClientSession, hasSeatToken, openRetryingRoomNotFound, ROOM_NOT_FOUND_RETRY_MS } from './clientSession';
import { NetError, toNetError } from './errors';
import { browserHostForced, createHeadlessRoom } from './headlessRooms';
import { diagnoseRelayFailure, KEY_PARAM, keyChecksSettled, keyedRelayUrl, keyFor, noteRelayAccepted } from './relayKey';
import { HostSession } from './hostSession';
import { sanitizeName } from './protocol';
import { normalizeRoomCode } from './roomCode';
import type { Transport } from './transport';

export type NetMode = 'peer' | 'ws';

function playerName(name: string | undefined): string {
  return sanitizeName(name?.trim() || settings.get().playerName || '', '主公');
}

/** Single player: host in-process with no network; every other seat is a bot. */
export function createLocalSession(opts?: { name?: string }): GameSession {
  return new HostSession({ name: playerName(opts?.name), transport: null, myId: 'local' });
}

/** The relay URL to open with the current settings (the server's stored key appended), or null. */
async function relayUrl(): Promise<string | null> {
  // (a link that brought another key than the stored one: the server's word on it first)
  await keyChecksSettled();
  const net = settings.get().net;
  const { resolveWsUrl } = await import('./wsTransport');
  const url = resolveWsUrl(net.wsUrl);
  return url ? keyedRelayUrl(url, net.keys) : null;
}

/**
 * Open a relay socket; a failure a key would explain (the server requires one: /sgwl.json)
 * rejects with 'keyRequired' instead of a generic "cannot reach the server".
 */
async function openRelay<T>(url: string, open: () => Promise<T>): Promise<T> {
  let t: T;
  try {
    t = await open();
  } catch (e) {
    if (e instanceof NetError && e.code === 'serverUnreachable' && (await diagnoseRelayFailure(url)) === 'keyRequired') {
      throw new NetError('keyRequired', new URL(url).searchParams.get(KEY_PARAM) ? 'key refused' : 'no key');
    }
    throw e;
  }
  noteRelayAccepted(url);
  return t;
}

async function openHostTransport(mode: NetMode): Promise<{ transport: Transport; code: string }> {
  const net = settings.get().net;
  if (mode === 'ws') {
    const { WsTransport } = await import('./wsTransport');
    const url = await relayUrl();
    if (!url) throw new NetError('noServerConfigured');
    const t = await openRelay(url, () => WsTransport.host(url));
    return { transport: t, code: t.roomCode };
  }
  const { PeerTransport } = await import('./peerTransport');
  const t = await PeerTransport.host(net);
  return { transport: t, code: t.roomCode };
}

/**
 * WebSocket mode: ask the server to run the room (src/headless) and join it as its owner.
 * null: the server cannot (an older server, no headless bundle, its server-run slots taken,
 * unreachable) or joining the new room failed — the page hosts the room itself. Throws only
 * 'rateLimited', 'tooManyRooms', 'serverFull' and 'keyRequired' (the server's relay would
 * refuse the page-hosted room as well).
 */
async function serverRunRoom(name: string): Promise<GameSession | null> {
  const url = await relayUrl();
  if (!url) return null; // (the page-hosted path says 未配置服务器地址)
  const lang = settings.get().lang === 'en' ? 'en' : 'zh';
  // (a key typed into the relay address itself counts too)
  const key = keyFor(settings.get().net.keys, url) ?? new URL(url).searchParams.get(KEY_PARAM);
  const r = await createHeadlessRoom(url, { name, lang }, { key });
  if (r.kind === 'rateLimited') throw new NetError('rateLimited');
  if (r.kind === 'tooManyRooms') throw new NetError('tooManyRooms');
  if (r.kind === 'serverFull') throw new NetError('serverFull');
  if (r.kind === 'keyRequired') throw new NetError('keyRequired', key ? `key refused: ${r.reason}` : r.reason);
  if (r.kind !== 'created') {
    console.info(`[net] the server does not run this room (${r.reason}) — hosting it in this page`);
    return null;
  }
  try {
    return await joinRoom(r.code, 'ws', name, r.ownerKey);
  } catch (e) {
    console.warn('[net] joining the server-run room failed — hosting it in this page instead', e);
    return null;
  }
}

/** Create an online room. Resolves once the room is registered (lobby.roomCode set). */
export async function hostOnlineSession(opts: { name: string; mode: NetMode }): Promise<GameSession> {
  if (opts.mode === 'ws' && !browserHostForced()) {
    const s = await serverRunRoom(playerName(opts.name));
    if (s) return s;
  }
  try {
    const { transport, code } = await openHostTransport(opts.mode);
    return new HostSession({ name: playerName(opts.name), transport, roomCode: code });
  } catch (e) {
    throw toNetError(e, opts.mode === 'peer' ? 'networkRestricted' : 'serverUnreachable');
  }
}

/** Open a client transport to `room` with the current server settings. */
async function openClientTransport(mode: NetMode, room: string): Promise<Transport> {
  const net = settings.get().net;
  try {
    if (mode === 'ws') {
      const { WsTransport } = await import('./wsTransport');
      const url = await relayUrl();
      if (!url) throw new NetError('noServerConfigured');
      return await openRelay(url, () => WsTransport.join(url, room));
    }
    const { PeerTransport } = await import('./peerTransport');
    return await PeerTransport.join(net, room);
  } catch (e) {
    throw toNetError(e, mode === 'peer' ? 'networkRestricted' : 'serverUnreachable');
  }
}

/**
 * Join an online room by code (accepts lowercase / pasted links). The session
 * rejoins automatically after a connection drop, and a page reload rejoins the
 * same seat (seat token kept in sessionStorage per room). A P2P reload rejoin
 * (this tab holds a seat token for the room) does not take a transient "room not
 * found" for an answer (PeerJS: the host peer is unavailable while its signalling
 * link reconnects); a code typed in for the first time does.
 */
export async function joinOnlineSession(code: string, opts: { name: string; mode: NetMode }): Promise<GameSession> {
  const room = normalizeRoomCode(code);
  if (!room) throw new NetError('invalidCode');
  return joinRoom(room, opts.mode, playerName(opts.name));
}

/** Join `room` (a valid code); `ownerKey`: the room was created on the server by this page. */
async function joinRoom(room: string, mode: NetMode, name: string, ownerKey?: string): Promise<GameSession> {
  const retryMs = mode === 'peer' && hasSeatToken(room) ? ROOM_NOT_FOUND_RETRY_MS : 0;
  const transport = await openRetryingRoomNotFound(() => openClientTransport(mode, room), retryMs);
  try {
    return await ClientSession.connect({
      transport,
      name,
      roomCode: room,
      reconnect: () => openClientTransport(mode, room),
      ownerKey,
    });
  } catch (e) {
    transport.close();
    throw toNetError(e, 'timeout');
  }
}

export { ClientSession } from './clientSession';
export type { ClientSessionOptions } from './clientSession';
export { HostSession, DEFAULT_TIMINGS, MAX_PLAYERS } from './hostSession';
export type { FlowTimings, HostSessionOptions } from './hostSession';
export { NetError, isNetError, netErrorText } from './errors';
export type { NetErrorCode } from './errors';
export { normalizeRoomCode, isValidRoomCode, generateRoomCode, ROOM_ALPHABET } from './roomCode';
export { LoopbackNetwork, LoopbackTransport } from './loopback';
export type { Transport, Channel, Payload, PeerId } from './transport';
