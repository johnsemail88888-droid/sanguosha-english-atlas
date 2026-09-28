// The weapons spec's sim rules (D5): centre-weighted single shots, bloom inside a held burst, the
// bow's draw, launcher arming + self-splash, 方天's lock, the semi-auto fire buffer, sprint-to-fire,
// the per-class ADS walk speed (host = client), 雌雄 primaryOnly and projectile lag compensation.
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, InputFrame } from '../../../src/core/types';
import { BTN_ADS, BTN_FIRE, BTN_SPRINT, INTERP_DELAY, SIM_DT, emptyInput } from '../../../src/core/types';
import { WEAPON_BY_ID } from '../../../src/data';
import type { WeaponDef } from '../../../src/data/types';
import { AIM_PROFILES, BLOOM, BOW_HIP_DAMAGE, BOW_HIP_SPEED, aimProfile } from '../../../src/data/weaponFeel';
import { aimAnglesFor } from '../../../src/sim/aim';
import { LAUNCHER_SELF_MUL, currentSpread, explodeAt, spreadDir } from '../../../src/sim/combat';
import type { AbilityImplEx } from '../../../src/sim/ext';
import { ADS_MOVE, FIRE_BUFFER, SPRINT_OUT, adsMoveMul, semiTrigger, sprintOutTime } from '../../../src/sim/handling';
import { WALK_SPEED } from '../../../src/sim/physics';
import type { World } from '../../../src/sim/world';
import { heroAt, makeDummy, placeAt, rangeWorld } from '../balance/range';

const W = (id: string): WeaponDef => WEAPON_BY_ID[id]!;
const DEG = Math.PI / 180;

/** Me (seat 2) at the origin facing +z, holding `weapon`; the others parked. */
function range(weapon: string, seed = 7): { w: World; me: Entity; t: Entity } {
  const w = rangeWorld(seed);
  const me = heroAt(w, 2);
  const t = heroAt(w, 3);
  placeAt(w, me, 0, 0, Math.PI);
  placeAt(w, t, 0, 20, 0);
  const h = me.hero!;
  h.weapons[0] = w.newWeapon(weapon);
  h.weapons[1] = null;
  h.activeSlot = 0;
  w.step();
  w.drainEvents();
  return { w, me, t };
}

let seq = 1;
function frameAt(me: Entity, point: { x: number; y: number; z: number }, buttons = 0, extra: Partial<InputFrame> = {}): InputFrame {
  const a = aimAnglesFor(me.pos, point);
  return { ...emptyInput(seq++), yaw: a.yaw, pitch: a.pitch, aimPoint: { ...point }, buttons, ...extra };
}
const chest = (e: Entity) => ({ x: e.pos.x, y: e.pos.y + 1.1, z: e.pos.z });
function hold(w: World, me: Entity, point: { x: number; y: number; z: number }, buttons: number, ticks: number, extra: Partial<InputFrame> = {}): void {
  for (let i = 0; i < ticks; i++) {
    w.setInput(me.hero!.playerId, frameAt(me, point, buttons, extra));
    w.step();
  }
}
const aimTicks = (def: WeaponDef): number => Math.ceil(aimProfile(def).adsTime / SIM_DT) + 2;

function inject(w: World, e: Entity, impl: AbilityImplEx): void {
  w.heroRt(e.id)!.abilities.push({ def: { id: impl.id, slot: 'passive', nameZh: '', nameEn: '', sgsSkill: '', descZh: '', descEn: '', params: {} }, impl });
}

