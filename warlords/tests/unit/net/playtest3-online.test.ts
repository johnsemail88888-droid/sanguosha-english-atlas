// Playtest round-3 ONLINE (ONL3) network fixes:
//  - after a long relay outage the guests' automatic rejoin outlasts the host's own
//    relay reconnect (they gave up 2 s before the host had re-created the room);
//  - a player who is back is not told 「<own name> 重新连接」 on top of its own 已重新连接;
//  - F5 in the lobby: the seat is held for the reloading tab, no 「X 离开了房间」+「X 加入了房间」.
import { afterEach, describe, expect, it } from 'vitest';
import { REJOIN_WINDOW_MS, SERVER_BACK_GRACE_MS } from '../../../src/net/clientSession';
import { NetError } from '../../../src/net/errors';
import { RESUME_WINDOW_MS } from '../../../src/net/wsTransport';
import { waitFor } from './fixtures';
import { addClient, cleanupHarness, loopbackReconnect, makeHost, runToPlaying, type ClientRec } from './harness';
import { receivedEvents } from './leakScan';

afterEach(() => cleanupHarness());

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ONL3: a long relay outage — the guests wait for the host to re-create the room', () => {
  /**
   * The relay as a guest's rejoin attempts see it, `ms` after the drop: down (no answer) until
   * `downUntil`, then up but without the room ("room not found") until `roomBackAt`, then the
   * room is back (`roomBackAt` Infinity: the host never comes back).
   */
  function relay(h: ReturnType<typeof makeHost>, rec: () => ClientRec | undefined, downUntil: number, roomBackAt: number) {
    const real = loopbackReconnect(h, rec);
    let t0 = 0;
    const seen: string[] = [];
    const fn = async () => {
      const ms = performance.now() - t0;
      const answer = ms < downUntil ? 'serverUnreachable' : ms < roomBackAt ? 'roomNotFound' : 'ok';
      if (seen.at(-1) !== answer) seen.push(answer);
      if (answer !== 'ok') throw new NetError(answer);
      return real();
    };
    return { fn, seen, start: () => (t0 = performance.now()) };
  }

  it('the relay back after the rejoin window is nearly used up: the rejoin keeps trying for the host (no error)', async () => {
    const h = makeHost({ seed: 61 });
    let a: ClientRec | undefined;
    // window 1.2 s; the relay is down 1.0 s, then the host needs another 0.9 s to re-create the room
    const r = relay(h, () => a, 1000, 1900);
    a = await addClient(h, 'A', { reconnect: r.fn, rejoinDelaysMs: [0, 100], rejoinRetryMs: 100, rejoinWindowMs: 1200, serverBackGraceMs: 1500 });
    const errors: string[] = [];
    a.session.on('error', (e) => errors.push(e.code));
    const oldId = a.session.myId;
    r.start();
    h.net.dropClient(oldId);
    await waitFor(() => (a!.session.myId !== oldId && !a!.session.reconnecting) || errors.length > 0, 8000, 'rejoined or gave up');
    expect(errors).toEqual([]);
    expect(a.session.myId).not.toBe(oldId);
    expect(r.seen).toEqual(['serverUnreachable', 'roomNotFound', 'ok']);
  });

  it('…but a host that never comes back still ends it, one grace after the relay answered again', async () => {
    const h = makeHost({ seed: 62 });
    let a: ClientRec | undefined;
    const r = relay(h, () => a, 300, Infinity);
    a = await addClient(h, 'A', { reconnect: r.fn, rejoinDelaysMs: [0, 100], rejoinRetryMs: 100, rejoinWindowMs: 600, serverBackGraceMs: 1200 });
    const errors: string[] = [];
    a.session.on('error', (e) => errors.push(e.code));
    r.start();
    const t0 = performance.now();
    h.net.dropClient(a.session.myId);
    await waitFor(() => errors.length > 0, 8000, 'gave up');
    const took = performance.now() - t0;
    expect(errors).toEqual(['connectionLost']); // reconnectable: 重新加入 is offered
    // longer than the plain window (600 ms), about the relay's 300 ms + the 1.2 s grace
    expect(took).toBeGreaterThan(1300);
    expect(took).toBeLessThan(4000);
  });

  it('"room not found" from the start (the relay never went away) keeps the plain window', async () => {
    const h = makeHost({ seed: 63 });
    let a: ClientRec | undefined;
    const r = relay(h, () => a, 0, Infinity);
    a = await addClient(h, 'A', { reconnect: r.fn, rejoinDelaysMs: [0, 100], rejoinRetryMs: 100, rejoinWindowMs: 600, serverBackGraceMs: 5000 });
    const errors: string[] = [];
    a.session.on('error', (e) => errors.push(e.code));
    r.start();
    const t0 = performance.now();
    h.net.dropClient(a.session.myId);
    await waitFor(() => errors.length > 0, 8000, 'gave up');
    expect(errors).toEqual(['connectionLost']);
    expect(performance.now() - t0).toBeLessThan(3000);
    await sleep(10);
  });

  it('defaults: the host tries to get its room back as long as its guests keep rejoining; they wait a minute after the relay is back', () => {
    expect(RESUME_WINDOW_MS).toBeGreaterThanOrEqual(REJOIN_WINDOW_MS);
    expect(SERVER_BACK_GRACE_MS).toBe(60_000);
  });
});

