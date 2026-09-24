// Hidden information across a whole match: deaths reveal roles (legitimately),
// but a bounty reward or a private reveal must reach only the player it
// concerns — over the network and in the host's own LocalView.
import { afterEach, describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { VF_DEAD, VF_REVEALED, type GameEvent } from '../../../src/core/types';
import { encodeJson, encodeSnapshotMsg, StringTable, buildMatchStrings } from '../../../src/net/codec';
import { filterEventsFor, hasPrivateEvents, privateRecipient } from '../../../src/net/eventFilter';
import { dealRoles } from '../../../src/net/flow';
import { bigSnapshot, FIXTURE_STRINGS, waitFor } from './fixtures';
import { addClient, cleanupHarness, drive, makeHost, runToPlaying } from './harness';
import { receivedEvents, scanForLeaks } from './leakScan';

afterEach(cleanupHarness);

describe('eventFilter', () => {
  const bounty: GameEvent = { t: 'reward', who: 7, kind: 'bounty', items: ['tao'] };
  const rebelKill: GameEvent = { t: 'reward', who: 3, kind: 'rebelKill', items: [] };
  const reveal: GameEvent = { t: 'status', target: 4, status: 'reveal', on: true, privateTo: 9 };
  const shot: GameEvent = { t: 'shot', src: 1, weapon: 'carbine', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } };

  it('treats bounty rewards and privateTo events as private, everything else as public', () => {
    expect(privateRecipient(bounty)).toBe(7);
    expect(privateRecipient(reveal)).toBe(9);
    expect(privateRecipient(rebelKill)).toBeNull();
    expect(privateRecipient(shot)).toBeNull(); // shot.to is a position, not a recipient
    expect(hasPrivateEvents([shot, rebelKill])).toBe(false);
    expect(hasPrivateEvents([shot, bounty])).toBe(true);
  });

  it('keeps order and only delivers private events to their recipient', () => {
    const all = [shot, bounty, rebelKill, reveal];
    expect(filterEventsFor(all, null)).toEqual([shot, rebelKill]);
    expect(filterEventsFor(all, 7)).toEqual([shot, bounty, rebelKill]);
    expect(filterEventsFor(all, 9)).toEqual([shot, rebelKill, reveal]);
    expect(filterEventsFor(all, 1)).toEqual([shot, rebelKill]);
  });
});

describe('leak scanner', () => {
  it('accepts roles that are public (dead / revealed / death event / claims) and flags live hidden ones', () => {
    const table = new StringTable(buildMatchStrings(FIXTURE_STRINGS));
    const start = encodeJson({ t: 'matchStart', seats: [], mapSeed: 1, settings: {}, you: 2, strings: [...table.strings], tick: 0 });
    const snap = bigSnapshot();
    const hero = (i: number) => snap.ents.find((e) => e.kind === 'hero' && e.id === snap.players[i].entityId)!;
    // seat 6 is dead (fixture): its role is public
    hero(6).flags |= VF_DEAD;
    hero(6).role = 'rebel';
    // seat 4 is flagged revealed by the sim
    hero(4).flags |= VF_REVEALED;
    hero(4).role = 'traitor';
    const clean = [start, encodeSnapshotMsg(snap, table)];
    expect(scanForLeaks(clean, 'loyalist', 'peer-1')).toEqual([]);

    const death = encodeJson({ t: 'events', tick: 5, events: [{ t: 'death', target: 5, kind: 'hero', role: 'traitor' }] });
    const claim = encodeJson({ t: 'events', tick: 5, events: [{ t: 'claim', who: 5, role: 'loyalist' }] });
    expect(scanForLeaks([...clean, death, claim], 'loyalist', 'peer-1')).toEqual([]);

    // a living, unrevealed hero with a hidden role: leak
    hero(3).role = 'rebel';
    expect(scanForLeaks([start, encodeSnapshotMsg(snap, table)], 'loyalist', 'peer-1')).toEqual([expect.stringMatching(/ents\[\d+\]\.role=rebel/)]);

    // a bounty reward seen by anyone but the hunter: leak
    const reward = encodeJson({ t: 'events', tick: 9, events: [{ t: 'reward', who: 2, kind: 'bounty', items: [] }] });
    expect(scanForLeaks([start, reward], 'bounty', 'peer-1')).toEqual([]); // the hunter itself (entity 2)
    expect(scanForLeaks([start, reward], 'rebel', 'peer-1')).toEqual(['events[0].kind=bounty']);
  });
});

