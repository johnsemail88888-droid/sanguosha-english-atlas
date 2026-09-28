// Weapon-vs-weapon 1v1 duels in the real sim (combat.ts hit resolution, spread / bloom / falloff /
// headshots / reloads, physics movement), driven by the real bot aim model (sim/ai/aimer.ts +
// difficulty.ts) and the real bot weapon handling (sim/ai/weaponUse.ts — the same code HeroBot
// uses), so both sides aim and shoot exactly as a bot of the chosen skill does in a match.
//
// Set-up: the flat 240 m range (range.ts); two 'dummy' heroes (no passives, no abilities, 400 HP,
// optionally both in the same armor) start facing each other `dist` m apart. Each is driven by a
// DuelBrain:
//  - aim: Aimer.track (reaction time, tracking lag, settling wandering error, lead + its noise,
//    head bias, the recoil it does not pull down);
//  - fire: weaponUse — the ADS policy (scopes always up), the sights-up gate, on target for this
//    weapon (projectiles on their lead point), burst control, a launcher never into its own blast,
//    semi-autos clicked at the gun's cycle rate (capped at the skill's click rate);
//  - the sidearm (a pistol, `sidearm`) inside a scope's / launcher's minimum range;
//  - move: strafe with the skill's amplitude and rhythm (×0.7 aimed; planted with a scope at 40 m+),
//    a radial correction holding the distance near `dist`, a dodge roll when a 方天 rocket is
//    locked on; no sprint / jump / cover / abilities / items.
// A duel ends when a hero goes down (400 HP gone) or after `timeout` s (draw). `runTtk` is the
// one-sided variant: the target strafes but never shoots (uncensored TTK samples).
import { Rng } from '../../../src/core/rng';
import type { BotDifficulty, Entity, InputFrame } from '../../../src/core/types';
import { BTN_ADS, BTN_FIRE, SIM_DT, emptyInput } from '../../../src/core/types';
import type { WeaponDef } from '../../../src/data/types';
import type { BotBrain, SimApi } from '../../../src/sim/api';
import { Aimer } from '../../../src/sim/ai/aimer';
import { difficultyProfile } from '../../../src/sim/ai/difficulty';
import type { DifficultyProfile } from '../../../src/sim/ai/difficulty';
import {
  AdsTracker,
  BurstControl,
  LOCK_DODGE,
  RECOIL_COMP,
  kickBlend,
  launcherTooClose,
  lockedRocketAt,
  onTarget,
  plantsFeet,
  sidearmInside,
  sightsReady,
  wantsAds,
} from '../../../src/sim/ai/weaponUse';
import { weaponDef } from '../../../src/sim/defs';
import type { World } from '../../../src/sim/world';
import { heroAt, median, placeAt, rangeWorld } from './range';

export { median };

const DEG = Math.PI / 180;
/** the two duellists' seats (both rebels: free to shoot each other) */
const SEAT_A = 2;
const SEAT_B = 3;

export interface DuelOpts {
  dist: number;
  skill?: BotDifficulty;
  /** armor id both heroes wear (null / undefined: none) */
  armor?: string | null;
  hp?: number;
  /** world + brains seed */
  seed: number;
  /** seconds before the duel is called a draw */
  timeout?: number;
  /** both heroes strafe (default true) */
  strafe?: boolean;
  /** side B never shoots (one-sided TTK) */
  passiveB?: boolean;
  /** a sidearm in slot 2 (default none: the weapon alone) */
  sidearm?: string | null;
}

export interface SideStats {
  /** trigger pulls (a pellet volley counts once) */
  shots: number;
  /** trigger pulls that damaged the opponent */
  hits: number;
  heads: number;
  dmg: number;
  /** sim time of the first shot since the duel began (-1: never fired) */
  firstShot: number;
  /** shots fired with the sidearm */
  sidearmShots: number;
}

export interface DuelResult {
  /** 0 = A downed B, 1 = B downed A, -1 = draw (timeout / both the same tick) */
  winner: 0 | 1 | -1;
  /** seconds from the start of the duel to the kill (or the timeout) */
  t: number;
  sides: [SideStats, SideStats];
}

export interface DuelBrainCfg {
  prof: DifficultyProfile;
  oppSeat: number;
  dist: number;
  strafe: boolean;
  passive: boolean;
}

/** Fixed-distance duel brain: the bot's aimer + weapon handling + strafing, nothing else. */
export class DuelBrain implements BotBrain {
  readonly aimer: Aimer;
  private readonly rng: Rng;
  private readonly adsTrack = new AdsTracker();
  private readonly burst = new BurstControl();
  private strafeSign = 1;
  private strafeUntil = 0;
  private nextClick = 0;
  private nextDodgeAt = 0;
  private start = -1;
  private seq = 1;
  private opp: Entity | undefined;

  constructor(
    private readonly cfg: DuelBrainCfg,
    seed: number,
  ) {
    this.aimer = new Aimer(cfg.prof, new Rng(seed));
    this.rng = new Rng((seed * 2654435761) >>> 0);
  }

