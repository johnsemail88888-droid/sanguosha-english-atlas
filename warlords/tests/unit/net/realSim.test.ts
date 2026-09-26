// Integration with SIM-CORE's real createMatch (loaded lazily by HostSession):
// the real snapshotFor() output must survive the binary codec and must not leak
// hidden roles. Skips (does not fail) while the real sim cannot be created.
import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { emptyInput } from '../../../src/core/types';
import { ClientSession } from '../../../src/net/clientSession';
import { peekSnapshotHeader } from '../../../src/net/codec';
import { dealRoles } from '../../../src/net/flow';
import { HostSession } from '../../../src/net/hostSession';
import { LoopbackNetwork } from '../../../src/net/loopback';
import type { Payload } from '../../../src/net/transport';
import { killHero } from '../../../src/sim/rules';
import type { World } from '../../../src/sim/world';
import { waitFor } from './fixtures';
import { receivedEvents, scanForLeaks } from './leakScan';

describe('real sim over the network layer', () => {
  it('streams real snapshots to a client without leaking hidden roles', async (ctx) => {
    const net = new LoopbackNetwork();
    const host = new HostSession({
      name: '房主',
      transport: net.createHost('host'),
      roomCode: 'REAL2',
      seed: 17,
      preferWorkerTicker: false,
      settings: { playerCount: 6, mode: 'chaos' },
      timings: { roleReveal: 0.02, lordPick: 1, pick: 1, pickReveal: 0.01, loadTimeout: 30 },
    });
    const errors: string[] = [];
    host.on('error', (e) => errors.push(`${e.code}: ${e.en}`));
    const t = await net.connect();
    const log: Payload[] = [];
    t.onMessage((_f, d) => log.push(d));
    const client = await ClientSession.connect({ transport: t, name: '客人' });
    try {
      host.on('heroSelect', (v) => v.options.length && v.picks[0] === undefined && host.pickHero(v.options[0]));
      client.on('heroSelect', (v) => v.options.length && v.picks[client.mySeat] === undefined && client.pickHero(v.options[0]));
      host.start();
      await waitFor(() => (host.phase === 'playing' && client.phase === 'playing') || errors.length > 0, 60_000, 'real match');
      if (errors.length > 0) {
        ctx.skip(`real sim unavailable: ${errors[0]}`);
        return;
      }
      // MP2-1: the human heroes start shielded in the real sim — invulnerable and untargetable
      // (bots, troops and turrets ignore them) — until their owners act; bots never are
      const world = host.simHost as unknown as World;
      const heroOf = (pid: string) => world.entityOf(pid)!;
      for (const pid of [client.myId, host.myId]) {
        expect(world.hasStatus(heroOf(pid), 'invuln')).toBe(true);
        expect(world.hasStatus(heroOf(pid), 'untargetable')).toBe(true);
      }
      for (const s of host.lobby.seats.filter((x) => x.isBot)) expect(world.hasStatus(heroOf(s.playerId), 'invuln')).toBe(false);
      const view = client.view!;
      const end = Date.now() + 1500;
      let last = performance.now();
      while (Date.now() < end) {
        const now = performance.now();
        view.pushInput({ ...emptyInput(), moveZ: 1 });
        view.update((now - last) / 1000);
        last = now;
        await new Promise((r) => setTimeout(r, 16));
      }
      expect(world.hasStatus(heroOf(client.myId), 'invuln')).toBe(false); // the guest walked
      expect(world.hasStatus(heroOf(client.myId), 'untargetable')).toBe(false);
      expect(world.hasStatus(heroOf(host.myId), 'invuln')).toBe(true); // the host player did nothing yet
      expect(view.entities().length).toBeGreaterThan(6);
      const me = view.localId();
      expect(me).not.toBeNull();
      expect(view.get(me!)?.kind).toBe('hero');
      expect(view.local()?.role).toBe(host.dealtRoles!.roles[client.mySeat]);
      expect(view.players()).toHaveLength(6);
      const seat = client.mySeat;
      expect(scanForLeaks(log, host.dealtRoles!.roles[seat], client.myId)).toEqual([]);
      const snaps = log.filter((p): p is Uint8Array => typeof p !== 'string' && p[0] === 1);
      expect(snaps.length).toBeGreaterThan(10);
      const sizes = snaps.map((b) => b.length);
      const deltas = snaps.filter((b) => peekSnapshotHeader(b).baseTick !== null).map((b) => b.length);
      const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));
      console.info(
        `[net] real sim snapshots: ${snaps.length} received (${deltas.length} deltas), full ≈ ${Math.max(...sizes)} B, delta avg ${avg(deltas)} B, ${view.entities().length} entities`,
      );
      // loot, crates and idle camps do not change: deltas are a fraction of a full snapshot
      expect(deltas.length).toBeGreaterThan(snaps.length / 2);
      expect(avg(deltas)).toBeLessThan(Math.max(...sizes) * 0.6);
    } finally {
      client.leave();
      host.leave();
    }
  }, 90_000);

  it('a bounty kill in the real sim reaches only the hunter; deaths reveal roles to everyone', async (ctx) => {
    // chaos 8p always deals a 赏金猎人; pick a seed that seats it on a client (1 or 2)
    let seed = 1;
    for (; seed < 500; seed++) {
      const d = dealRoles('chaos', 8, new Rng(seed));
      const hunter = d.roles.indexOf('bounty');
      if ((hunter === 1 || hunter === 2) && d.bountyTargets[hunter] !== undefined) break;
    }
    const net = new LoopbackNetwork();
    const host = new HostSession({
      name: '房主',
      transport: net.createHost('host'),
      roomCode: 'REAL3',
      seed,
      preferWorkerTicker: false,
      settings: { playerCount: 8, mode: 'chaos' },
      timings: { roleReveal: 0.02, lordPick: 1, pick: 1, pickReveal: 0.01, loadTimeout: 30 },
    });
    const errors: string[] = [];
    host.on('error', (e) => errors.push(`${e.code}: ${e.en}`));
    const clients: { s: ClientSession; log: Payload[] }[] = [];
    for (const name of ['甲', '乙']) {
      const t = await net.connect();
      const log: Payload[] = [];
      t.onMessage((_f, d) => log.push(d));
      const s = await ClientSession.connect({ transport: t, name });
      s.on('heroSelect', (v) => v.options.length && v.picks[s.mySeat] === undefined && s.pickHero(v.options[0]));
      clients.push({ s, log });
    }
    try {
      host.on('heroSelect', (v) => v.options.length && v.picks[0] === undefined && host.pickHero(v.options[0]));
      host.start();
      await waitFor(() => (host.phase === 'playing' && clients.every((c) => c.s.phase === 'playing')) || errors.length > 0, 60_000, 'real match');
      if (errors.length > 0) {
        ctx.skip(`real sim unavailable: ${errors[0]}`);
        return;
      }
      const deal = host.dealtRoles!;
      const hunterSeat = deal.roles.indexOf('bounty');
      const world = host.simHost as unknown as World;
      const heroAt = (seat: number) => world.heroList().find((e) => e.hero!.seat === seat)!;
      const hunter = heroAt(hunterSeat);
      const targetId = hunter.hero!.bountyTargetId!;
      expect(targetId).toBeDefined();
      const target = world.get(targetId)!;
      killHero(world, target, hunter.id, hunter.id);
      await new Promise((r) => setTimeout(r, 400)); // a few ticks: events + snapshots flow
      const hostEvents = host.view!.drainEvents();
      for (const c of clients) {
        const seat = c.s.mySeat;
        expect(scanForLeaks(c.log, deal.roles[seat], c.s.myId), `seat ${seat} (${deal.roles[seat]})`).toEqual([]);
        const evs = receivedEvents(c.log);
        expect(evs.some((e) => e.t === 'death' && e.target === targetId)).toBe(true);
        const rewards = evs.filter((e) => e.t === 'reward' && e.kind === 'bounty');
        expect(rewards, `seat ${seat}`).toHaveLength(seat === hunterSeat ? 1 : 0);
      }
      expect(hostEvents.some((e) => e.t === 'death' && e.target === targetId)).toBe(true);
      expect(hostEvents.some((e) => e.t === 'reward' && e.kind === 'bounty')).toBe(false);
    } finally {
      for (const c of clients) c.s.leave();
      host.leave();
    }
  }, 90_000);
});
