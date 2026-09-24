// 延时锦囊 Delayed tricks as deployables: 乐不思蜀 / 兵粮寸断 hidden traps and
// the 闪电 storm cloud. Each owns a custom hazard kind (unique names, so the
// generic 'trapDance' / 'lightningCloud' hazards other code spawns keep their
// generic behaviour).
//
//  traps   arm after `armTime`, last `lifetime`; the first enemy HERO (standing,
//          not vetoed by 谦逊, on the trap's level — not on a bridge or floor
//          above / below it) inside `radius` springs it once. Hidden from
//          enemies: the trap entity carries a keep-stealth instance, so snapshots
//          only send it to its owner's side and to viewers within the stealth
//          send range. Springing is a discrete trick: it runs outside the
//          periodic-field scope, so 无懈可击 cancels (and is consumed by) it.
//          Both trap cards are 'self'-targeted in data/items.ts so the public
//          itemUse event carries no placement point (docs/SIM_REQUESTS.md ITEMS-3);
//          use() lays the trap at the crosshair (≤ range) — or, for a bot, at the
//          spot its botShouldUse just picked (a charging enemy's path, behind
//          itself while retreating, a doorway / airdrop / loot pile when calm).
//  闪电    drifts toward the nearest hero whose position is public (owner
//          included; stealthed / downed heroes are ignored, so the cloud never
//          gives an invisible hero away) at `speed`, striking everything within
//          `radius` on its level — the owner too — every `strikeEvery` s.
import type { Vec3 } from '../../core/math';
import type { Entity, EntityId, StatusId } from '../../core/types';
import type { SimApi } from '../api';
import { ext } from '../ext';
import { registerHazardKind } from '../hazards';
import { registerItem } from './registry';
import {
  UNIT_KINDS,
  botView,
  centerOf,
  dropToGround,
  flatDist,
  isAlive,
  isStanding,
  itemParam,
  prm,
  publiclyVisible,
  vetoes,
} from './util';

export const TRAP_DANCE = 'lebusishuTrap';
export const TRAP_ROOT = 'bingliangTrap';
export const STORM_CLOUD = 'shandian';
/** trigger checks per second of an armed trap */
const TRAP_TICK = 0.1;
/** a trap only springs on units standing within this height of it (floors, bridges, decks) */
const TRAP_LEVEL = 1.5;
/** a bolt only reaches units within this height of the cloud's ground */
const CLOUD_LEVEL = 2.5;
/** the storm cloud only chases heroes this close (flat) */
const CLOUD_SEEK_RANGE = 80;

type Spring = (sim: SimApi, victim: Entity, ownerId: EntityId | undefined, params: Record<string, number>, at: Vec3) => void;

function registerTrapKind(kind: string, status: StatusId, spring: Spring): void {
  registerHazardKind({
    kind,
    tick(sim, h, affected) {
      const hz = h.hazard;
      if (!hz || hz.params.sprung || sim.time + 1e-9 < (hz.params.armAt ?? 0)) return true;
      const owner = h.ownerId !== undefined ? sim.get(h.ownerId) : undefined;
      let victim: Entity | undefined;
      let bd = Infinity;
      for (const u of affected) {
        if (u.kind !== 'hero' || !isStanding(u) || u.id === h.ownerId) continue;
        if (Math.abs(u.pos.y - h.pos.y) > TRAP_LEVEL) continue; // walking on the bridge above it
        if (owner && sim.isOwnSide(owner, u)) continue;
        if (vetoes(sim, u, status, h.ownerId)) continue; // 谦逊: walks over it untouched
        const d = flatDist(u.pos, h.pos);
        if (d < bd || (d === bd && victim && u.id < victim.id)) {
          bd = d;
          victim = u;
        }
      }
      if (!victim) return true;
      hz.params.sprung = 1;
      const at = { ...h.pos };
      const params = { ...hz.params };
      const ownerId = h.ownerId;
      const vid = victim.id;
      sim.removeEntity(h.id);
      // a trap springing is a discrete trick, not a periodic field tick: resolve it
      // outside the hazard pass so 无懈可击 applies (the owner stays the actor)
      sim.schedule(0, () => {
        const v = sim.get(vid);
        if (isStanding(v)) spring(sim, v, ownerId, params, at);
      });
      return true;
    },
  });
}

registerTrapKind(TRAP_DANCE, 'dance', (sim, v, ownerId, p, at) => {
  sim.applyStatus(v.id, 'dance', p.duration ?? 3, { sourceId: ownerId });
  sim.emit({ t: 'sfx', name: 'trap', pos: at });
});

