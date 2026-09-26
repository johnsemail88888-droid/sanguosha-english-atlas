import { beforeEach, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import type { GameEvent, PrivateHeroView, ViewEntity } from '../../../src/core/types';
import { VF_OPENED, VF_RELOADING } from '../../../src/core/types';
import type { SfxName } from '../../../src/audio/catalog';
import type { MusicTrack } from '../../../src/audio/music';
import type { LoopName } from '../../../src/audio/recipes/loops';
import { fakeView } from '../../../src/audio/render';
import { EMP_SIZE, EventRouter, PROC_GAIN, PROC_SIZE } from '../../../src/audio/router';
import type { SoundSink } from '../../../src/audio/router';
import type { LoopOpts, PlayOpts } from '../../../src/audio/sfx';

class RecSink implements SoundSink {
  t = 10;
  lis: Vec3 = { x: 0, y: 1.6, z: 0 };
  plays: { name: SfxName; o: PlayOpts; stopped: boolean }[] = [];
  loops: { key: string; name: LoopName; o: LoopOpts }[] = [];
  tracks: (MusicTrack | null)[] = [];
  downed: boolean[] = [];
  now(): number {
    return this.t;
  }
  listener(): Vec3 {
    return this.lis;
  }
  play(name: SfxName, o: PlayOpts = {}) {
    const rec = { name, o, stopped: false };
    this.plays.push(rec);
    return { end: this.t + (o.delay ?? 0) + 0.5, stop: () => (rec.stopped = true) };
  }
  loop(key: string, name: LoopName, o: LoopOpts = {}): void {
    this.loops.push({ key, name, o });
  }
  music(track: MusicTrack | null): void {
    this.tracks.push(track);
  }
  dipMusic(): void {}
  autoDowned(on: boolean): void {
    this.downed.push(on);
  }
  downedUrgency(): void {}
  named(n: SfxName) {
    return this.plays.filter((p) => p.name === n);
  }
}

const hero = (id: number, x: number, z: number, extra: Partial<ViewEntity> = {}): ViewEntity => ({
  id,
  kind: 'hero',
  sub: 'guanyu',
  x,
  y: 0,
  z,
  yaw: 0,
  pitch: 0,
  speed: 0,
  hp: 400,
  maxHp: 400,
  shield: 0,
  flags: 0,
  weapon: 'qinglong',
  ...extra,
});

const shot = (src: number, weapon: string, from: Vec3, to: Vec3, hit?: number): GameEvent => ({ t: 'shot', src, weapon, from, to, hit });

let sink: RecSink;
let router: EventRouter;

beforeEach(() => {
  sink = new RecSink();
  router = new EventRouter(sink);
});

describe('EventRouter: gunfire', () => {
  it('skips the host echo of a locally predicted shot', () => {
    const view = fakeView([hero(1, 0, 0)], 1);
    router.handle([], view);
    router.localFire('qinglong');
    expect(sink.named('gun')).toHaveLength(1);
    expect(sink.named('gun')[0].o.local).toBe(true);
    sink.t += 0.05;
    router.handle([shot(1, 'qinglong', { x: 0, y: 1.5, z: 0 }, { x: 0, y: 1, z: -30 }, 7)], view);
    expect(sink.named('gun')).toHaveLength(1);
  });

  it('plays local shots that were not predicted (ability volleys)', () => {
    const view = fakeView([hero(1, 0, 0)], 1);
    router.handle([shot(1, 'qinglong', { x: 0, y: 1.5, z: 0 }, { x: 0, y: 1, z: -30 }, 7)], view);
    expect(sink.named('gun')).toHaveLength(1);
    expect(sink.named('gun')[0].o.pos).toBeUndefined();
  });

  it('expires stale predictions', () => {
    const view = fakeView([hero(1, 0, 0)], 1);
    router.handle([], view);
    router.localFire('qinglong');
    sink.t += 2;
    router.handle([shot(1, 'qinglong', { x: 0, y: 1.5, z: 0 }, { x: 0, y: 1, z: -30 }, 7)], view);
    expect(sink.named('gun')).toHaveLength(2);
  });

  it('two shotgun blasts bunched into one frame both play (staggered)', () => {
    const view = fakeView([hero(2, 20, 0, { weapon: 'manwang' })], 1);
    router.handle([shot(2, 'manwang', { x: 20, y: 1.5, z: 0 }, { x: -5, y: 0, z: 0 }), shot(2, 'manwang', { x: 20, y: 1.5, z: 0 }, { x: -5, y: 0, z: 1 })], view);
    const guns = sink.named('gun');
    expect(guns).toHaveLength(2);
    expect(guns.every((g) => g.o.variant === 'shotgun')).toBe(true);
    expect(guns[1].o.delay ?? 0).toBeGreaterThan(0);
  });

  it('caps world impacts per shooter per frame', () => {
    const view = fakeView([hero(2, 20, 0, { weapon: 'huben' })], 1);
    const evs: GameEvent[] = [];
    for (let i = 0; i < 10; i++) evs.push(shot(2, 'huben', { x: 20, y: 1.5, z: 0 }, { x: -5, y: 0.1, z: i }));
    router.handle(evs, view);
    expect(sink.named('impact')).toHaveLength(3);
    expect(sink.named('impact')[0].o.variant).toBe('dirt');
  });

  it('a miss that ends in mid-air makes no impact sound', () => {
    const view = fakeView([hero(2, 20, 0)], 1);
    router.handle([shot(2, 'qinglong', { x: 20, y: 1.5, z: 0 }, { x: -40, y: 25, z: 0 })], view);
    expect(sink.named('gun')).toHaveLength(1);
    expect(sink.named('impact')).toHaveLength(0);
    // a projectile weapon's shot ends at the aim point, not at an impact
    const proj = view.get(2)!;
    proj.weapon = 'custom_rocket_launcher';
    router.handle([shot(2, 'custom_rocket_launcher', { x: 20, y: 1.5, z: 0 }, { x: -5, y: 0, z: 0 })], view);
    expect(sink.named('impact')).toHaveLength(0);
  });

  it('positions remote shots and staggers a burst arriving in one frame', () => {
    const view = fakeView([hero(2, 30, 0)], 1);
    router.handle(
      [shot(2, 'qinglong', { x: 30, y: 1.5, z: 0 }, { x: 60, y: 1, z: 0 }, 9), shot(2, 'qinglong', { x: 30, y: 1.5, z: 0 }, { x: 60, y: 1, z: 0 }, 9)],
      view,
    );
    const guns = sink.named('gun');
    expect(guns).toHaveLength(2);
    expect(guns[0].o.pos).toEqual({ x: 30, y: 1.5, z: 0 });
    expect(guns[1].o.delay ?? 0).toBeGreaterThan(0);
  });

  it('plays a flyby when a round passes close to the listener', () => {
    const view = fakeView([hero(2, 0, -60)], 1);
    router.handle([shot(2, 'qinglong', { x: 0, y: 1.6, z: -60 }, { x: 1, y: 1.6, z: 40 })], view);
    expect(sink.named('flyby')).toHaveLength(1);
    // far miss: no flyby
    sink.t += 1;
    router.handle([shot(2, 'qinglong', { x: 0, y: 1.6, z: -60 }, { x: 40, y: 1.6, z: -20 })], view);
    expect(sink.named('flyby')).toHaveLength(1);
  });

  it('keeps flamethrowers as a loop instead of one-shots', () => {
    const view = fakeView([hero(2, 10, 0, { weapon: 'zhuque' })], 1);
    router.handle([shot(2, 'zhuque', { x: 10, y: 1.5, z: 0 }, { x: 0, y: 1, z: 0 }, 1)], view);
    expect(sink.named('gun')).toHaveLength(0);
    expect(sink.loops.some((l) => l.name === 'flamer')).toBe(true);
  });

  it('a local ability cleave neither silences nor duplicates the predicted gunshot', () => {
    const view = fakeView([hero(1, 0, 0)], 1);
    router.handle([], view);
    router.localFire('qinglong');
    sink.t += 0.05;
    // 武圣 bonus slash (a local melee event) lands while shooting, then the host echo
    router.handle([{ t: 'melee', src: 1, pos: { x: 0, y: 1.5, z: 0 }, dir: { x: 0, y: 0, z: -1 }, range: 2, arc: 60 }], view);
    router.handle([shot(1, 'qinglong', { x: 0, y: 1.5, z: 0 }, { x: 0, y: 1, z: -30 }, 7)], view);
    const guns = sink.named('gun');
    expect(guns.filter((g) => g.o.variant === 'rifle')).toHaveLength(1);
    expect(guns.filter((g) => g.o.variant === 'melee')).toHaveLength(1);
  });

  it('a predicted melee swing is echoed by its host melee event', () => {
    const view = fakeView([hero(1, 0, 0, { weapon: 'troop_melee' })], 1);
    router.handle([], view);
    router.localFire('troop_melee');
    router.handle([{ t: 'melee', src: 1, pos: { x: 0, y: 1.5, z: 0 }, dir: { x: 0, y: 0, z: -1 }, range: 2, arc: 90 }], view);
    expect(sink.named('gun')).toHaveLength(1);
    expect(sink.named('gun')[0].o.variant).toBe('melee');
  });

  it('ability shots never consume a pending gun prediction', () => {
    const view = fakeView([hero(1, 0, 0)], 1);
    router.handle([], view);
    router.localFire('qinglong');
    router.handle([shot(1, 'huangzhong_chuanyang', { x: 0, y: 1.5, z: 0 }, { x: 0, y: 1, z: -30 }, 7)], view);
    router.handle([shot(1, 'qinglong', { x: 0, y: 1.5, z: 0 }, { x: 0, y: 1, z: -30 }, 7)], view);
    // predicted rifle + the (unpredicted) ability shot; the rifle echo is skipped
    expect(sink.named('gun')).toHaveLength(2);
  });

  it('plays dry fire when the local magazine is empty', () => {
    const base = fakeView([hero(1, 0, 0)], 1);
    const local = {
      weapons: [{ id: 'qinglong', mag: 0, reserve: 30 }, null],
      activeSlot: 0,
      reloading: 0,
      downed: false,
      dead: false,
      downedRemaining: 0,
    } as unknown as PrivateHeroView;
    const view = { ...base, local: () => local };
    router.handle([], view);
    router.localFire('qinglong');
    expect(sink.named('dryFire')).toHaveLength(1);
    expect(sink.named('gun')).toHaveLength(0);
  });
});

describe('EventRouter: chain lightning', () => {
  const zj = (id: number, x: number, z: number): ViewEntity => hero(id, x, z, { sub: 'zhangjiao', weapon: 'taiping' });
  const victims = (): ViewEntity[] => [hero(7, 0, -20), hero(8, 4, -22), hero(9, 7, -25)];
  const volley = (src: number, eye: Vec3): GameEvent[] => [
    shot(src, 'taiping', eye, { x: 0, y: 1.6, z: -20 }, 7),
    shot(src, 'taiping', { x: 0, y: 0.9, z: -20 }, { x: 4, y: 0.9, z: -22 }, 8),
    shot(src, 'taiping', { x: 4, y: 0.9, z: -22 }, { x: 7, y: 0.9, z: -25 }, 9),
  ];

  it('local volley: one predicted shot, arcs as zaps, no phantom gunshots', () => {
    const view = fakeView([zj(1, 0, 0), ...victims()], 1);
    router.handle([], view);
    router.localFire('taiping');
    sink.t += 0.05;
    router.handle(volley(1, { x: 0, y: 1.6, z: 0 }), view);
    expect(sink.named('gun')).toHaveLength(1);
    expect(sink.named('arc')).toHaveLength(2);
    expect(sink.named('arc').every((a) => a.o.pos !== undefined)).toBe(true);
  });

  it('arcs listed before the primary shot are still recognised', () => {
    const view = fakeView([zj(1, 0, 0), ...victims()], 1);
    router.handle([], view);
    router.localFire('taiping');
    const [primary, a, b] = volley(1, { x: 0, y: 1.6, z: 0 });
    router.handle([a, b, primary], view);
    expect(sink.named('gun')).toHaveLength(1);
    expect(sink.named('arc')).toHaveLength(2);
  });

  it('remote Zhang Jiao: one positioned gunshot plus arcs', () => {
    const view = fakeView([zj(2, 0, 10), ...victims()], 1);
    router.handle(volley(2, { x: 0, y: 1.6, z: 10 }), view);
    expect(sink.named('gun')).toHaveLength(1);
    expect(sink.named('gun')[0].o.pos).toEqual({ x: 0, y: 1.6, z: 10 });
    expect(sink.named('arc')).toHaveLength(2);
  });

  it('point-blank arcs are recognised from the volley geometry', () => {
    const view = fakeView([zj(2, 0, 10), hero(7, 1, 10), hero(8, 1.5, 12)], 1);
    router.handle(
      [
        shot(2, 'taiping', { x: 0, y: 1.6, z: 10 }, { x: 0.8, y: 1.5, z: 10 }, 7),
        shot(2, 'taiping', { x: 1, y: 0.9, z: 10 }, { x: 1.5, y: 0.9, z: 12 }, 8),
      ],
      view,
    );
    expect(sink.named('gun')).toHaveLength(1);
    expect(sink.named('arc')).toHaveLength(1);
  });
});

describe('EventRouter: combat feedback', () => {
  it('hurt on local damage, hitmarker / headshot for local hits', () => {
    const view = fakeView([hero(1, 0, 0), hero(2, 10, 0)], 1);
    router.handle([{ t: 'hit', target: 1, src: 2, amount: 40, dtype: 'normal', pos: { x: 0, y: 1, z: 0 } }], view);
    expect(sink.named('hurt')).toHaveLength(1);
    router.handle([{ t: 'hit', target: 2, src: 1, amount: 30, dtype: 'normal', pos: { x: 10, y: 1, z: 0 } }], view);
    expect(sink.named('hitmarker')).toHaveLength(1);
    expect(sink.named('impact').some((p) => p.o.variant === 'flesh')).toBe(true);
    router.handle([{ t: 'hit', target: 2, src: 1, amount: 60, dtype: 'normal', pos: { x: 10, y: 1.7, z: 0 }, head: true }], view);
    expect(sink.named('headshot')).toHaveLength(1);
  });

  it('blocked hits play the block material, zone damage ticks', () => {
    const view = fakeView([hero(1, 0, 0), hero(2, 10, 0)], 1);
    router.handle([{ t: 'hit', target: 2, amount: 0, dtype: 'normal', pos: { x: 10, y: 1, z: 0 }, blocked: 'shield' }], view);
    expect(sink.named('impact')[0].o.variant).toBe('shield');
    router.handle([{ t: 'hit', target: 1, amount: 4, dtype: 'zone', pos: { x: 0, y: 1, z: 0 } }], view);
    expect(sink.named('zoneTick')).toHaveLength(1);
    expect(sink.named('hurt')).toHaveLength(0);
  });

  it('death: gong for heroes, kill confirm for the killer', () => {
    const view = fakeView([hero(1, 0, 0)], 1);
    router.handle([{ t: 'death', target: 2, killer: 1, kind: 'hero', role: 'rebel' }], view);
    expect(sink.named('deathGong')).toHaveLength(1);
    expect(sink.named('killConfirm')).toHaveLength(1);
  });

  it('heals are throttled for the local hero', () => {
    const view = fakeView([hero(1, 0, 0)], 1);
    for (let i = 0; i < 10; i++) {
      router.handle([{ t: 'heal', target: 1, amount: 15 }], view);
      sink.t += 0.1;
    }
    expect(sink.named('heal')).toHaveLength(1);
  });
});

describe('EventRouter: world state', () => {
  it('zone horn once per new phase', () => {
    const view = fakeView([], null);
    const z = (phase: number): GameEvent => ({ t: 'zone', phase, center: { x: 0, y: 0, z: 0 }, radius: 100, targetRadius: 50, shrinkStart: 0, shrinkEnd: 1 });
    router.handle([z(0)], view);
    router.handle([z(1)], view);
    router.handle([z(1)], view);
    router.handle([z(2)], view);
    expect(sink.named('zoneHorn')).toHaveLength(2);
  });

  it('the phase announcement does not stack on the zone horn', () => {
    const view = fakeView([], null);
    router.handle(
      [
        { t: 'zone', phase: 1, center: { x: 0, y: 0, z: 0 }, radius: 230, targetRadius: 160, shrinkStart: 0, shrinkEnd: 60 },
        { t: 'announce', zh: '烽火圈正在收缩！', en: 'The beacon ring is closing!', kind: 'warn' },
      ],
      view,
    );
    expect(sink.named('zoneHorn')).toHaveLength(1);
    expect(sink.named('announce')).toHaveLength(0);
    sink.t += 5;
    router.handle([{ t: 'announce', zh: '', en: '', kind: 'warn' }], view);
    expect(sink.named('announce')).toHaveLength(1);
  });

  it('zone level follows the phase and drops back when no match is fed', () => {
    const base = fakeView([], null);
    let phase = 0;
    const view = { ...base, zone: () => ({ ...base.zone(), phase }) };
    router.handle([], view);
    expect(router.zoneLevel()).toBe(0);
    phase = 3;
    router.handle([], view);
    expect(router.zoneLevel()).toBeCloseTo(0.6);
    phase = 6;
    router.handle([], view);
    expect(router.zoneLevel()).toBe(1);
    sink.t += 5;
    expect(router.zoneLevel()).toBe(0);
  });

  it('game over picks victory or defeat for the local player', () => {
    const view = fakeView([], 5);
    const over = (winners: number[]): GameEvent => ({
      t: 'gameOver',
      result: { winner: 'rebel', winners, roles: {}, reasonZh: '', reasonEn: '', durationSec: 60 },
    });
    router.handle([over([5, 6])], view);
    router.handle([over([6])], view);
    expect(sink.tracks).toEqual(['victory', 'defeat']);
  });

  it('schedules reload clicks on the reload flag and cancels them when interrupted', () => {
    const e = hero(2, 5, 0);
    const view = fakeView([e], 1);
    router.handle([], view);
    e.flags = VF_RELOADING;
    router.handle([], view);
    const parts = sink.named('reload');
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.every((p) => (p.o.delay ?? 0) >= 0)).toBe(true);
    sink.t += 0.2;
    e.flags = 0;
    router.handle([], view);
    expect(parts.some((p) => p.stopped)).toBe(true);
  });

  it('crate opening is detected from the flag edge', () => {
    const crate: ViewEntity = { id: 50, kind: 'crate', sub: '2', x: 3, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: 0 };
    const view = fakeView([crate], null);
    router.handle([], view);
    crate.flags = VF_OPENED;
    router.handle([], view);
    router.handle([], view);
    expect(sink.named('crateOpen')).toHaveLength(1);
    expect(sink.named('crateOpen')[0].o.variant).toBe('2');
  });

  it('crateOpen sfx takes its tier from the crate and is not repeated by the flag edge', () => {
    const crate: ViewEntity = { id: 50, kind: 'crate', sub: '2', x: 3, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: 0 };
    const drop: ViewEntity = { ...crate, id: 51, kind: 'airdrop', sub: 'airdrop', x: -8, z: 5 };
    const view = fakeView([crate, drop], null);
    router.handle([], view);
    router.handle([{ t: 'sfx', name: 'crateOpen', pos: { x: 3, y: 0, z: 0 } }], view);
    crate.flags = VF_OPENED;
    router.handle([], view);
    router.handle([{ t: 'sfx', name: 'crateOpen', pos: { x: -8, y: 0, z: 5 } }], view);
    drop.flags = VF_OPENED;
    router.handle([], view);
    expect(sink.named('crateOpen').map((p) => p.o.variant)).toEqual(['2', '3']);
  });

  it('shielded heroes hum: yourself always, others when near', () => {
    const me = hero(1, 0, 0, { shield: 50 });
    const near = hero(2, 6, 0, { shield: 30 });
    const far = hero(3, 40, 0, { shield: 30 });
    const bare = hero(4, 3, 0);
    router.handle([], fakeView([me, near, far, bare], 1));
    const keys = sink.loops.filter((l) => l.name === 'shield').map((l) => l.key);
    expect(keys).toContain('shield:local');
    expect(keys).toContain('shield:2');
    expect(keys).not.toContain('shield:3');
    expect(keys).not.toContain('shield:4');
    expect(sink.loops.find((l) => l.key === 'shield:local')?.o.pos).toBeUndefined();
  });

  it('footsteps for nearby movers, none for distant ones', () => {
    const near = hero(2, 4, 0, { speed: 5 });
    const far = hero(3, 200, 0, { speed: 5 });
    const view = fakeView([near, far], null);
    for (let i = 0; i < 60; i++) {
      router.handle([], view);
      sink.t += 1 / 60;
    }
    const steps = sink.named('footstep');
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.every((s) => s.o.pos && Math.abs(s.o.pos.x - 4) < 0.01)).toBe(true);
  });

  it('fire hazards loop, traps stay silent', () => {
    const fire: ViewEntity = { id: 60, kind: 'hazard', sub: 'fire', x: 5, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: 0, radius: 4 };
    const trap: ViewEntity = { ...fire, id: 61, sub: 'trapDance' };
    router.handle([], fakeView([fire, trap], null));
    expect(sink.loops.filter((l) => l.key === 'haz:60')).toHaveLength(1);
    expect(sink.loops.filter((l) => l.key === 'haz:61')).toHaveLength(0);
  });

  it("airdrop: the sim's airdropLand plays the thud exactly once", () => {
    const view = fakeView([], null);
    router.handle([{ t: 'airdrop', pos: { x: 20, y: 0, z: 20 }, id: 77 }], view);
    sink.t += 12;
    router.handle([{ t: 'sfx', name: 'airdropLand', pos: { x: 20, y: 0.2, z: 20 } }], view);
    expect(sink.named('airdropThud')).toHaveLength(1);
    sink.t += 5;
    router.handle([], view);
    expect(sink.named('airdropThud')).toHaveLength(1);
  });

  it('airdrop: plane flyover now, landing thud later', () => {
    const view = fakeView([], null);
    router.handle([{ t: 'airdrop', pos: { x: 20, y: 0, z: 20 }, id: 77 }], view);
    expect(sink.named('plane')).toHaveLength(1);
    expect(sink.named('plane')[0].o.path).toBeDefined();
    sink.t += 14;
    router.handle([], view);
    expect(sink.named('airdropThud')).toHaveLength(1);
    // a late airdropLand for the same drop does not thud again
    router.handle([{ t: 'sfx', name: 'airdropLand', pos: { x: 20, y: 0, z: 20 } }], view);
    expect(sink.named('airdropThud')).toHaveLength(1);
  });

  it('sfx events resolve through the catalog', () => {
    router.handle([{ t: 'sfx', name: 'thunder', pos: { x: 1, y: 0, z: 1 } }, { t: 'sfx', name: 'nope' }], fakeView([], null));
    expect(sink.plays.map((p) => p.name)).toEqual(['lightning']);
  });

  it('downed state is edge-triggered from the private view', () => {
    const base = fakeView([hero(1, 0, 0)], 1);
    const local = { weapons: [null, null], activeSlot: 0, reloading: 0, downed: false, dead: false, downedRemaining: 0 };
    const view = { ...base, local: () => local as unknown as PrivateHeroView };
    router.handle([], view);
    local.downed = true;
    local.downedRemaining = 10;
    router.handle([], view);
    router.handle([], view);
    local.downed = false;
    router.handle([], view);
    expect(sink.downed).toEqual([true, false]);
  });
});

