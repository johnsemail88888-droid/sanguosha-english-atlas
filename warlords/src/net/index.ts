// Public API of the network layer (GAME_SPEC §3, §11).
//
//   createLocalSession()            single player: this client hosts in-process, bots fill every seat
//   hostOnlineSession({name,mode})  create a room (PeerJS or WebSocket relay); lobby.roomCode is set
//   joinOnlineSession(code, …)      join a room by its 5-character code
//
// All three return a GameSession (src/game/session.ts). Connection problems
// reject with a NetError carrying bilingual text (err.zh / err.en / err.code).
import type { GameSession } from '../game/session';
import { settings } from '../game/settings';
import { ClientSession, hasSeatToken, openRetryingRoomNotFound, ROOM_NOT_FOUND_RETRY_MS } from './clientSession';
import { NetError, toNetError } from './errors';
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

async function openHostTransport(mode: NetMode): Promise<{ transport: Transport; code: string }> {
  const net = settings.get().net;
  if (mode === 'ws') {
    const { WsTransport, resolveWsUrl } = await import('./wsTransport');
    const url = resolveWsUrl(net.wsUrl);
    if (!url) throw new NetError('noServerConfigured');
    const t = await WsTransport.host(url);
    return { transport: t, code: t.roomCode };
  }
  const { PeerTransport } = await import('./peerTransport');
  const t = await PeerTransport.host(net);
  return { transport: t, code: t.roomCode };
}

/** Create an online room. Resolves once the room is registered (lobby.roomCode set). */
export async function hostOnlineSession(opts: { name: string; mode: NetMode }): Promise<GameSession> {
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
      const { WsTransport, resolveWsUrl } = await import('./wsTransport');
      const url = resolveWsUrl(net.wsUrl);
      if (!url) throw new NetError('noServerConfigured');
      return await WsTransport.join(url, room);
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
  const retryMs = opts.mode === 'peer' && hasSeatToken(room) ? ROOM_NOT_FOUND_RETRY_MS : 0;
  const transport = await openRetryingRoomNotFound(() => openClientTransport(opts.mode, room), retryMs);
  try {
    return await ClientSession.connect({
      transport,
      name: playerName(opts.name),
      roomCode: room,
      reconnect: () => openClientTransport(opts.mode, room),
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