/** A seed whose chaos deal puts the 赏金猎人 on a client seat (1..3) of an 8-player room. */
function seedWithClientHunter(): { seed: number; hunter: number; target: number } {
  for (let seed = 1; seed < 500; seed++) {
    const deal = dealRoles('chaos', 8, new Rng(seed));
    const hunter = deal.roles.indexOf('bounty');
    const target = deal.bountyTargets[hunter];
    // target on another client seat keeps the scenario rich; host/bots also fine
    if (hunter >= 1 && hunter <= 3 && target !== undefined && target !== 0) return { seed, hunter, target };
  }
  throw new Error('no suitable seed');
}

describe('hidden information across kills', () => {
  it('chaos 8p with deaths, a bounty kill and a private reveal: nobody learns a hidden role they should not', async () => {
    const { seed, hunter, target } = seedWithClientHunter();
    const h = makeHost({ seed, settings: { playerCount: 8, mode: 'chaos' } });
    await addClient(h, 'A');
    await addClient(h, 'B');
    await addClient(h, 'C');
    await runToPlaying(h);
    const deal = h.host.dealtRoles!;
    expect(deal.roles[hunter]).toBe('bounty');
    expect(deal.bountyTargets[hunter]).toBe(target);
    const sim = h.sims[0];
    const entityOfSeat = (seat: number) => sim.entityOf(sim.init.seats[seat].playerId)!;

    // collect everything the host's own view shows
    const hostEvents: GameEvent[] = [];
    const drainHost = () => hostEvents.push(...(h.host.view?.drainEvents() ?? []));

    // 1. the hunter kills its target → public death (role revealed) + private bounty reward
    sim.kill(target, hunter);
    // 2. the lord kills some other living non-crown hero (role revealed on death)
    const other = deal.roles.findIndex((r, s) => s !== hunter && s !== target && r !== 'lord' && r !== 'double');
    sim.kill(other, deal.lordSeat);
    // 3. a private reveal for client B's hero only (诸葛亮 观星 style)
    const bSeat = h.clients[1].session.mySeat;
    sim.emit({ t: 'status', target: entityOfSeat(hunter), status: 'reveal', on: true, privateTo: entityOfSeat(bSeat) });
    await drive(h, 0.5);
    drainHost();

    const hunterClient = h.clients.find((c) => c.session.mySeat === hunter)!;
    for (const c of h.clients) {
      const seat = c.session.mySeat;
      const violations = scanForLeaks(c.log, deal.roles[seat], c.session.myId);
      expect(violations, `seat ${seat} (${deal.roles[seat]}) saw hidden info`).toEqual([]);
      const evs = receivedEvents(c.log);
      // deaths are public and carry the revealed role
      expect(evs.filter((e) => e.t === 'death').map((e) => e.role)).toEqual([deal.roles[target], deal.roles[other]]);
      const bounties = evs.filter((e) => e.t === 'reward' && e.kind === 'bounty');
      expect(bounties, `seat ${seat}`).toHaveLength(c === hunterClient ? 1 : 0);
      const reveals = evs.filter((e) => e.t === 'status' && e.status === 'reveal');
      expect(reveals, `seat ${seat}`).toHaveLength(seat === bSeat ? 1 : 0);
    }
    // the host player is neither the hunter nor the reveal's viewer
    expect(hostEvents.some((e) => e.t === 'death')).toBe(true);
    expect(hostEvents.some((e) => e.t === 'reward' && e.kind === 'bounty')).toBe(false);
    expect(hostEvents.some((e) => e.t === 'status' && e.status === 'reveal')).toBe(false);
    // the hunter's own view shows its reward (released immediately: local event)
    const hunterView = hunterClient.session.view!.drainEvents();
    expect(hunterView.filter((e) => e.t === 'reward' && e.kind === 'bounty')).toHaveLength(1);
  });

  it('the host player receives its own private events in the LocalView', async () => {
    const h = makeHost({ seed: 3, settings: { playerCount: 5 } });
    await addClient(h, 'A');
    await runToPlaying(h);
    const sim = h.sims[0];
    const me = sim.entityOf('host')!;
    const aEntity = sim.entityOf(h.clients[0].session.myId)!;
    sim.emit({ t: 'reward', who: me, kind: 'bounty', items: [] });
    sim.emit({ t: 'reward', who: aEntity, kind: 'bounty', items: [] });
    await waitFor(() => receivedEvents(h.clients[0].log).some((e) => e.t === 'reward'), 2000, 'client reward');
    const hostEvents = h.host.view!.drainEvents().filter((e) => e.t === 'reward');
    expect(hostEvents).toEqual([{ t: 'reward', who: me, kind: 'bounty', items: [] }]);
    expect(receivedEvents(h.clients[0].log).filter((e) => e.t === 'reward')).toEqual([{ t: 'reward', who: aEntity, kind: 'bounty', items: [] }]);
  });
});