describe('EventRouter: ability procs and EMP (G3-7/8)', () => {
  it('a passive proc plays a lighter, smaller abilityCast than an activation', () => {
    const view = fakeView([hero(2, 10, 0, { sub: 'caocao', kingdom: 'wei' })], 1);
    router.handle([{ t: 'ability', src: 2, ability: 'caocao_p', proc: true }], view);
    sink.t += 1;
    router.handle([{ t: 'ability', src: 2, ability: 'caocao_q' }], view);
    const casts = sink.named('abilityCast');
    expect(casts).toHaveLength(2);
    const [proc, cast] = casts;
    expect(proc.o.gain).toBe(PROC_GAIN);
    expect(proc.o.gain).toBe(0.5);
    expect(proc.o.size).toBe(PROC_SIZE);
    expect(proc.o.size).toBeCloseTo(0.6);
    expect(cast.o.gain ?? 1).toBe(1);
    expect(cast.o.size).toBe(1);
    expect(proc.o.priority ?? 0).toBeLessThan(cast.o.priority ?? 0);
  });

  it('a local proc stays non-positional but lighter', () => {
    const view = fakeView([hero(1, 0, 0, { sub: 'luxun', kingdom: 'wu' })], 1);
    router.handle([{ t: 'ability', src: 1, ability: 'luxun_p', proc: true }], view);
    const [c] = sink.named('abilityCast');
    expect(c.o.local).toBe(true);
    expect(c.o.pos).toBeUndefined();
    expect(c.o.gain).toBe(PROC_GAIN);
  });

  it("EMP explosions use the small 'thunder' variant, not 'frag'", () => {
    const view = fakeView([], null);
    router.handle([{ t: 'explosion', pos: { x: 5, y: 0, z: 5 }, radius: 8, kind: 'emp' }], view);
    router.handle([{ t: 'explosion', pos: { x: 5, y: 0, z: 5 }, radius: 8, kind: 'frag' }], view);
    const [emp, frag] = sink.named('explosion');
    expect(emp.o.variant).toBe('thunder');
    expect(emp.o.size).toBe(EMP_SIZE);
    expect(emp.o.size ?? 1).toBeLessThan(frag.o.size ?? 1);
    expect(frag.o.variant).toBe('frag');
  });

  it("matches 'emp' as a word only", () => {
    const view = fakeView([], null);
    router.handle([{ t: 'explosion', pos: { x: 5, y: 0, z: 5 }, radius: 8, kind: 'emp_pulse' }], view);
    router.handle([{ t: 'explosion', pos: { x: 5, y: 0, z: 5 }, radius: 10, kind: 'tempest' }], view);
    const [a, b] = sink.named('explosion');
    expect(a.o.variant).toBe('thunder');
    expect(a.o.size).toBe(EMP_SIZE);
    expect(b.o.size).toBe(2);
  });
});