registerTrapKind(TRAP_ROOT, 'root', (sim, v, ownerId, p, at) => {
  if (sim.applyStatus(v.id, 'root', p.rootTime ?? 2.5, { sourceId: ownerId }) && v.hero) {
    const keep = 1 - Math.max(0, Math.min(1, p.reserveLoss ?? 0.5));
    for (const wi of v.hero.weapons) if (wi && wi.reserve > 0) wi.reserve = Math.floor(wi.reserve * keep);
  }
  sim.emit({ t: 'sfx', name: 'trap', pos: at });
});

// ── per-world trap bookkeeping (bots: spacing, and the spot their hint picked) ──
interface TrapBook {
  /** live traps per owner */
  traps: Map<EntityId, EntityId[]>;
  /** sim time of each hero's last trap */
  lastLaid: Map<EntityId, number>;
  /** the spot a bot's botShouldUse picked, consumed by use() */
  planned: Map<EntityId, { at: Vec3; time: number }>;
  /** calm-time doorway scan cache */
  scans: Map<EntityId, { time: number; spot: Vec3 | null }>;
}

const books = new WeakMap<SimApi, TrapBook>();

function book(sim: SimApi): TrapBook {
  let b = books.get(sim);
  if (!b) {
    b = { traps: new Map(), lastLaid: new Map(), planned: new Map(), scans: new Map() };
    books.set(sim, b);
  }
  return b;
}

/** Live traps (either kind) laid by `ownerId`. */
export function ownTraps(sim: SimApi, ownerId: EntityId): Entity[] {
  const b = book(sim);
  const ids = b.traps.get(ownerId);
  if (!ids) return [];
  const out: Entity[] = [];
  for (const id of ids) {
    const t = sim.get(id);
    if (t && t.alive && t.hazard) out.push(t);
  }
  if (out.length !== ids.length) b.traps.set(ownerId, out.map((t) => t.id));
  return out;
}

/** Place a hidden trap hazard at `at`. */
function placeTrap(sim: SimApi, self: Entity, kind: string, at: Vec3, radius: number, armTime: number, lifetime: number, extra: Record<string, number>): Entity {
  const trap = sim.spawnHazard({
    kind,
    ownerId: self.id,
    pos: at,
    radius,
    duration: lifetime,
    tickEvery: TRAP_TICK,
    params: { ...extra, armAt: sim.time + Math.max(0, armTime) },
  });
  // hidden from enemies (snapshot stealth rules); never breaks, never ticks off
  trap.statuses.push({ id: 'stealth', until: sim.time + lifetime, stacks: 1, params: { keep: 1 }, sourceId: self.id });
  const b = book(sim);
  b.traps.set(self.id, [...ownTraps(sim, self.id).map((t) => t.id), trap.id]);
  b.lastLaid.set(self.id, sim.time);
  return trap;
}

/** Where the trap goes: the crosshair (≤ range), or the spot the bot's hint just picked. */
function trapSpot(sim: SimApi, self: Entity, point: Vec3 | undefined, range: number): Vec3 {
  if (point) return point;
  const b = book(sim);
  const plan = b.planned.get(self.id);
  if (plan) {
    b.planned.delete(self.id);
    if (sim.time - plan.time <= 2 && flatDist(plan.at, self.pos) <= range + 1.5) return plan.at;
  }
  return sim.aimPoint(self, range);
}

// ── bots: when and where to lay a trap ──────────────────────────────────────
/** a trap is laid in the path of / behind hostiles this close */
const TRAP_THREAT_RANGE = 25;
/** minimum seconds between two traps of the same bot while fighting */
const TRAP_GAP_FIGHT = 4;
/** …and while calm (doorways, airdrops, loot) */
const TRAP_GAP_CALM = 20;
/** re-scan for a doorway at most this often (s) */
const SCAN_EVERY = 3;

interface Threat {
  e: Entity;
  d: number;
}

/** Visible hostile-looking standing heroes around the bot, nearest first. */
function threatsNear(sim: SimApi, self: Entity, r: number): Threat[] {
  const x = ext(sim);
  const aim = sim.inputOf(self).aimTargetId;
  const out: Threat[] = [];
  for (const e of sim.queryRadius(self.pos, r, { kinds: ['hero'], exclude: [self.id] })) {
    if (!isStanding(e) || sim.isOwnSide(self, e) || !x.canSee(self, e)) continue;
    if (e.id !== aim && !sim.isHostileTo(self, e)) continue;
    out.push({ e, d: flatDist(self.pos, e.pos) });
  }
  return out.sort((a, b) => a.d - b.d || a.e.id - b.e.id);
}

