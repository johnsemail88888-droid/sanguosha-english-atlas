// Delta snapshots against acknowledged baselines: exact equivalence with full
// snapshots (up to quantization), removals / additions / static changes,
// in-place mutation safety, loss + reordering, and the bandwidth win.
import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { VF_DEAD, type Snapshot, type ViewEntity } from '../../../src/core/types';
import {
  buildMatchStrings,
  decodeSnapshotMsg,
  encodeSnapshotMsg,
  MissingBaselineError,
  peekSnapshotHeader,
  SnapshotReceiver,
  StringTable,
  type SnapshotBaseline,
} from '../../../src/net/codec';
import { emptyInput } from '../../../src/core/types';
import { bigSnapshot, FIXTURE_STRINGS, waitFor } from './fixtures';
import { addClient, cleanupHarness, drive, makeHost, runToPlaying } from './harness';
import { afterEach } from 'vitest';
import { BIN_SNAPSHOT } from '../../../src/net/protocol';

afterEach(cleanupHarness);

const table = new StringTable(buildMatchStrings(FIXTURE_STRINGS));
const byId = (s: Snapshot): Map<number, ViewEntity> => new Map(s.ents.map((e) => [e.id, e]));
const sorted = (s: Snapshot): ViewEntity[] => [...s.ents].sort((a, b) => a.id - b.id);
const clone = (s: Snapshot): Snapshot => ({ ...s, ents: s.ents.map((e) => ({ ...e })) });

/** What a full snapshot of `s` decodes to (the reference for every delta). */
const fullDecode = (s: Snapshot): Snapshot => decodeSnapshotMsg(encodeSnapshotMsg(s, table), table);

