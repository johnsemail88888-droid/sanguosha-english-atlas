// Snapshot congestion (hostSession.ts sendSnapshots): a lagging guest keeps its
// acknowledged delta baseline until it acknowledges a newer one (never a stream of full
// snapshots), and while its acknowledgements trail by more than its round trip + 300 ms it
// gets snapshots only as it acknowledges them (plus a keep-alive) — its bandwidth drops
// instead of rising; the other guests do not notice. Measured on what the host sends.
import { afterEach, describe, expect, it } from 'vitest';
import { emptyInput } from '../../../src/core/types';
import { peekSnapshotHeader, SnapshotReceiver } from '../../../src/net/codec';
import { DELTA_HISTORY, SNAPSHOT_ACK_SLACK_MS } from '../../../src/net/hostSession';
import type { LoopbackTransport } from '../../../src/net/loopback';
import { BIN_SNAPSHOT } from '../../../src/net/protocol';
import { addClient, cleanupHarness, drive, makeHost, runToPlaying, type ClientRec, type Harness } from './harness';

afterEach(cleanupHarness);

interface Sent {
  at: number;
  to: string;
  bytes: number;
  full: boolean;
}

/** Record every snapshot the host sends (time, destination, size, full or delta). */
function meter(h: Harness): Sent[] {
  const t = (h.host as unknown as { transport: LoopbackTransport }).transport;
  const log: Sent[] = [];
  const send = t.send.bind(t);
  t.send = (to, data, channel) => {
    if (typeof data !== 'string' && data[0] === BIN_SNAPSHOT) log.push({ at: Date.now(), to, bytes: data.length, full: peekSnapshotHeader(data).baseTick === null });
    send(to, data, channel);
  };
  return log;
}

function sentTo(log: Sent[], c: ClientRec, from: number, to = Infinity): { n: number; full: number; bytes: number } {
  const xs = log.filter((s) => s.to === c.transport.selfId && s.at >= from && s.at < to);
  return { n: xs.length, full: xs.filter((s) => s.full).length, bytes: xs.reduce((a, s) => a + s.bytes, 0) };
}

const move = (c: ClientRec): void => c.session.view?.pushInput({ ...emptyInput(), moveZ: 1 });
const rx = (c: ClientRec): SnapshotReceiver['stats'] => (c.session as unknown as { snapshots: SnapshotReceiver }).snapshots.stats;
type PeerState = { snapAck: number; sinceAck: number; sent: Map<number, unknown>; snapsHeld: number };
const peerOf = (h: Harness, c: ClientRec): PeerState => (h.host as unknown as { peers: Map<string, PeerState> }).peers.get(c.transport.selfId)!;

async function threeGuests(): Promise<{ h: Harness; log: Sent[]; a: ClientRec; b: ClientRec; c: ClientRec }> {
  // (pings every 0.2 s: the host learns a round trip within a second or two)
  const h = makeHost({ seed: 5, timings: { pingInterval: 0.2 } });
  const a = await addClient(h, 'A');
  const b = await addClient(h, 'B');
  const c = await addClient(h, 'C');
  const log = meter(h);
  await runToPlaying(h);
  await drive(h, 0.6, move);
  return { h, log, a, b, c };
}

