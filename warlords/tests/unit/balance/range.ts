// A firing range in the real sim: a flat, empty 240 m map with five 'dummy' heroes (no passives,
// no abilities). Shared by the perfect-aim TTK cells (tests/unit/items/weaponsDps.test.ts, COMBAT-9
// v2), the weapon-rule unit tests and the bot duel harness (duelHarness.ts).
import type { MapData } from '../../../src/core/map';
import type { Entity, RoleId } from '../../../src/core/types';
import { BTN_ADS, BTN_FIRE, SIM_DT, emptyInput } from '../../../src/core/types';
import type { WeaponDef } from '../../../src/data/types';
import { aimAnglesFor } from '../../../src/sim/aim';
import type { CreateMatchOptions, World } from '../../../src/sim/world';
import { createWorld } from '../../../src/sim/world';
import { makeInit } from '../sim/helpers';

export const RANGE_ROLES: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

/** A flat, empty square map (no props, colliders, water or camps). */
export function flatMap(size = 240, res = 60): MapData {
  const n = res + 1;
  const spawns = Array.from({ length: 8 }, (_, i) => ({ x: Math.cos((i / 8) * Math.PI * 2) * 90, y: 0, z: Math.sin((i / 8) * Math.PI * 2) * 90 }));
  return {
    seed: 1,
    nameZh: '决斗场',
    nameEn: 'Duel Range',
    size,
    res,
    heights: new Float32Array(n * n),
    waterLevel: -50,
    props: [],
    colliders: [],
    lordSpawn: { x: 0, y: 0, z: 100 },
    spawns,
    lootSpots: [],
    crateSpots: [],
    camps: [],
    regions: [],
  };
}

export function heroAt(w: World, seat: number): Entity {
  const e = w.heroList().find((h) => h.hero!.seat === seat);
  if (!e) throw new Error(`no hero at seat ${seat}`);
  return e;
}

/** Put an entity exactly there (feet on the ground), at rest. */
export function placeAt(w: World, e: Entity, x: number, z: number, yaw: number): void {
  e.pos.x = x;
  e.pos.z = z;
  e.pos.y = w.groundHeight(x, z);
  e.vel.x = 0;
  e.vel.y = 0;
  e.vel.z = 0;
  e.yaw = yaw;
  e.pitch = 0;
  e.onGround = true;
  e.forced = undefined;
  w.markGridDirty();
}

/**
 * The range world: five dummies, every seat human (`humans`, default all — no bot brains) unless
 * `opts.botFactory` drives some. Seats 0, 1, 4 are parked far off; the caller places 2 and 3.
 */
export function rangeWorld(seed: number, opts: CreateMatchOptions = {}, humans: number[] = [0, 1, 2, 3, 4]): World {
  const init = makeInit(RANGE_ROLES, RANGE_ROLES.map(() => 'dummy'), {}, humans);
  init.seed = seed >>> 0;
  const w = createWorld(init, { map: flatMap(), ambient: false, zone: false, airdrops: false, squads: false, nav: false, onWarn: () => {}, ...opts });
  [0, 1, 4].forEach((s, i) => placeAt(w, heroAt(w, s), 100, 100 - i * 20, 0));
  return w;
}

/** A rooted, silenced, effectively unkillable target (damage is read off its HP). */
export function makeDummy(w: World, e: Entity): void {
  e.maxHp = e.hp = 1e6;
  e.shield = 0;
  w.applyStatus(e.id, 'root', 1e4, { sourceId: e.id });
  w.applyStatus(e.id, 'silence', 1e4, { sourceId: e.id });
}

/** Chest point of a hero, raised by a projectile's drop over `dist` (perfect holdover). */
export function chestAim(def: WeaponDef, t: Entity, dist: number, drawSpeed = 1): { x: number; y: number; z: number } {
  const c = { x: t.pos.x, y: t.pos.y + 1.1, z: t.pos.z };
  const pr = def.projectile;
  if (pr && pr.gravity > 0 && pr.speed > 0) {
    const ft = dist / (pr.speed * drawSpeed);
    c.y += 0.5 * pr.gravity * ft * ft;
  }
  return c;
}

/** The wielder's passive damage multiplier the dummy lacks (黄忠 烈弓 beyond 30 m, 张角 鬼道). */
export const PASSIVE_MUL: Readonly<Record<string, (dist: number) => number>> = { taiping: () => 1.3, liegong: (d) => (d > 30 ? 1.25 : 1) };

/** Seconds after the first shot a perfect-aim TTK cell gives up. */
export const TTK_CAP = 12;

/**
 * Perfect aim at a rooted dummy's chest `dist` m away (projectiles held over for their drop),
 * the sights up first when `ads`: seconds from the first shot until `hp` damage (the wielder's
 * passive included), reloads counted; Infinity past TTK_CAP. Semi-autos click as fast as the gun
 * cycles, autos hold.
 */
