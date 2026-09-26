// F5 / closing the tab vs. a real leave (src/main.ts pagehide): the page going
// away must keep the guest's seat token in sessionStorage, so the reloaded tab
// reclaims its seat by token — the name alone is not enough (a renamed or
// de-duplicated player, a same-named player still connected). A real leave
// (Leave button, back to the title after game over) forgets it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flatMap, waitFor } from './fixtures';
import { addClient, cleanupHarness, makeHost, runToPlaying } from './harness';
import { ClientSession } from '../../../src/net/clientSession';

/** sessionStorage of one browser tab (survives a reload of that tab). */
function tabStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

let tab: Storage;
beforeEach(() => {
  tab = tabStorage();
  vi.stubGlobal('sessionStorage', tab);
});
afterEach(() => {
  cleanupHarness();
  vi.unstubAllGlobals();
});

const ROOM = 'RLD42';
const KEY = `sgwl-seat-${ROOM}`;

describe('seat token across a reload of the same tab', () => {
  it('leave({ keepToken }) on pagehide keeps the token; the reloaded tab reclaims its seat mid-match by token', async () => {
    const h = makeHost({ seed: 12, timings: { dropGrace: 3 } });
    // another player took the name first: this tab's player is shown as "客人2"
    await addClient(h, '客人');
    const b = await addClient(h, '客人', { roomCode: ROOM });
    await runToPlaying(h);
    const seat = b.session.mySeat;
    const token = b.session.seatToken;
    expect(token).toBeTruthy();
    expect(tab.getItem(KEY)).toBe(token);
    expect(h.host.lobby.seats.find((s) => s.seat === seat)?.name).toBe('客人2');

    b.session.leave({ keepToken: true }); // pagehide (F5)
    expect(tab.getItem(KEY)).toBe(token);

    // the reloaded page: a brand-new session, same tab storage, same player name
    const t = await h.net.connect();
    const again = await ClientSession.connect({ transport: t, name: '客人', roomCode: ROOM, mapFactory: () => flatMap() });
    h.clients.push({ name: '客人', session: again, transport: t, log: [] });
    expect(again.mySeat).toBe(seat);
    expect(again.seatToken).toBe(token);
    await waitFor(() => again.phase === 'playing', 3000, 'reloaded guest playing');
    // seamless: back within the drop grace, the hero never went to a bot
    expect(h.sims[0].conversions.filter((c) => c.kind === 'bot')).toEqual([]);
    expect(h.host.lobby.seats.find((s) => s.seat === seat)).toMatchObject({ name: '客人2', isBot: false });
  });

  it('without the token that reload would be refused: the name belongs to the other, connected player', async () => {
    const h = makeHost({ seed: 12, timings: { dropGrace: 3 } });
    await addClient(h, '客人');
    const b = await addClient(h, '客人', { roomCode: ROOM });
    await runToPlaying(h);
    b.session.leave(); // a real leave forgets the token …
    expect(tab.getItem(KEY)).toBeNull();
    // … so coming back from this tab is a new player, and mid-match there is no seat for one
    await expect(addClient(h, '客人', { roomCode: ROOM })).rejects.toMatchObject({ code: 'inProgress' });
  });

  it('a real leave in the lobby forgets the token: the next join from this tab is a new seat', async () => {
    const h = makeHost({ seed: 3 });
    const a = await addClient(h, 'A', { roomCode: ROOM });
    const old = a.session.seatToken;
    expect(tab.getItem(KEY)).toBe(old);
    a.session.leave();
    expect(tab.getItem(KEY)).toBeNull();
    await waitFor(() => h.host.lobby.seats.every((s) => s.name !== 'A'), 2000, 'seat freed');
    const back = await addClient(h, 'A', { roomCode: ROOM });
    expect(back.session.seatToken).not.toBe(old);
    expect(tab.getItem(KEY)).toBe(back.session.seatToken);
  });
});
