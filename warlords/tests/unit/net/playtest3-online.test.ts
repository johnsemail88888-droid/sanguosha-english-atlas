// Playtest round-3 ONLINE (ONL3) network fixes:
//  - after a long relay outage the guests' automatic rejoin outlasts the host's own
//    relay reconnect (they gave up 2 s before the host had re-created the room).
import { afterEach, describe, expect, it } from 'vitest';
import { REJOIN_WINDOW_MS, SERVER_BACK_GRACE_MS } from '../../../src/net/clientSession';
import { NetError } from '../../../src/net/errors';
import { RESUME_WINDOW_MS } from '../../../src/net/wsTransport';
import { waitFor } from './fixtures';
import { addClient, cleanupHarness, loopbackReconnect, makeHost, type ClientRec } from './harness';

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