describe('snapshot congestion control', () => {
  it('slack is 300 ms', () => {
    expect(SNAPSHOT_ACK_SLACK_MS).toBe(300);
  });

  it('a guest with 500 ms added delay: no full-snapshot fallback, its bytes/s go down, the other guests are unaffected', { timeout: 30_000 }, async () => {
    const { h, log, a, b, c } = await threeGuests();
    const fullBefore = rx(b).full;
    h.net.setLinkDelay(b.transport.selfId, 500);
    const t0 = Date.now();
    await drive(h, 1.5, move); // the delay just appeared: the host's round-trip estimate still lags behind it
    const t1 = Date.now();
    await drive(h, 1.0, move);
    const t2 = Date.now();
    await drive(h, 1.5, move); // its round trip is known now: snapshots flow at the normal rate again
    const t3 = Date.now();

    // no full snapshot for anyone once the match runs (B's acknowledged baseline is kept)
    for (const g of [a, b, c]) expect(sentTo(log, g, t0).full).toBe(0);
    expect(rx(b).full).toBe(fullBefore);
    expect(rx(b).missing).toBe(0); // every delta was against a snapshot B held
    // B's bandwidth drops while its link lags (instead of rising)
    const [aOn, bOn, cOn] = [a, b, c].map((g) => sentTo(log, g, t0, t1));
    expect(bOn.bytes).toBeLessThan(0.75 * aOn.bytes);
    expect(peerOf(h, b).snapsHeld).toBeGreaterThan(0);
    // …and comes back once the host knows its round trip
    const [aEnd, bEnd, cEnd] = [a, b, c].map((g) => sentTo(log, g, t2, t3));
    expect(bEnd.n).toBeGreaterThanOrEqual(Math.floor(0.8 * aEnd.n));
    // the others: every snapshot, as if nothing happened (20 Hz)
    for (const [x, y, secs] of [[aOn, cOn, (t1 - t0) / 1000], [aEnd, cEnd, (t3 - t2) / 1000]] as const) {
      expect(Math.abs(x.n - y.n)).toBeLessThanOrEqual(2);
      expect(x.n).toBeGreaterThanOrEqual(Math.floor(0.8 * 20 * secs));
    }
    expect(peerOf(h, a).snapsHeld).toBe(0);
    expect(peerOf(h, c).snapsHeld).toBe(0);
    console.info(`[net] 500 ms delay: B ${Math.round(bOn.bytes / ((t1 - t0) / 1000))} B/s vs A ${Math.round(aOn.bytes / ((t1 - t0) / 1000))} B/s while lagging; ${bEnd.n} vs ${aEnd.n} snapshots once its round trip is known`);
  });

  it('acknowledgements 1.8 s late (a congested uplink): the acknowledged baseline outlives DELTA_HISTORY — deltas, never full snapshots', { timeout: 30_000 }, async () => {
    const { h, log, a, b } = await threeGuests();
    h.net.setLinkDelay(b.transport.selfId, 1800, 'up');
    const t0 = Date.now();
    await drive(h, 3.5, move);
    const t1 = Date.now();
    await drive(h, 1.5, move);
    const t2 = Date.now();
    // (before: its acknowledged baseline fell out of the 32-snapshot history — a full snapshot every time)
    expect(sentTo(log, b, t0).full).toBe(0);
    expect(rx(b).missing).toBe(0);
    const p = peerOf(h, b);
    expect(p.snapAck).toBeGreaterThanOrEqual(0);
    expect(p.sinceAck).toBeGreaterThan(DELTA_HISTORY); // more sent since its baseline than the history holds…
    expect(p.sent.has(p.snapAck)).toBe(true); // …and the baseline is still there
    expect(p.sent.size).toBeLessThanOrEqual(DELTA_HISTORY + 1);
    // once the host knows its round trip, B gets (almost) every snapshot
    expect(sentTo(log, b, t1, t2).n).toBeGreaterThanOrEqual(Math.floor(0.8 * sentTo(log, a, t1, t2).n));
  });

  it('a stalled page (3 s): a keep-alive every round trip + 300 ms instead of a full-snapshot storm; back to normal right after', { timeout: 30_000 }, async () => {
    const { h, log, a, b, c } = await threeGuests();
    h.net.hold(b.transport.selfId);
    const t0 = Date.now();
    await drive(h, 3, move);
    const t1 = Date.now();
    h.net.release(b.transport.selfId);
    await drive(h, 0.5, move);
    const t2 = Date.now();
    await drive(h, 1.5, move);
    const t3 = Date.now();
    const stall = sentTo(log, b, t0, t1);
    const other = sentTo(log, a, t0, t1);
    expect(stall.full).toBe(0);
    expect(stall.bytes).toBeLessThan(0.4 * other.bytes);
    // not nothing: the keep-alives (a link that lost the ones in flight cannot stall for good)
    expect(stall.n).toBeGreaterThanOrEqual(Math.floor(((t1 - t0) / (SNAPSHOT_ACK_SLACK_MS + 50)) * 0.6));
    expect(sentTo(log, c, t0, t1).n).toBeGreaterThanOrEqual(other.n - 2);
    // after the stall: everything it queued decoded (deltas against its baseline), then the normal rate
    expect(rx(b).missing).toBe(0);
    expect(sentTo(log, b, t1).full).toBe(0);
    expect(sentTo(log, b, t2, t3).n).toBeGreaterThanOrEqual(Math.floor(0.85 * sentTo(log, a, t2, t3).n));
    console.info(`[net] 3 s stall: ${stall.n} snapshots (${stall.bytes} B) to the stalled guest vs ${other.n} (${other.bytes} B) to the others`);
  });
});