describe('delta snapshots', () => {
  it('encode only what changed and decode to exactly the full snapshot', () => {
    const a = bigSnapshot(3);
    const b = clone(a);
    b.tick = a.tick + 2;
    b.ackSeq = a.ackSeq + 2;
    // movement, damage, a flag, a new weapon, a role reveal on death, a removal and a spawn
    b.ents[0].x += 1.234;
    b.ents[1].hp -= 17;
    b.ents[2].flags |= VF_DEAD;
    b.ents[2].role = 'rebel';
    b.ents[3].weapon = 'pistol';
    b.ents[10].yaw += 0.5;
    const gone = b.ents.splice(20, 1)[0];
    b.ents.push({ ...b.ents[30], id: 9999, x: 1, z: 2 });
    const base: SnapshotBaseline = { tick: a.tick, ents: byId(a) };
    const full = encodeSnapshotMsg(b, table);
    const delta = encodeSnapshotMsg(b, table, base);
    expect(peekSnapshotHeader(delta)).toEqual({ tick: b.tick, baseTick: a.tick });
    expect(peekSnapshotHeader(full)).toEqual({ tick: b.tick, baseTick: null });
    // the receiver holds its own decoded copy of `a`
    const clientA = byId(fullDecode(a));
    const got = decodeSnapshotMsg(delta, table, (t) => (t === a.tick ? clientA : undefined));
    const want = fullDecode(b);
    expect(sorted(got)).toEqual(sorted(want));
    expect(got.ents.some((e) => e.id === gone.id)).toBe(false);
    expect({ ...got, ents: [] }).toEqual({ ...want, ents: [] });
    // 7 changed entities instead of 118: most of the payload disappears
    expect(delta.length).toBeLessThan(full.length * 0.5);
    console.info(`[net] delta: ${full.length} B full → ${delta.length} B delta (7 of ${b.ents.length} entities changed)`);
  });

  it('an unchanged world costs only the header, private view and player list', () => {
    const a = bigSnapshot(5);
    const b = clone(a);
    b.tick++;
    const delta = encodeSnapshotMsg(b, table, { tick: a.tick, ents: byId(a) });
    const noEnts = encodeSnapshotMsg({ ...b, ents: [] }, table);
    expect(delta.length).toBeLessThanOrEqual(noEnts.length + 4); // + base tick + removal count
  });

  it('never trusts an entity object shared with the baseline (a sim that updates views in place)', () => {
    const a = bigSnapshot(8);
    const base = { tick: a.tick, ents: byId(a) }; // references, like the host keeps
    const clientA = byId(fullDecode(a));
    // the "sim" mutates its view objects in place for the next tick
    const b: Snapshot = { ...a, tick: a.tick + 1, ents: a.ents };
    b.ents[0].x += 5;
    const got = decodeSnapshotMsg(encodeSnapshotMsg(b, table, base), table, () => clientA);
    expect(got.ents.find((e) => e.id === b.ents[0].id)!.x).toBeCloseTo(b.ents[0].x, 2);
  });

  it('refuses a delta whose baseline is unknown; the receiver skips it and keeps going', () => {
    const a = bigSnapshot(9);
    const b = { ...clone(a), tick: a.tick + 1 };
    const delta = encodeSnapshotMsg(b, table, { tick: a.tick, ents: byId(a) });
    expect(() => decodeSnapshotMsg(delta, table)).toThrow(MissingBaselineError);
    const rx = new SnapshotReceiver(table);
    expect(rx.receive(delta)).toBeNull();
    expect(rx.stats.missing).toBe(1);
    expect(rx.receive(encodeSnapshotMsg(a, table))!.snap.tick).toBe(a.tick);
    expect(rx.receive(delta)!.snap.tick).toBe(b.tick);
    expect(rx.newest).toBe(b.tick);
    expect(rx.stats).toEqual({ full: 1, delta: 1, missing: 1 });
  });

  it('stays exact over a long lossy, reordered stream with lagging acknowledgements', () => {
    const rng = new Rng(77);
    let world = bigSnapshot(11);
    let nextId = 5000;
    const HISTORY = 32;
    const sent = new Map<number, Map<number, ViewEntity>>(); // host side
    let ack = -1;
    const rx = new SnapshotReceiver(table);
    const inFlight: { at: number; bytes: Uint8Array; want: Snapshot }[] = [];
    const acks: { at: number; tick: number }[] = [];
    let checked = 0;
    for (let step = 0; step < 600; step++) {
      // evolve: fresh objects (like the sim), a few moves, spawns, despawns, static changes
      const next = clone(world);
      next.tick = world.tick + 1;
      for (const e of next.ents) if (rng.chance(0.25)) (e.x += rng.range(-2, 2), (e.yaw += rng.range(-1, 1)));
      if (rng.chance(0.2) && next.ents.length > 20) next.ents.splice(rng.int(0, next.ents.length - 1), 1);
      if (rng.chance(0.2)) next.ents.push({ ...next.ents[rng.int(0, next.ents.length - 1)], id: nextId++ });
      if (rng.chance(0.1)) next.ents[rng.int(0, next.ents.length - 1)].flags ^= VF_DEAD;
      world = next;
      // host: delta against the newest acknowledged snapshot still in history
      const baseEnts = ack >= 0 ? sent.get(ack) : undefined;
      const bytes = encodeSnapshotMsg(world, table, baseEnts ? { tick: ack, ents: baseEnts } : null);
      sent.set(world.tick, byId(world));
      while (sent.size > HISTORY) {
        const oldest = sent.keys().next().value as number;
        sent.delete(oldest);
        if (oldest === ack) ack = -1;
      }
      // unreliable network: 25 % loss, 0–120 ms jitter (reordering)
      if (!rng.chance(0.25)) inFlight.push({ at: step * 50 + rng.range(0, 120), bytes, want: fullDecode(world) });
      inFlight.sort((x, y) => x.at - y.at);
      while (inFlight.length && inFlight[0].at <= step * 50) {
        const m = inFlight.shift()!;
        const got = rx.receive(m.bytes);
        if (!got) continue;
        expect(sorted(got.snap)).toEqual(sorted(m.want));
        checked++;
        // the ack rides on the next input packets (also lossy)
        if (!rng.chance(0.3)) acks.push({ at: step * 50 + rng.range(20, 80), tick: rx.newest });
      }
      for (let i = acks.length - 1; i >= 0; i--) {
        if (acks[i].at <= step * 50) {
          if (acks[i].tick > ack && sent.has(acks[i].tick)) ack = acks[i].tick;
          acks.splice(i, 1);
        }
      }
    }
    expect(checked).toBeGreaterThan(350);
    expect(rx.stats.delta).toBeGreaterThan(rx.stats.full * 5); // deltas are the norm
    expect(rx.stats.missing).toBe(0); // the host only uses baselines the client confirmed
  });
});

describe('deltas through a session', () => {
  it('a lossy link still converges: the client view matches the host world', async () => {
    const h = makeHost({ seed: 13 });
    // 30 % of unreliable packets (snapshots, inputs/acks) are lost
    (h.net.opts as { unreliableLoss?: number }).unreliableLoss = 0.3;
    const a = await addClient(h, 'A');
    await runToPlaying(h);
    await drive(h, 1.2, (c) => c.session.view?.pushInput({ ...emptyInput(), moveZ: 1 }));
    const bins = a.log.filter((p): p is Uint8Array => typeof p !== 'string' && p[0] === BIN_SNAPSHOT);
    const deltas = bins.filter((b) => peekSnapshotHeader(b).baseTick !== null);
    expect(deltas.length).toBeGreaterThan(bins.length / 2);
    const sim = h.sims[0];
    await waitFor(() => (a.session.view?.entities().length ?? 0) > 0, 1000);
    const view = a.session.view!;
    expect(view.entities().length).toBe(sim.snapshotFor(a.session.myId).ents.length);
    for (const e of view.entities()) expect(sim.snapshotFor(a.session.myId).ents.some((x) => x.id === e.id)).toBe(true);
  });
});