describe('spread (R2 / R3)', () => {
  it('a single hero bullet is centre-weighted: median at half the cone (uniform over the disc: 0.707)', () => {
    const { w } = range('carbine');
    const d = { x: 0, y: 0, z: 1 };
    const ang = (centre: boolean): number => {
      const xs: number[] = [];
      for (let i = 0; i < 4000; i++) xs.push(Math.acos(Math.min(1, spreadDir(w, d, 4, centre).z)) / DEG);
      xs.sort((a, b) => a - b);
      return xs[xs.length >> 1] / 4;
    };
    expect(ang(true)).toBeCloseTo(0.5, 1);
    expect(ang(false)).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it('a held automatic burst blooms to the class cap and never recovers while the trigger is held', () => {
    const { w, me, t } = range('carbine');
    const def = W('carbine');
    makeDummy(w, t);
    hold(w, me, chest(t), BTN_FIRE, 45);
    const rt = w.heroRt(me.id)!;
    expect(rt.bloom).toBeCloseTo(BLOOM.rifle.max, 9);
    expect(currentSpread(w, me, def)).toBeCloseTo(def.spreadHip * (1 + BLOOM.rifle.max), 9);
    // the trigger rests: after the idle time it recovers, down to the bare cone
    hold(w, me, chest(t), 0, 45);
    expect(currentSpread(w, me, def)).toBeCloseTo(def.spreadHip, 9);
  });
});

describe('bows (R5): the draw sets damage and arrow speed — one draw, not stacked multipliers', () => {
  it('a hip snap shot flies at 55 % and hits for 65 %; a full draw at 100 %', () => {
    for (const drawn of [false, true]) {
      const { w, me, t } = range('liegong');
      makeDummy(w, t);
      if (drawn) hold(w, me, chest(t), BTN_ADS, aimTicks(W('liegong')));
      hold(w, me, chest(t), (drawn ? BTN_ADS : 0) | BTN_FIRE, 1);
      const arrow = w.kindList('projectile')[0]!;
      const speed = Math.hypot(arrow.vel.x, arrow.vel.y, arrow.vel.z);
      expect(speed, `drawn ${drawn}`).toBeCloseTo(W('liegong').projectile!.speed * (drawn ? 1 : BOW_HIP_SPEED), 0);
      expect(arrow.proj!.damage, `drawn ${drawn}`).toBeCloseTo(W('liegong').damage * (drawn ? 1 : BOW_HIP_DAMAGE), 6);
      expect(arrow.radius).toBeCloseTo(0.04, 9); // thin arrows (R8)
    }
  });
});

describe('launchers (R6)', () => {
  it('a grenade is a dud inside its 8 m arming distance (direct hit only), armed beyond it', () => {
    const hitsFrom = (dist: number): { blast: boolean; dmg: number } => {
      const { w, me, t } = range('guanshi');
      placeAt(w, t, 0, dist, 0);
      makeDummy(w, t);
      hold(w, me, chest(t), BTN_ADS, aimTicks(W('guanshi')));
      w.drainEvents();
      hold(w, me, chest(t), BTN_ADS | BTN_FIRE, 1);
      hold(w, me, chest(t), BTN_ADS, 60);
      const evs = w.drainEvents() as GameEvent[];
      return { blast: evs.some((e) => e.t === 'explosion'), dmg: 1e6 - t.hp };
    };
    const near = hitsFrom(5);
    expect(near.blast).toBe(false);
    expect(near.dmg).toBeCloseTo(W('guanshi').damage, 0);
    const far = hitsFrom(14);
    expect(far.blast).toBe(true);
    expect(far.dmg).toBeGreaterThan(W('guanshi').damage + W('guanshi').projectile!.explodeDamage * 0.5);
  });

  it('your own launcher blast hurts you at 50 %', () => {
    const { w, me, t } = range('guanshi');
    me.hp = me.maxHp = 1e6;
    makeDummy(w, t);
    placeAt(w, t, 1.5, 0, 0);
    w.markGridDirty();
    // a blast between the two, equally far from each
    explodeAt(w, { x: 0.75, y: 0.2, z: 0 }, 4, 90, 'explosive', me.id, { weaponId: 'guanshi', selfMul: LAUNCHER_SELF_MUL });
    const mine = 1e6 - me.hp;
    const theirs = 1e6 - t.hp;
    expect(theirs).toBeGreaterThan(0);
    expect(mine).toBeCloseTo(theirs * LAUNCHER_SELF_MUL, 3);
    // and a grenade that goes off at your feet (armed) — through the projectile path
    const g = w.spawnProjectile({ kind: 'grenade', ownerId: me.id, pos: { x: 0, y: 0.3, z: 0.8 }, vel: { x: 0, y: -1, z: 0 }, damage: 0, dtype: 'explosive', explodeRadius: 4, explodeDamage: 90, lifetime: 0, weaponId: 'guanshi' });
    expect(g.proj!.armAt).toBeUndefined();
    const before = me.hp;
    w.step();
    expect(before - me.hp).toBeGreaterThan(0);
  });
});

describe('方天画戟 (R7)', () => {
  /** Three rooted dummies 2.5 m apart `dist` m ahead (seats 3, 4, 1), the middle one aimed at. */
  function group(dist: number): { w: World; me: Entity; ts: Entity[] } {
    const { w, me } = range('fangtian');
    const ts = [3, 4, 1].map((s) => heroAt(w, s));
    ts.forEach((t, i) => {
      placeAt(w, t, (i - 1) * 2.5, dist, 0);
      makeDummy(w, t);
    });
    w.step();
    return { w, me, ts };
  }
  const homingTargets = (w: World): number[] => [...w.projHoming.values()].map((h) => h.targetId);

  it('fully aimed at 15 m it locks 3 heroes 2.5 m apart, one rocket each, and tells them', () => {
    const { w, me, ts } = group(15);
    hold(w, me, chest(ts[1]), BTN_ADS, aimTicks(W('fangtian')));
    expect(w.heroRt(me.id)!.adsT).toBeGreaterThanOrEqual(0.95);
    w.drainEvents();
    hold(w, me, chest(ts[1]), BTN_ADS | BTN_FIRE, 1);
    expect(new Set(homingTargets(w))).toEqual(new Set(ts.map((t) => t.id)));
    expect(w.projHoming.size).toBe(3);
    const locks = (w.drainEvents() as GameEvent[]).filter((e): e is Extract<GameEvent, { t: 'lock' }> => e.t === 'lock' && e.on);
    expect(new Set(locks.map((l) => l.target))).toEqual(new Set(ts.map((t) => t.id)));
    expect(locks.every((l) => l.src === me.id)).toBe(true);
    // and every target takes its rocket
    hold(w, me, chest(ts[1]), BTN_ADS, 30);
    for (const t of ts) expect(1e6 - t.hp, `seat ${t.hero!.seat}`).toBeGreaterThan(W('fangtian').damage);
  });

  it('no lock from the hip, none beyond 40 m', () => {
    const hip = group(15);
    hold(hip.w, hip.me, chest(hip.ts[1]), BTN_FIRE, 1);
    expect(hip.w.kindList('projectile').length).toBe(3);
    expect(hip.w.projHoming.size).toBe(0);
    const far = group(45);
    hold(far.w, far.me, chest(far.ts[1]), BTN_ADS, aimTicks(W('fangtian')));
    hold(far.w, far.me, chest(far.ts[1]), BTN_ADS | BTN_FIRE, 1);
    expect(far.w.kindList('projectile').length).toBe(3);
    expect(far.w.projHoming.size).toBe(0);
  });

  it('one target: one rocket homes, the other two fly straight at full damage', () => {
    const { w, me, t } = range('fangtian');
    makeDummy(w, t);
    hold(w, me, chest(t), BTN_ADS, aimTicks(W('fangtian')));
    hold(w, me, chest(t), BTN_ADS | BTN_FIRE, 1);
    expect(homingTargets(w)).toEqual([t.id]);
    const rockets = w.kindList('projectile');
    expect(rockets.length).toBe(3);
    for (const r of rockets) {
      expect(r.proj!.damage).toBeCloseTo(W('fangtian').damage, 6);
      expect(r.proj!.explodeDamage).toBeCloseTo(W('fangtian').projectile!.explodeDamage, 6);
    }
  });

  it('a dodge roll shakes the lock off (the rockets fly on straight, the target is told)', () => {
    const { w, me, t } = range('fangtian');
    t.hp = t.maxHp = 1e6;
    placeAt(w, t, 0, 30, 0);
    hold(w, me, chest(t), BTN_ADS, aimTicks(W('fangtian')));
    hold(w, me, chest(t), BTN_ADS | BTN_FIRE, 1);
    expect(homingTargets(w)).toEqual([t.id]);
    w.drainEvents();
    w.setInput(t.hero!.playerId, { ...emptyInput(9000), moveX: 1, actions: [{ a: 'dodge' }] });
    w.setInput(me.hero!.playerId, frameAt(me, chest(t), BTN_ADS));
    w.step();
    expect(w.projHoming.size).toBe(0);
    const broken = (w.drainEvents() as GameEvent[]).find((e) => e.t === 'lock' && !e.on);
    expect(broken && broken.t === 'lock' && broken.target).toBe(t.id);
  });
});

describe('semi-auto fire buffer (R10 replacement)', () => {
  it('the rule: a press up to FIRE_BUFFER early waits for the gun; earlier ones are lost; a sprint-out always waits', () => {
    expect(semiTrigger(1, true, -1, 1.1)).toEqual({ fire: false, queuedAt: 1 });
    expect(semiTrigger(1.1, false, 1, 1.1)).toEqual({ fire: true, queuedAt: -1 });
    expect(semiTrigger(1, true, -1, 1 + FIRE_BUFFER + 0.05)).toEqual({ fire: false, queuedAt: -1 });
    expect(semiTrigger(1, true, -1, 0.5, 1.3)).toEqual({ fire: false, queuedAt: 1 });
    expect(semiTrigger(1.3, false, 1, 0.5, 1.3).fire).toBe(true);
  });

  it('a click 0.1 s before the pistol is ready fires the moment it is — released or not', () => {
    const { w, me, t } = range('pistol');
    makeDummy(w, t);
    const h = me.hero!;
    hold(w, me, chest(t), BTN_FIRE, 1);
    expect(h.weapons[0]!.mag).toBe(W('pistol').magSize - 1);
    hold(w, me, chest(t), 0, 1);
    // wait until the gun is 0.1 s from ready, click once (one tick), release
    while (h.nextFireAt - w.time > 0.1 + 1e-9) hold(w, me, chest(t), 0, 1);
    const ready = h.nextFireAt;
    hold(w, me, chest(t), BTN_FIRE, 1);
    expect(h.weapons[0]!.mag).toBe(W('pistol').magSize - 1);
    let firedAt = -1;
    for (let i = 0; i < 10 && firedAt < 0; i++) {
      hold(w, me, chest(t), 0, 1);
      if (h.weapons[0]!.mag === W('pistol').magSize - 2) firedAt = w.time;
    }
    expect(firedAt).toBeGreaterThanOrEqual(ready - 1e-9);
    expect(firedAt).toBeLessThan(ready + SIM_DT + 1e-9);
  });
});

describe('sprint-to-fire and the ADS walk speed (C1)', () => {
  function sprinting(weapon: string): { w: World; me: Entity; t: Entity } {
    const r = range(weapon);
    placeAt(r.w, r.t, 50, 60, 0);
    placeAt(r.w, r.me, 0, -60, Math.PI);
    const ahead = { x: 0, y: 1.4, z: 60 };
    hold(r.w, r.me, ahead, BTN_SPRINT, 20, { moveZ: 1 });
    expect(r.me.hero!.sprinting).toBe(true);
    return r;
  }
  const ahead = { x: 0, y: 1.4, z: 60 };

  it('fire pressed mid-sprint ends the sprint; the gun comes up for sprintOut before it fires', () => {
    const { w, me } = sprinting('carbine');
    const h = me.hero!;
    const mag0 = h.weapons[0]!.mag;
    const t0 = w.time;
    let firstShot = -1;
    for (let i = 0; i < 30 && firstShot < 0; i++) {
      hold(w, me, ahead, BTN_SPRINT | BTN_FIRE, 1, { moveZ: 1 });
      expect(h.sprinting).toBe(false);
      if (h.weapons[0]!.mag < mag0) firstShot = w.time;
    }
    expect(firstShot - t0).toBeGreaterThanOrEqual(sprintOutTime(W('carbine')) - 1e-9);
    expect(firstShot - t0).toBeLessThan(sprintOutTime(W('carbine')) + 2 * SIM_DT);
  });

  it('ADS pressed mid-sprint ends it too, and the sights stay down for sprintOut', () => {
    const { w, me } = sprinting('qilin');
    hold(w, me, ahead, BTN_SPRINT | BTN_ADS, 1, { moveZ: 1 });
    expect(me.hero!.sprinting).toBe(false);
    const rt = w.heroRt(me.id)!;
    expect(rt.adsT).toBe(0);
    expect(rt.sprintOutUntil - w.time).toBeGreaterThan(sprintOutTime(W('qilin')) - 2 * SIM_DT);
    // while scoped, Shift never sprints
    hold(w, me, ahead, BTN_SPRINT | BTN_ADS, 20, { moveZ: 1 });
    expect(me.hero!.sprinting).toBe(false);
    expect(rt.adsT).toBeGreaterThan(0);
  });

  it('神速 (sprintAds) is exempt: it keeps sprinting and fires at once', () => {
    const { w, me } = sprinting('carbine');
    inject(w, me, { id: 't_sprintads', modifiers: () => ({ sprintAds: true }) });
    hold(w, me, ahead, BTN_SPRINT, 2, { moveZ: 1 });
    const mag0 = me.hero!.weapons[0]!.mag;
    hold(w, me, ahead, BTN_SPRINT | BTN_FIRE | BTN_ADS, 1, { moveZ: 1 });
    expect(me.hero!.weapons[0]!.mag).toBeLessThan(mag0);
    expect(w.heroRt(me.id)!.sprintOutUntil).toBeLessThanOrEqual(w.time);
    // still running flat out (the shot's tick drops the sprint flag, the pace stays)
    hold(w, me, ahead, BTN_SPRINT | BTN_FIRE | BTN_ADS, 3, { moveZ: 1 });
    expect(Math.hypot(me.vel.x, me.vel.z)).toBeGreaterThan(WALK_SPEED * 1.2);
  });

  it("walking with the sights up: each class's own pace (pistol 0.75 … sniper 0.42)", () => {
    expect(adsMoveMul(W('pistol'))).toBe(ADS_MOVE.pistol);
    expect(adsMoveMul(W('qilin'))).toBe(ADS_MOVE.sniper);
    expect(adsMoveMul(W('cixiong'))).toBe(ADS_MOVE.smg); // SMG handling (C1)
    expect(sprintOutTime(W('cixiong'))).toBe(SPRINT_OUT.smg);
    for (const id of ['pistol', 'carbine', 'qilin']) {
      const { w, me } = range(id);
      placeAt(w, me, 0, -60, Math.PI);
      hold(w, me, { x: 0, y: 1.4, z: 60 }, BTN_ADS, 30, { moveZ: 1 });
      const speed = Math.hypot(me.vel.x, me.vel.z);
      expect(speed, id).toBeCloseTo(WALK_SPEED * W(id).moveSpeedMul * adsMoveMul(W(id)), 3);
    }
    // (the profiles' ADS times stay the aim module's: this only reads them)
    expect(AIM_PROFILES.sniper.adsTime).toBeGreaterThan(0);
  });
});

describe('雌雄 primaryOnly', () => {
  it('picked up with a sniper in hand it replaces the sniper (never becomes the sidearm)', () => {
    const { w, me } = range('qilin');
    const h = me.hero!;
    h.weapons[1] = w.newWeapon('pistol');
    const loot = w.spawnLoot({ x: me.pos.x, y: me.pos.y, z: me.pos.z + 0.5 }, { weaponId: 'cixiong' });
    w.setInput(h.playerId, { ...emptyInput(seq++), yaw: Math.PI, pitch: -0.6, actions: [{ a: 'interact' }] });
    w.step();
    expect(loot.alive).toBe(false);
    expect(h.weapons[0]!.id).toBe('cixiong');
    expect(h.weapons[1]!.id).toBe('pistol');
    expect(w.kindList('loot').some((l) => l.loot?.weaponId === 'qilin')).toBe(true);
  });
});

describe('projectile lag compensation (R11)', () => {
  /**
   * A remote shooter 30 m from a target strafing at walking speed. His view is `lagTicks` old
   * (one-way latency + INTERP_DELAY); he leads the target he SEES (its old position) by the
   * arrow's flight. With his view tick sent the arrow meets the target as he saw it.
   */
  function shoot(viewLag: number, sendViewTick: boolean): boolean {
    const { w, me, t } = range('liegong');
    t.hp = t.maxHp = 1e6;
    placeAt(w, t, -6, 30, 0);
    const def = W('liegong');
    hold(w, me, chest(t), BTN_ADS, aimTicks(def));
    const strafe = (): void => w.setInput(t.hero!.playerId, { ...emptyInput(seq++), yaw: 0, moveX: -1 });
    // the target strafes for a while (history), the shooter tracks what he sees
    const seen: { x: number; z: number; vx: number }[] = [];
    for (let i = 0; i < 20; i++) {
      strafe();
      w.setInput(me.hero!.playerId, frameAt(me, chest(t), BTN_ADS));
      w.step();
      seen.push({ x: t.pos.x, z: t.pos.z, vx: t.vel.x });
    }
    const old = seen[seen.length - 1 - viewLag];
    const flight = 30 / def.projectile!.speed;
    const aim = { x: old.x + old.vx * flight, y: t.pos.y + 1.1 + 0.5 * def.projectile!.gravity * flight * flight, z: old.z };
    strafe();
    w.setInput(me.hero!.playerId, frameAt(me, aim, BTN_ADS | BTN_FIRE, sendViewTick ? { viewTick: w.tick - viewLag } : {}));
    w.step();
    const hp0 = t.hp;
    for (let i = 0; i < 20; i++) {
      strafe();
      w.setInput(me.hero!.playerId, frameAt(me, aim, BTN_ADS));
      w.step();
    }
    return t.hp < hp0;
  }

  it('a 100 ms-RTT client leading the strafer he sees hits (and would miss without the rewind)', () => {
    const lag = Math.round((0.05 + INTERP_DELAY) / SIM_DT); // one-way 50 ms + interpolation
    expect(shoot(lag, true)).toBe(true);
    expect(shoot(lag, false)).toBe(false);
  });
});
