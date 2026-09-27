import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/game/settings';
import { DEFAULT_ICE_SERVERS, iceServersFor, PEERJS_TURN, peerOptionsFor } from '../../../src/net/peerTransport';

const net = (patch: Partial<typeof DEFAULT_SETTINGS.net> = {}) => ({ ...DEFAULT_SETTINGS.net, ...patch });

describe('ICE servers', () => {
  it('always include a TURN relay (players behind strict NATs cannot connect without one)', () => {
    const turn = DEFAULT_ICE_SERVERS.filter((s) => [s.urls].flat().some((u) => u.startsWith('turn:')));
    expect(turn).toEqual([PEERJS_TURN]);
    expect(PEERJS_TURN.username).toBeTruthy();
    expect(PEERJS_TURN.credential).toBeTruthy();
    expect(peerOptionsFor(net()).config?.iceServers).toContain(PEERJS_TURN);
  });

  it('tries STUN first and the public relay last', () => {
    const list = iceServersFor(net());
    expect([list[0].urls].flat()[0]).toMatch(/^stun:/);
    expect(list[list.length - 1]).toBe(PEERJS_TURN);
  });

  it("puts the player's own TURN server before the public relay", () => {
    const list = iceServersFor(net({ turnUrl: ' turn:my.example:3478 ', turnUser: 'u', turnPass: 'p' }));
    const mine = list.findIndex((s) => s.urls === 'turn:my.example:3478');
    expect(mine).toBeGreaterThan(-1);
    expect(list[mine]).toMatchObject({ username: 'u', credential: 'p' });
    expect(mine).toBeLessThan(list.indexOf(PEERJS_TURN));
  });
});