describe('ONL3: 「X 重新连接」 is for the others, not for X', () => {
  it('a player back from a bot takeover: the others get the notice and the announcement, the player only its own 已重新连接', async () => {
    const h = makeHost({ seed: 64, timings: { dropGrace: 0.2 } });
    let a: ClientRec | undefined;
    a = await addClient(h, '刘玄德', { reconnect: loopbackReconnect(h, () => a), rejoinDelaysMs: [600, 300], rejoinRetryMs: 300 });
    const b = await addClient(h, 'B');
    await runToPlaying(h);
    const sim = h.sims[0];
    const aStatus: string[] = [];
    const bStatus: string[] = [];
    const hostStatus: string[] = [];
    a.session.on('status', (st) => aStatus.push(st.zh));
    b.session.on('status', (st) => bStatus.push(st.zh));
    h.host.on('status', (st) => hostStatus.push(st.zh));
    const oldId = a.session.myId;
    const aLogFrom = a.log.length;
    h.net.dropClient(oldId);
    // away longer than the drop grace: a bot takes over, then the rejoin reclaims the hero
    await waitFor(() => sim.conversions.some((c) => c.kind === 'bot'), 3000, 'bot takes over');
    await waitFor(() => a!.session.myId !== oldId && !a!.session.reconnecting && a!.session.phase === 'playing', 5000, 'back');
    await waitFor(() => bStatus.includes('刘玄德 重新连接'), 3000, 'B told');
    await waitFor(() => receivedEvents(b.log).some((e) => e.t === 'announce' && e.zh === '刘玄德 重新连接'), 3000, 'B announcement');
    await new Promise((r) => setTimeout(r, 400)); // a few more ticks: nothing late reaches A either
    expect(hostStatus).toContain('刘玄德 重新连接');
    expect(aStatus).toContain('已重新连接');
    expect(aStatus.filter((x) => x.includes('刘玄德'))).toEqual([]);
    expect(receivedEvents(a.log.slice(aLogFrom)).filter((e) => e.t === 'announce' && String(e.zh).includes('刘玄德'))).toEqual([]);
  });
});

