// hostOnlineSession in WebSocket mode against the real relay (server/server.mjs) with a
// server-run room behind a stand-in for POST /api/rooms (the server's side is not part of
// this test: the stand-in opens the relay room and runs src/headless in-process). The page
// joins its room as the owner; a server that cannot run rooms leaves the page hosting it;
// 429 is an error the player sees.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { settings } from '../../../src/game/settings';
import type { GameSession } from '../../../src/game/session';
import { runHeadlessRoom, type HeadlessRoom } from '../../../src/headless/worker';
import { ClientSession } from '../../../src/net/clientSession';
import { hostOnlineSession, joinOnlineSession } from '../../../src/net/index';
import { isNetError } from '../../../src/net/errors';
import { WsTransport } from '../../../src/net/wsTransport';
// @ts-expect-error plain .mjs without type declarations
import { startServer } from '../../../server/server.mjs';
import { waitFor } from './fixtures';

let srv: { port: number; close(): Promise<void>; relay: { markServerHosted(code: string): void; endRoom(code: string): void } } | null = null;
let relayUrl = '';
const rooms: HeadlessRoom[] = [];
const sessions: GameSession[] = [];
const netBefore = { ...settings.get().net };

beforeAll(async () => {
  srv = (await startServer({ port: 0, host: '127.0.0.1', distDir: '/nonexistent-sgwl-dist', peer: false, quiet: true })) as NonNullable<typeof srv>;
  relayUrl = `ws://127.0.0.1:${srv.port}/ws`;
  settings.update({ net: { ...settings.get().net, wsUrl: relayUrl } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const s of sessions.splice(0)) s.leave();
  for (const r of rooms.splice(0)) r.close('shutdown');
});

afterAll(async () => {
  settings.update({ net: netBefore });
  await srv?.close();
});

/**
 * A stand-in for the server's POST /api/rooms: answers `status`, or 201 after starting a room
 * (marked server-hosted on the relay, as server.mjs does — `attest: false` leaves that out:
 * a player's page merely claiming to be a server-run room).
 */
function stubCreateRooms(status: number | 'run', attest = true): { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (status !== 'run') return { status, json: async () => ({ error: status === 429 ? 'rate-limited' : 'headless-unavailable' }) };
    const ownerKey = `k${Math.random().toString(36).slice(2)}${'x'.repeat(40)}`;
    const transport = await WsTransport.host(relayUrl);
    const room = runHeadlessRoom({ transport, roomCode: transport.roomCode, ownerKey, post: () => undefined, exit: () => undefined });
    if (attest) srv!.relay.markServerHosted(room.code);
    rooms.push(room);
    return { status: 201, json: async () => ({ code: room.code, ownerKey }) };
  });
  return { calls };
}

describe('hostOnlineSession (WebSocket mode) with server-run rooms', () => {
  it('creates the room on the server and joins it as the owner; a guest is just a player', async () => {
    const { calls } = stubCreateRooms('run');
    const owner = await hostOnlineSession({ name: '甲', mode: 'ws' });
    sessions.push(owner);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://127.0.0.1:${srv!.port}/api/rooms`);
    expect(calls[0].body).toMatchObject({ name: '甲' });
    expect(owner).toBeInstanceOf(ClientSession);
    expect(owner.isHost).toBe(false);
    expect(owner.headless).toBe(true);
    await waitFor(() => owner.canManage === true, 3000, 'owner');
    const code = owner.lobby!.roomCode;
    expect(code).toBe(rooms[0].code);

    const guest = await joinOnlineSession(code, { name: '乙', mode: 'ws' });
    sessions.push(guest);
    await waitFor(() => guest.lobby?.seats.length === 2, 3000, 'guest seated');
    expect(guest.canManage).toBe(false);
    owner.updateSettings({ mode: 'chaos', playerCount: 6 });
    await waitFor(() => guest.lobby?.settings.mode === 'chaos' && guest.lobby.settings.playerCount === 6, 3000, 'settings reach the guest');
    // the owner leaves: the room stays, the guest owns it
    owner.leave();
    sessions.splice(sessions.indexOf(owner), 1);
    await waitFor(() => guest.canManage === true, 3000, 'guest owns the room');
    expect(rooms[0].closed).toBe(false);
  }, 30_000);

  it('a room the relay does not vouch for is not shown as server-run (a page merely claiming it in its lobby state)', async () => {
    stubCreateRooms('run', false);
    const s = await hostOnlineSession({ name: '甲', mode: 'ws' });
    sessions.push(s);
    await waitFor(() => s.lobby?.headless === true, 3000, 'lobby says headless');
    expect(s.headless).toBe(false); // no "the server runs this match — fair for everyone" note
    expect(s.canManage).toBe(false);
  }, 30_000);

  it('a server-run room that dies (its worker crashed: the relay ends it) is reported as closed at once — no rejoin loop', async () => {
    stubCreateRooms('run');
    const s = await hostOnlineSession({ name: '甲', mode: 'ws' });
    sessions.push(s);
    await waitFor(() => s.canManage === true, 3000, 'owner');
    const errors: string[] = [];
    const statuses: string[] = [];
    s.on('error', (e) => errors.push(e.code));
    s.on('status', (st) => statuses.push(st.en));
    srv!.relay.endRoom(s.lobby!.roomCode);
    await waitFor(() => errors.length > 0, 3000, 'error');
    expect(errors).toEqual(['serverClosed']);
    expect(statuses.filter((x) => /reconnecting|cannot reach/i.test(x))).toEqual([]);
  }, 30_000);

  it('a server that cannot run rooms (503, old server) leaves the page hosting the room', async () => {
    stubCreateRooms(503);
    const s = await hostOnlineSession({ name: '甲', mode: 'ws' });
    sessions.push(s);
    expect(s.isHost).toBe(true);
    expect(s.canManage).toBe(true);
    expect(s.lobby?.roomCode).toMatch(/^[A-Z0-9]{5}$/);
    expect(s.lobby?.headless).toBeUndefined();
  }, 30_000);

  it('429: the player is told to wait — nothing is hosted', async () => {
    stubCreateRooms(429);
    const err = await hostOnlineSession({ name: '甲', mode: 'ws' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isNetError(err) && err.code).toBe('rateLimited');
  }, 30_000);
});