/** A trap spot the bot can reach from where it stands: in range, in sight, on the ground, clear of its other traps. */
function usableSpot(sim: SimApi, self: Entity, p: Vec3, range: number, levelY: number): Vec3 | undefined {
  if (flatDist(p, self.pos) > range) return undefined;
  const g = dropToGround(sim, { x: p.x, y: levelY + 1.1, z: p.z });
  if (!Number.isFinite(g.y) || Math.abs(g.y - levelY) > 3) return undefined;
  const eye = sim.eyePos(self);
  if (!sim.lineOfSight(eye, { x: g.x, y: g.y + 0.5, z: g.z })) return undefined;
  for (const t of ownTraps(sim, self.id)) if (flatDist(t.pos, g) < t.radius * 2) return undefined;
  return g;
}

/** Free distance along a flat direction from `o` (≤ max). */
function freeDist(sim: SimApi, o: Vec3, dx: number, dz: number, max: number): number {
  const hit = sim.raycast(o, { x: dx, y: 0, z: dz }, max, { entities: false });
  return hit ? hit.dist : max;
}

/**
 * Width of the narrowest passage through `p` (a doorway, a gate, a bridge
 * between railings, an alley), Infinity in the open or in a dead-end corner.
 */
function passageWidth(sim: SimApi, p: Vec3): number {
  const o = { x: p.x, y: p.y + 1, z: p.z };
  const SIDE = 3;
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 4;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const d1 = freeDist(sim, o, cx, cz, SIDE);
    if (d1 >= SIDE) continue;
    const d2 = freeDist(sim, o, -cx, -cz, SIDE);
    if (d2 >= SIDE) continue;
    const w = d1 + d2;
    if (w >= best) continue;
    // a way through, not a closet: open both ways across the gap
    if (freeDist(sim, o, -cz, cx, SIDE) < SIDE || freeDist(sim, o, cz, -cx, SIDE) < SIDE) continue;
    best = w;
  }
  return best;
}

/** Calm: an unopened airdrop / crate, a loot pile, or a doorway within reach. */
function calmSpot(sim: SimApi, self: Entity, range: number): Vec3 | undefined {
  // things enemies will come for
  let bait: Vec3 | undefined;
  let baitScore = 0;
  for (const e of sim.queryRadius(self.pos, range, { kinds: ['airdrop', 'crate', 'loot'] })) {
    let score = 0;
    if (e.kind === 'airdrop' && e.crate && !e.crate.opened && e.onGround) score = 10;
    else if (e.kind === 'crate' && e.crate && !e.crate.opened) score = 1 + e.crate.tier;
    else if (e.kind === 'loot') score = sim.queryRadius(e.pos, 3, { kinds: ['loot'] }).length >= 2 ? 2 : 0;
    if (score <= baitScore) continue;
    const p = usableSpot(sim, self, e.pos, range, e.pos.y);
    if (!p) continue;
    bait = p;
    baitScore = score;
  }
  if (bait) return bait;
  // a doorway / narrow way nearby (cached: raycasts)
  const b = book(sim);
  const cached = b.scans.get(self.id);
  if (cached && sim.time - cached.time < SCAN_EVERY) return cached.spot && usableSpot(sim, self, cached.spot, range, self.pos.y) ? cached.spot : undefined;
  let spot: Vec3 | null = null;
  let bw = 4.5; // passages up to 4.5 m wide
  const cands: Vec3[] = [{ ...self.pos }];
  for (const r of [4, Math.max(4.5, range - 1)]) {
    for (let i = 0; i < 8; i++) {
      const a = self.yaw + (i * Math.PI) / 4;
      cands.push({ x: self.pos.x - Math.sin(a) * r, y: self.pos.y, z: self.pos.z - Math.cos(a) * r });
    }
  }
  for (const c of cands) {
    const p = usableSpot(sim, self, c, range, self.pos.y);
    if (!p) continue;
    const w = passageWidth(sim, p);
    if (w < bw) {
      bw = w;
      spot = p;
      if (w < 3) break;
    }
  }
  b.scans.set(self.id, { time: sim.time, spot });
  return spot ?? undefined;
}