  think(sim: SimApi, self: Entity, dt: number): InputFrame {
    const w = sim as unknown as World;
    const f: InputFrame = { ...emptyInput(this.seq++), yaw: self.yaw, pitch: self.pitch, actions: [] };
    this.opp ??= heroAt(w, this.cfg.oppSeat);
    const t = this.opp;
    const h = self.hero!;
    if (!t.alive || t.hero?.downed || t.hero?.dead || h.downed) return f;
    const now = sim.time;
    if (this.start < 0) this.start = now;
    const prof = this.cfg.prof;
    const d = Math.hypot(t.pos.x - self.pos.x, t.pos.z - self.pos.z);
    // the sidearm inside the primary's minimum range (C10-11); back once 3 m past it
    const primary = h.weapons[0] ? weaponDef(h.weapons[0].id) : undefined;
    const inside = sidearmInside(primary);
    if (h.weapons[1] && inside > 0) {
      if (h.activeSlot === 0 && d < inside) f.actions.push({ a: 'weapon', slot: 1 });
      else if (h.activeSlot === 1 && d >= inside + 3) f.actions.push({ a: 'weapon', slot: 0 });
    }
    const inst = h.weapons[h.activeSlot];
    const def: WeaponDef | undefined = inst ? weaponDef(inst.id) : undefined;
    const ads = wantsAds(def, d, prof);
    const o = this.aimer.track(sim, self, t, def, dt, ads);
    const adsT = this.adsTrack.update(def, ads && !(h.reloadUntil > now), dt, now, h.sprinting);
    f.yaw = o.yaw;
    f.pitch = o.pitch;
    f.aimPoint = o.point;
    if (o.errAngle <= Math.max(o.targetAngle * 1.5, 3 * DEG)) f.aimTargetId = t.id;
    if (ads) f.buttons |= BTN_ADS;
    this.move(f, self, d, h.ads, now, plantsFeet(def, d, h.ads));
    // a 方天 lock: roll out of it (C10-9)
    if (h.dodgeCharges > 0 && now >= this.nextDodgeAt && LOCK_DODGE[prof.name] > 0 && lockedRocketAt(sim, self)) {
      this.nextDodgeAt = now + 1.2;
      if (this.rng.next() < LOCK_DODGE[prof.name]) f.actions.push({ a: 'dodge' });
    }
    if (!def || this.cfg.passive) return f;
    if (now - this.start < prof.reaction) return f;
    const inRange = def.melee ? d <= (def.melee.range ?? 2) + 0.8 : d <= def.maxRange * 0.97;
    if (!inRange || launcherTooClose(def, d)) return f;
    if (!onTarget(def, o, ads, prof)) return f;
    if (ads && !sightsReady(def, adsT, d)) return f;
    const loaded = !!inst && (inst.mag > 0 || def.magSize <= 0) && !(h.reloadUntil > now);
    if (def.auto) {
      if (!this.burst.allow(now, this.rng, def, d, prof)) return f;
      f.buttons |= BTN_FIRE;
      if (loaded) this.aimer.kick(def, kickBlend(adsT), RECOIL_COMP[prof.name], now, def.fireRate * dt);
    } else if (now >= this.nextClick) {
      const rate = Math.min(def.fireRate, prof.clickRate);
      this.nextClick = now + 1 / Math.max(0.3, rate) + this.rng.next() * 0.05;
      f.buttons |= BTN_FIRE;
      if (loaded) this.aimer.kick(def, kickBlend(adsT), RECOIL_COMP[prof.name], now);
    }
    return f;
  }

  /** Strafe (HeroBot's rhythm and amplitude) around a fixed distance on the duel lane (x ≈ 0). */
  private move(f: InputFrame, self: Entity, d: number, aimed: boolean, now: number, planted: boolean): void {
    const prof = this.cfg.prof;
    let mx = 0;
    if (this.cfg.strafe && prof.strafe > 0 && !planted) {
      if (now >= this.strafeUntil) {
        this.strafeSign = this.rng.next() < 0.5 ? -1 : 1;
        this.strafeUntil = now + 0.45 + this.rng.next() * (1.3 - prof.strafe * 0.5);
      }
      // stay on the lane: never strafe further out than 6 m from x = 0
      const rightX = Math.cos(f.yaw) * this.strafeSign;
      if (Math.abs(self.pos.x) > 6 && self.pos.x * rightX > 0) {
        this.strafeSign = -this.strafeSign;
        this.strafeUntil = now + 0.6;
      }
      mx = this.strafeSign * prof.strafe * (aimed ? 0.7 : 1);
    }
    const err = d - this.cfg.dist;
    f.moveX = mx;
    f.moveZ = Math.abs(err) < 0.5 ? 0 : Math.max(-1, Math.min(1, err * 0.5));
  }
}