describe('ONL3: F5 in the lobby is not a leave + a join', () => {
  type Line = { text: string; system?: boolean };
  const systemLines = (lines: Line[]) => lines.filter((l) => l.system).map((l) => l.text);

  it('a reload keeps the seat for the tab that comes back with its token: same seat, not a word in the chat', async () => {
    const h = makeHost({ seed: 65, timings: { lobbyDropGrace: 5 } });
    const a = await addClient(h, '刘玄德');
    const b = await addClient(h, 'B');
    const hostLines: Line[] = [];
    const bLines: Line[] = [];
    h.host.on('chat', (c) => hostLines.push(c));
    b.session.on('chat', (c) => bLines.push(c));
    const seat = a.session.mySeat;
    const token = a.session.seatToken!;
    const seats = h.host.lobby.seats.map((x) => `${x.seat}:${x.name}:${x.isBot}`);
    a.session.leave({ keepToken: true }); // pagehide
    await new Promise((r) => setTimeout(r, 150));
    // held: the lobby looks the same meanwhile (not a bot, not gone)
    expect(h.host.lobby.seats.map((x) => `${x.seat}:${x.name}:${x.isBot}`)).toEqual(seats);
    const back = await addClient(h, '刘玄德', { token });
    expect(back.session.mySeat).toBe(seat);
    expect(back.session.seatToken).toBe(token);
    await new Promise((r) => setTimeout(r, 150));
    expect(h.host.lobby.seats.map((x) => `${x.seat}:${x.name}:${x.isBot}`)).toEqual(seats);
    expect(systemLines(hostLines)).toEqual([]);
    expect(systemLines(bLines)).toEqual([]);
  });

  it('a link that failed in the lobby: the automatic rejoin takes the same seat back, silently', async () => {
    const h = makeHost({ seed: 66, timings: { lobbyDropGrace: 5 } });
    let a: ClientRec | undefined;
    a = await addClient(h, '刘玄德', { reconnect: loopbackReconnect(h, () => a), rejoinDelaysMs: [100] });
    const hostLines: Line[] = [];
    h.host.on('chat', (c) => hostLines.push(c));
    const seat = a.session.mySeat;
    const oldId = a.session.myId;
    h.net.dropClient(oldId);
    await waitFor(() => a!.session.myId !== oldId && !a!.session.reconnecting, 3000, 'rejoined');
    expect(a.session.mySeat).toBe(seat);
    expect(h.host.lobby.seats.filter((x) => x.name === '刘玄德')).toHaveLength(1);
    expect(systemLines(hostLines)).toEqual([]);
  });

  it('a reloading tab that never comes back: 「X 离开了房间」 once the hold is over; a real leave says it at once', async () => {
    const h = makeHost({ seed: 67, timings: { lobbyDropGrace: 0.4 } });
    const a = await addClient(h, '刘玄德');
    const c = await addClient(h, '孙仲谋');
    const hostLines: Line[] = [];
    h.host.on('chat', (l) => hostLines.push(l));
    a.session.leave({ keepToken: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(h.host.lobby.seats.some((x) => x.name === '刘玄德')).toBe(true);
    expect(systemLines(hostLines)).toEqual([]);
    await waitFor(() => !h.host.lobby.seats.some((x) => x.name === '刘玄德'), 3000, 'seat freed');
    expect(systemLines(hostLines)).toEqual(['刘玄德 离开了房间']);
    c.session.leave(); // the 离开房间 button
    await waitFor(() => systemLines(hostLines).length === 2, 1000, 'left at once');
    expect(systemLines(hostLines)[1]).toBe('孙仲谋 离开了房间');
    expect(h.host.lobby.seats.some((x) => x.name === '孙仲谋')).toBe(false);
  });

  it('the host starts while a tab is reloading: it comes back into the flow in its seat', async () => {
    const h = makeHost({ seed: 68, timings: { lobbyDropGrace: 5 } });
    const a = await addClient(h, '刘玄德');
    await addClient(h, 'B');
    const seat = a.session.mySeat;
    const token = a.session.seatToken!;
    a.session.leave({ keepToken: true });
    await new Promise((r) => setTimeout(r, 100));
    h.host.start();
    expect(h.host.phase).toBe('roles');
    const back = await addClient(h, '刘玄德', { token });
    expect(back.session.mySeat).toBe(seat);
    await waitFor(() => back.session.roles !== null, 3000, 'roles dealt to the returning tab');
    expect(back.session.roles?.yourRole).toBe(h.host.dealtRoles!.roles[seat]);
  });
});
