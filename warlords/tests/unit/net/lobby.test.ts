// The lobby remembers what the host chose: joining humans may displace the
// host's bots or raise the player count, and leaving humans give it back.
// Join / leave / kick are logged as system chat lines; a kick bans the player
// (token and name) for the room's lifetime.
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from './fixtures';
import { addClient, cleanupHarness, makeHost, type ClientRec } from './harness';

afterEach(cleanupHarness);

describe('host lobby choices', () => {
  it('bots displaced and the count raised by joining humans come back when they leave', async () => {
    const h = makeHost({ seed: 1 });
    h.host.updateSettings({ playerCount: 5 });
    h.host.addBot();
    h.host.addBot();
    const layout = () =>
      h.host.lobby.seats.map((s) => (s.isHost ? 'H' : s.isBot ? 'bot' : s.name)).join(',') + ` /${h.host.lobby.settings.playerCount}`;
    expect(layout()).toBe('H,bot,bot /5');
    const joined: ClientRec[] = [];
    for (const n of ['A', 'B', 'C', 'D', 'E']) joined.push(await addClient(h, n));
    await waitFor(() => h.host.lobby.seats.length === 6);
    // the 3rd and 4th guest took the bots' seats, the 5th raised the count
    expect(h.host.lobby.settings.playerCount).toBe(6);
    expect(h.host.lobby.seats.filter((s) => s.isBot)).toEqual([]);
    const [a, , c, d, e] = joined;
    e.session.leave();
    await waitFor(() => h.host.lobby.settings.playerCount === 5, 2000, 'count restored');
    expect(h.host.lobby.seats.filter((s) => s.isBot)).toEqual([]); // 5 humans still fill the table
    d.session.leave();
    await waitFor(() => h.host.lobby.seats.filter((s) => s.isBot).length === 1, 2000, 'first bot back');
    c.session.leave();
    await waitFor(() => h.host.lobby.seats.filter((s) => s.isBot).length === 2, 2000, 'second bot back');
    expect(layout()).toMatch(/^H,/);
    expect(h.host.lobby.seats).toHaveLength(5);
    expect(h.host.lobby.settings.playerCount).toBe(5);
    // clients see the restored lobby too
    await waitFor(() => a.session.lobby?.seats.filter((s) => s.isBot).length === 2 && a.session.lobby.settings.playerCount === 5, 2000, 'client lobby');
  });

  it('the host lowering the count or removing a bot is a new choice, not something to restore', async () => {
    const h = makeHost({ seed: 2 });
    h.host.updateSettings({ playerCount: 6 });
    h.host.addBot();
    h.host.addBot();
    h.host.addBot();
    const bots = () => h.host.lobby.seats.filter((s) => s.isBot);
    expect(bots()).toHaveLength(3);
    h.host.removeBot(bots()[0].seat);
    expect(bots()).toHaveLength(2);
    const a = await addClient(h, 'A');
    await addClient(h, 'B');
    await waitFor(() => h.host.lobby.seats.length === 5);
    h.host.updateSettings({ playerCount: 5 });
    expect(h.host.lobby.seats).toHaveLength(5);
    expect(bots()).toHaveLength(2);
    a.session.leave();
    await waitFor(() => h.host.lobby.seats.length === 4, 2000, 'A gone');
    expect(bots()).toHaveLength(2); // still the host's two bots, nothing re-added
    expect(h.host.lobby.settings.playerCount).toBe(5);
  });

  it('after a match the lobby goes back to the host’s count and bots', async () => {
    const h = makeHost({ seed: 3, fake: { endAfterSeconds: 0.3 } });
    h.host.updateSettings({ playerCount: 5 });
    h.host.addBot();
    await addClient(h, 'A');
    await waitFor(() => h.host.lobby.seats.length === 3);
    h.host.on('heroSelect', (v) => v.options.length && v.picks[0] === undefined && h.host.pickHero(v.options[0]));
    h.clients[0].session.on('heroSelect', (v) => v.options.length && v.picks[h.clients[0].session.mySeat] === undefined && h.clients[0].session.pickHero(v.options[0]));
    h.host.start();
    await waitFor(() => h.host.phase === 'gameOver', 6000, 'game over');
    h.host.returnToLobby();
    expect(h.host.lobby.settings.playerCount).toBe(5);
    expect(h.host.lobby.seats.map((s) => (s.isHost ? 'H' : s.isBot ? 'bot' : s.name))).toEqual(['H', 'bot', 'A']);
  });
});

describe('lobby notices as system chat lines', () => {
  it('join / leave / kick reach everyone as system chat lines (zh + en)', async () => {
    const h = makeHost({ seed: 4 });
    const hostLines: { text: string; system?: boolean; en?: string }[] = [];
    h.host.on('chat', (c) => hostLines.push(c));
    const a = await addClient(h, 'A');
    const aLines: { from: string; system?: boolean; zh?: string; en?: string }[] = [];
    a.session.on('chat', (c) => aLines.push(c));
    const b = await addClient(h, 'B');
    const c = await addClient(h, 'C');
    c.session.leave();
    await waitFor(() => h.host.lobby.seats.length === 3);
    h.host.kick(b.session.mySeat);
    await waitFor(() => aLines.length >= 3, 2000, 'client system lines');
    expect(aLines.map((l) => l.en)).toEqual(['B joined the room', 'C joined the room', 'C left the room', 'B was kicked by the host'].slice(0, aLines.length));
    expect(aLines.every((l) => l.system === true && l.from === '' && !!l.zh)).toBe(true);
    await waitFor(() => aLines.length === 4, 2000, 'kick line');
    expect(hostLines.filter((l) => l.system).map((l) => l.en)).toEqual(['A joined the room', 'B joined the room', 'C joined the room', 'C left the room', 'B was kicked by the host']);
    // a player's own chat is not a system line
    a.session.sendChat('hi');
    await waitFor(() => hostLines.some((l) => l.text === 'hi'), 2000, 'chat');
    expect(hostLines.find((l) => l.text === 'hi')?.system).toBeUndefined();
  });
});

describe('kick bans', () => {
  it('a player kicked in the lobby cannot come back with its token or its name', async () => {
    const h = makeHost({ seed: 5 });
    const a = await addClient(h, '捣蛋鬼');
    const errors: string[] = [];
    a.session.on('error', (e) => errors.push(e.code));
    const token = a.session.seatToken!;
    h.host.kick(a.session.mySeat);
    await waitFor(() => errors.includes('kicked'), 2000, 'kicked');
    await expect(addClient(h, '捣蛋鬼', { token })).rejects.toMatchObject({ code: 'kicked' });
    await expect(addClient(h, '捣蛋鬼')).rejects.toMatchObject({ code: 'kicked' });
    // other players are still welcome
    const ok = await addClient(h, '好人');
    expect(ok.session.mySeat).toBeGreaterThan(0);
  });
});