/** Build the duel world: A at (0, −dist/2) facing +z, B at (0, +dist/2) facing −z. */
export function duelWorld(weaponA: string, weaponB: string, o: DuelOpts): { w: World; a: Entity; b: Entity } {
  const prof = difficultyProfile(o.skill ?? 'normal');
  const base = { prof, dist: o.dist, strafe: o.strafe ?? true };
  const seed = o.seed >>> 0;
  const idle: BotBrain = { think: (_sim: SimApi, self: Entity): InputFrame => ({ ...emptyInput(0), yaw: self.yaw, actions: [] }) };
  const w = rangeWorld(
    (seed * 7919 + 17) >>> 0,
    {
      botFactory: (seat) => {
        if (seat === SEAT_A) return new DuelBrain({ ...base, oppSeat: SEAT_B, passive: false }, (seed * 31 + 1) >>> 0);
        if (seat === SEAT_B) return new DuelBrain({ ...base, oppSeat: SEAT_A, passive: !!o.passiveB }, (seed * 31 + 2) >>> 0);
        return idle;
      },
    },
    [],
  );
  const a = heroAt(w, SEAT_A);
  const b = heroAt(w, SEAT_B);
  placeAt(w, a, 0, -o.dist / 2, Math.PI); // yaw π faces +z
  placeAt(w, b, 0, o.dist / 2, 0);
  const hp = o.hp ?? 400;
  for (const [e, id] of [
    [a, weaponA],
    [b, weaponB],
  ] as const) {
    e.maxHp = hp;
    e.hp = hp;
    e.shield = 0;
    const h = e.hero!;
    h.weapons[0] = w.newWeapon(id);
    h.weapons[1] = o.sidearm ? w.newWeapon(o.sidearm) : null;
    h.activeSlot = 0;
    h.armor = o.armor ?? null;
    h.mount = null;
    h.items = [null, null, null, null];
  }
  w.drainEvents();
  return { w, a, b };
}

const newSide = (): SideStats => ({ shots: 0, hits: 0, heads: 0, dmg: 0, firstShot: -1, sidearmShots: 0 });
const isDown = (e: Entity): boolean => !e.alive || e.hero!.downed || e.hero!.dead || e.hp <= 0;

/** One duel. `weaponA` shoots from seat 2, `weaponB` from seat 3. */
export function runDuel(weaponA: string, weaponB: string, o: DuelOpts): DuelResult {
  const { w, a, b } = duelWorld(weaponA, weaponB, o);
  const sides: [SideStats, SideStats] = [newSide(), newSide()];
  const idx = new Map([
    [a.id, 0],
    [b.id, 1],
  ]);
  const primaries = [weaponA, weaponB];
  const t0 = w.time;
  const timeout = o.timeout ?? 25;
  const maxTicks = Math.ceil(timeout / SIM_DT) + 1;
  for (let i = 0; i < maxTicks; i++) {
    w.step();
    for (const ev of w.drainEvents()) {
      if (ev.t === 'shot') {
        const s = idx.get(ev.src);
        if (s === undefined) continue;
        sides[s].shots++;
        if (ev.weapon !== primaries[s]) sides[s].sidearmShots++;
        if (sides[s].firstShot < 0) sides[s].firstShot = w.time - t0;
      } else if (ev.t === 'hit' && ev.src !== undefined) {
        const s = idx.get(ev.src);
        if (s === undefined || idx.get(ev.target) === s || !idx.has(ev.target)) continue;
        if (ev.blocked) continue;
        sides[s].hits++;
        if (ev.head) sides[s].heads++;
        sides[s].dmg += ev.amount;
      }
    }
    const da = isDown(a);
    const db = isDown(b);
    if (da || db) {
      const t = w.time - t0;
      if (da && db) return { winner: -1, t, sides };
      return { winner: db ? 0 : 1, t, sides };
    }
  }
  return { winner: -1, t: timeout, sides };
}

/** A duel with the seats swapped on odd seeds (no seat-order bias); winner 0 = `a`. */
export function fairDuel(a: string, b: string, o: DuelOpts): DuelResult {
  if (o.seed % 2 === 0) return runDuel(a, b, o);
  const r = runDuel(b, a, o);
  return { winner: r.winner === -1 ? -1 : r.winner === 0 ? 1 : 0, t: r.t, sides: [r.sides[1], r.sides[0]] };
}

/** One-sided: `weapon` shoots a strafing, never-shooting target; seconds to down it (timeout = ∞). */
export function runTtk(weapon: string, o: Omit<DuelOpts, 'passiveB'>): { t: number; side: SideStats } {
  const r = runDuel(weapon, 'pistol', { ...o, passiveB: true });
  return { t: r.winner === 0 ? r.t : Infinity, side: r.sides[0] };
}

/** P(A's TTK < B's TTK) over every pairing of two sample sets (ties and double-∞ count ½). */
export function raceWinRate(ta: readonly number[], tb: readonly number[]): number {
  let wins = 0;
  let n = 0;
  for (const x of ta) {
    for (const y of tb) {
      n++;
      if (x < y) wins++;
      else if (x === y) wins += 0.5;
    }
  }
  return n ? wins / n : NaN;
}