/**
 * Where a bot should lay a trap right now, if anywhere:
 *  1. a visible hostile hero charging at it: on the charger's path, ≥ armTime ahead of it;
 *  2. retreating from a hostile within 25 m (or hurt and just hit): right behind itself;
 *  3. calm (nobody hostile within 30 m, not hit for 5 s): an airdrop / crate / loot pile
 *     enemies will come for, else the narrowest doorway or passage within reach.
 */
function planTrap(sim: SimApi, self: Entity, itemId: string): Vec3 | undefined {
  if (!isStanding(self)) return undefined;
  const range = itemParam(itemId, 'range', 8);
  const arm = itemParam(itemId, 'armTime', 1);
  const b = book(sim);
  const since = sim.time - (b.lastLaid.get(self.id) ?? -Infinity);
  if (since < TRAP_GAP_FIGHT) return undefined;
  const threats = threatsNear(sim, self, TRAP_THREAT_RANGE + 5);
  const near = threats.filter((t) => t.d <= TRAP_THREAT_RANGE);
  const v = botView(sim, self);
  for (const { e: t, d } of near) {
    if (d < 1.5) continue;
    const ux = (self.pos.x - t.pos.x) / d;
    const uz = (self.pos.z - t.pos.z) / d;
    const closing = t.vel.x * ux + t.vel.z * uz;
    if (closing <= 1.5) continue;
    // 1. on its path: where it will be once the trap is armed (and the 0.5 s placing is done)
    for (let tau = arm + 0.6; tau <= 4; tau += 0.25) {
      const p = { x: t.pos.x + t.vel.x * tau, y: t.pos.y, z: t.pos.z + t.vel.z * tau };
      if (flatDist(p, self.pos) > range - 0.5) continue;
      const s = usableSpot(sim, self, p, range, t.pos.y);
      if (s) return s;
      break;
    }
    // …or on the straight line between us, as far out as it can be armed in time
    const along = Math.max(1.5, Math.min(range - 0.5, d - closing * (arm + 0.6)));
    const s = usableSpot(sim, self, { x: self.pos.x - ux * along, y: self.pos.y, z: self.pos.z - uz * along }, range, self.pos.y);
    if (s) return s;
  }
  // 2. retreating (or hurt and under fire): right behind me, toward the pursuer
  const speed = Math.hypot(self.vel.x, self.vel.z);
  for (const { e: t, d } of near) {
    const ux = (self.pos.x - t.pos.x) / Math.max(1e-6, d);
    const uz = (self.pos.z - t.pos.z) / Math.max(1e-6, d);
    const away = self.vel.x * ux + self.vel.z * uz;
    const fleeing = speed > 2 && away > 1.5;
    const pinned = v.hpFrac < 0.5 && v.since < 3;
    if (!fleeing && !pinned) continue;
    const back = fleeing ? 1.5 : Math.min(3, d * 0.5);
    const bx = fleeing ? -self.vel.x / speed : -ux;
    const bz = fleeing ? -self.vel.z / speed : -uz;
    const s = usableSpot(sim, self, { x: self.pos.x + bx * back, y: self.pos.y, z: self.pos.z + bz * back }, range, self.pos.y);
    if (s) return s;
  }
  // 3. calm: bait or a doorway
  if (threats.length > 0 || v.since < 5 || since < TRAP_GAP_CALM) return undefined;
  if (ownTraps(sim, self.id).length >= 2) return undefined;
  return calmSpot(sim, self, range);
}

function trapHint(sim: SimApi, self: Entity, itemId: string): boolean {
  const at = planTrap(sim, self, itemId);
  const b = book(sim);
  if (!at) {
    b.planned.delete(self.id);
    return false;
  }
  b.planned.set(self.id, { at, time: sim.time });
  return true;
}

// ── 乐不思蜀 ──────────────────────────────────────────────────────────────────
registerItem({
  id: 'lebusishu',
  use(ctx) {
    const { sim, self } = ctx;
    const at = trapSpot(sim, self, ctx.point, prm(ctx, 'range', ctx.def.range || 8));
    placeTrap(sim, self, TRAP_DANCE, at, prm(ctx, 'radius', 2.5), prm(ctx, 'armTime', 1), prm(ctx, 'lifetime', 60), {
      duration: prm(ctx, 'duration', 3),
    });
    return true;
  },
  botShouldUse(sim, self) {
    return trapHint(sim, self, 'lebusishu');
  },
});