export function measureTtk(def: WeaponDef, dist: number, ads: boolean, seed: number, hp = 400): number {
  const w = rangeWorld(seed);
  const me = heroAt(w, 2);
  const t = heroAt(w, 3);
  placeAt(w, me, 0, -dist / 2, Math.PI);
  placeAt(w, t, 0, dist / 2, 0);
  makeDummy(w, t);
  const h = me.hero!;
  h.weapons[0] = { id: def.id, mag: def.magSize, reserve: def.magSize * 6 };
  h.weapons[1] = null;
  h.activeSlot = 0;
  let seq = 1;
  const pm = PASSIVE_MUL[def.id]?.(dist) ?? 1;
  const btn = ads ? BTN_ADS : 0;
  const frame = (buttons: number): void => {
    const c = chestAim(def, t, dist, def.class === 'bow' && !ads ? 0.55 : 1);
    const a = aimAnglesFor(me.pos, c);
    w.setInput(h.playerId, { ...emptyInput(seq++), yaw: a.yaw, pitch: a.pitch, aimPoint: c, aimTargetId: t.id, buttons });
  };
  for (let i = 0; i < 20; i++) {
    frame(btn);
    w.step();
  }
  let first = -1;
  let pressed = false;
  let dealt = 0;
  let last = t.hp;
  for (let i = 0; i < Math.ceil((TTK_CAP + 4) / SIM_DT); i++) {
    const click: boolean = def.auto || (!pressed && h.nextFireAt <= w.time + SIM_DT + 1e-6);
    pressed = click;
    frame(btn | (click ? BTN_FIRE : 0));
    const mag = h.weapons[0]!.mag;
    w.step();
    if (first < 0 && h.weapons[0]!.mag < mag) first = w.time - SIM_DT;
    dealt += (last - t.hp) * pm;
    last = t.hp;
    if (first >= 0 && dealt >= hp) return w.time - first;
    if (first >= 0 && w.time - first > TTK_CAP) return Infinity;
  }
  return Infinity;
}

/**
 * The group cell (weapons spec D2): three rooted dummies `gap` m apart, `dist` m away, aimed at
 * (ADS) — 方天 at the middle one while it still stands, anyone else at the first still under
 * 400: seconds from the first shot until all three took 400. multiTarget weapons fire only
 * locked (fully aimed). The dummies are held in place: a blast still shoves a rooted unit, and
 * a static group scattered by its own shoves says nothing about a moving one.
 */
export function measureGroup(def: WeaponDef, dist: number, seed: number, gap = 2.5): number {
  const w = rangeWorld(seed);
  const me = heroAt(w, 2);
  const ts = [3, 4, 1].map((s) => heroAt(w, s));
  placeAt(w, me, 0, -dist / 2, Math.PI);
  ts.forEach((t, i) => {
    placeAt(w, t, (i - 1) * gap, dist / 2, 0);
    makeDummy(w, t);
  });
  const h = me.hero!;
  h.weapons[0] = { id: def.id, mag: def.magSize, reserve: def.magSize * 8 };
  h.weapons[1] = null;
  h.activeSlot = 0;
  let seq = 1;
  const taken = (): number[] => ts.map((t) => 1e6 - t.hp);
  const frame = (buttons: number): void => {
    const tk = taken();
    const t = def.special === 'multiTarget' && tk[1] < 400 ? ts[1] : (ts[tk.findIndex((v) => v < 400)] ?? ts[1]);
    const c = chestAim(def, t, dist);
    const a = aimAnglesFor(me.pos, c);
    w.setInput(h.playerId, { ...emptyInput(seq++), yaw: a.yaw, pitch: a.pitch, aimPoint: c, aimTargetId: t.id, buttons });
  };
  for (let i = 0; i < 20; i++) {
    frame(BTN_ADS);
    w.step();
  }
  let first = -1;
  let pressed = false;
  for (let i = 0; i < Math.ceil(30 / SIM_DT); i++) {
    const locked = def.special !== 'multiTarget' || (w.heroRt(me.id)?.adsT ?? 0) >= 0.95;
    const click: boolean = locked && (def.auto || (!pressed && h.nextFireAt <= w.time + SIM_DT + 1e-6));
    pressed = click;
    const mag = h.weapons[0]!.mag;
    frame(BTN_ADS | (click ? BTN_FIRE : 0));
    ts.forEach((t, k) => placeAt(w, t, (k - 1) * gap, dist / 2, 0));
    w.step();
    if (first < 0 && h.weapons[0]!.mag < mag) first = w.time - SIM_DT;
    if (first >= 0 && taken().every((v) => v >= 400)) return w.time - first;
  }
  return Infinity;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