// ── 兵粮寸断 ──────────────────────────────────────────────────────────────────
registerItem({
  id: 'bingliang',
  use(ctx) {
    const { sim, self } = ctx;
    const at = trapSpot(sim, self, ctx.point, prm(ctx, 'range', ctx.def.range || 8));
    placeTrap(sim, self, TRAP_ROOT, at, prm(ctx, 'radius', 2.5), prm(ctx, 'armTime', 1), prm(ctx, 'lifetime', 60), {
      rootTime: prm(ctx, 'rootTime', 2.5),
      reserveLoss: prm(ctx, 'reserveLoss', 0.5),
    });
    return true;
  },
  botShouldUse(sim, self) {
    return trapHint(sim, self, 'bingliang');
  },
});

// ── 闪电: wandering storm cloud ─────────────────────────────────────────────
/** The hero the cloud drifts toward: the nearest one whose whereabouts are public. */
function cloudQuarry(sim: SimApi, h: Entity): Entity | undefined {
  let best: Entity | undefined;
  let bd = CLOUD_SEEK_RANGE;
  for (const e of sim.heroes()) {
    if (!isStanding(e) || !publiclyVisible(sim, e)) continue;
    const d = flatDist(e.pos, h.pos);
    if (d < bd || (d === bd && best && e.id < best.id)) {
      bd = d;
      best = e;
    }
  }
  return best;
}

registerHazardKind({
  kind: STORM_CLOUD,
  update(sim, h, dt) {
    const hz = h.hazard;
    const speed = hz?.params.drift ?? 0;
    if (!hz || !(speed > 0) || !(dt > 0)) return;
    const t = cloudQuarry(sim, h);
    if (!t) return; // nobody in plain sight: it hangs where it is
    const d = flatDist(t.pos, h.pos);
    if (d > 0.3) {
      const step = Math.min(d, speed * dt);
      h.pos.x += ((t.pos.x - h.pos.x) / d) * step;
      h.pos.z += ((t.pos.z - h.pos.z) / d) * step;
    }
    // ride at its quarry's level: the roof / deck / floor under the cloud, not the terrain below it
    const g = dropToGround(sim, { x: h.pos.x, y: t.pos.y + 1.1, z: h.pos.z });
    if (Number.isFinite(g.y)) h.pos.y = g.y;
  },
  tick(sim, h) {
    const hz = h.hazard;
    if (!hz) return true;
    const at = { ...h.pos };
    const radius = hz.radius;
    const damage = hz.params.strikeDamage ?? 70;
    const ownerId = h.ownerId;
    // a lightning strike is a discrete effect (无懈可击 applies): resolve it after the hazard pass
    sim.schedule(0, () => strike(sim, at, radius, damage, ownerId));
    return true;
  },
});

function strike(sim: SimApi, at: Vec3, radius: number, damage: number, ownerId: EntityId | undefined): void {
  sim.emit({ t: 'explosion', pos: { ...at }, radius, kind: 'thunder' });
  for (const u of sim.queryRadius(at, radius, { kinds: UNIT_KINDS })) {
    if (!isAlive(u) || Math.abs(u.pos.y - at.y) > CLOUD_LEVEL) continue;
    sim.dealDamage({ targetId: u.id, sourceId: ownerId, amount: damage, type: 'thunder', canDodge: false, abilityId: 'shandian', pos: centerOf(u) });
  }
}

registerItem({
  id: 'shandian',
  use(ctx) {
    const { sim, self } = ctx;
    const at = ctx.point ?? sim.aimPoint(self, prm(ctx, 'range', ctx.def.range || 15));
    const every = Math.max(0.2, prm(ctx, 'strikeEvery', 3));
    const cloud = sim.spawnHazard({
      kind: STORM_CLOUD,
      ownerId: self.id,
      pos: at,
      radius: prm(ctx, 'radius', 3),
      duration: prm(ctx, 'lifetime', 18),
      tickEvery: every,
      // `drift`, not the generic `seek` (which would chase invisible heroes and give them away)
      params: { drift: prm(ctx, 'speed', 3.5), strikeDamage: prm(ctx, 'damage', 70) },
      dtype: ctx.def.dtype ?? 'thunder',
      affectsOwner: true,
    });
    // the first bolt falls one period after the cloud forms
    if (cloud.hazard) cloud.hazard.nextTickAt = sim.time + every;
    return true;
  },
  botShouldUse(sim, self) {
    const v = botView(sim, self);
    const t = v.target;
    if (!t?.hero || t.hero.downed || !v.los) return false;
    const range = itemParam('shandian', 'range', 15);
    // drop it on the foe from a safe distance, healthy enough to survive a stray bolt
    return v.dist >= 8 && v.dist <= range && v.hpFrac > 0.4;
  },
});
