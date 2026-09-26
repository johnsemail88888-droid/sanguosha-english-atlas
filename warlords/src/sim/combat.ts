// Weapons, hit resolution and the damage pipeline.
//
// Damage pipeline (dealDamage), in order:
//   own-side / friendly-fire guard → attacker beforeDamageDealt hooks →
//   untargetable / invuln → dodge i-frames, 八卦, dodgeChance, evasion
//   passives (skipped when canDodge=false or the attacker is 'undodgeable') →
//   无懈可击 (hostile non-weapon ability hits) → outgoing mods (dmgBoost,
//   drunk, weapon special, troop multiplier, attacker modifyOutgoing) →
//   incoming mods (armor unless pierce/ignoreArmor, dmgTakenUp/Down, mount
//   damageTakenMul, victim modifyIncoming e.g. 流离 redirect) → shield absorb →
//   HP (or bleed-out time while downed) → hit event → reflect / thorns
//   (noReflect prevents loops) → lifesteal → 'chained' spread for fire/thunder →
//   onDamageTaken / onDamageDealt hooks → knockback → downed / death.
// Redirected hits (护驾, 流离 via SimExt.redirectDamage) and reflect / thorns
// skip the attacker's beforeDamageDealt hooks and outgoing step (their amount is
// already final on the attacker's side) and are never cancelled by 无懈可击.
import type { Vec3 } from '../core/math';
import type { DamageType, Entity, EntityId, InputFrame, WeaponInstance } from '../core/types';
import { BTN_FIRE, SIM_DT } from '../core/types';
import type { WeaponDef } from '../data/types';
import type { DamageRequest, DamageResult, ProjectileSpec, RayHit, SimApi } from './api';
import { BULLET_EVASION_CAP } from '../data';
import { armorDef, heroDef, mountDef, usesAmmo, warnOnce, weaponDef } from './defs';
import type { HitscanOptions } from './ext';
import { flingGear } from './items/util';
import { rayCylinder, raycastStatic, raySphere } from './physics';
import type { StaticHit } from './physics';
import { findStatus, nullifyEffect, removeStatusIf, statusValue } from './status';
import type { HeroRuntime, World } from './world';

/** seconds of bleed-out removed per point of damage taken while downed */
export const DOWNED_DAMAGE_TO_SECONDS = 0.1;
/** lag compensation window */
export const LAG_COMP_MAX_TICKS = 8;
const MAX_SHOTS_PER_TICK = 4;
const BURST_RESET = 0.35;

export const DAMAGEABLE: Readonly<Record<Entity['kind'], boolean>> = {
  hero: true,
  troop: true,
  npc: true,
  turret: true,
  projectile: false,
  loot: false,
  crate: false,
  airdrop: false,
  hazard: false,
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** stealth without params.keep breaks when its owner fires */
const breaksOnFire = (s: { params?: Record<string, number> }): boolean => !(s.params?.keep ?? 0);

export const isBulletDamage = (req: DamageRequest): boolean =>
  req.weaponId !== undefined && (req.type === 'normal' || req.type === 'pierce');

// ── Lag compensation history ────────────────────────────────────────────────
const HIST = LAG_COMP_MAX_TICKS + 2;

export class LagHistory {
  private buf = new Map<EntityId, Float64Array>();

  record(e: Entity, tick: number): void {
    let b = this.buf.get(e.id);
    if (!b) {
      b = new Float64Array(HIST * 4).fill(-1);
      this.buf.set(e.id, b);
    }
    const o = (tick % HIST) * 4;
    b[o] = tick;
    b[o + 1] = e.pos.x;
    b[o + 2] = e.pos.y;
    b[o + 3] = e.pos.z;
  }

  /** Position of `e` at the end of `tick` (falls back to the current position). */
  posAt(e: Entity, tick: number, out: Vec3): Vec3 {
    const b = this.buf.get(e.id);
    if (b) {
      const o = (tick % HIST) * 4;
      if (b[o] === tick) {
        out.x = b[o + 1];
        out.y = b[o + 2];
        out.z = b[o + 3];
        return out;
      }
    }
    out.x = e.pos.x;
    out.y = e.pos.y;
    out.z = e.pos.z;
    return out;
  }

  remove(id: EntityId): void {
    this.buf.delete(id);
  }
}

// ── Entity hitboxes ─────────────────────────────────────────────────────────
export interface EntityRayHit {
  t: number;
  entity: Entity;
  head: boolean;
}

const tmpPos = { x: 0, y: 0, z: 0 };
const cylHit: StaticHit = { t: 0, nx: 0, ny: 0, nz: 0 };

/**
 * Hit-test size of a hero on horseback (= horse cavalry, sim/troops.ts unitSize):
 * render/camera/pick.ts mirrors it. The physics capsule stays CHAR_RADIUS × CHAR_HEIGHT.
 */
export const MOUNTED_HIT = { radius: 0.6, height: 2.3 } as const;

/** A hero drawn on horseback (a mount item, or 马超 / 吕布's permanent mount) — not while downed. */
export function ridesForHits(e: Entity): boolean {
  const h = e.hero;
  if (!h || h.downed) return false;
  if (h.mount) return true;
  return heroDef(h.heroId).visual.mount !== undefined;
}

/** Hit-test radius of an entity (riders are wider than their physics capsule). */
export const hitRadius = (e: Entity): number => (ridesForHits(e) ? MOUNTED_HIT.radius : e.radius);

export interface Hitbox {
  bodyTop: number;
  headY: number;
  headR: number;
  height: number;
}

/** Hitbox geometry of an entity: body cylinder + (optional) head sphere (into `out` when given). */
export function hitbox(e: Entity, out: Hitbox = { bodyTop: 0, headY: 0, headR: 0, height: 0 }): Hitbox {
  const downed = e.hero?.downed === true;
  const height = downed ? 0.6 : ridesForHits(e) ? MOUNTED_HIT.height : e.height;
  out.height = height;
  if (e.kind === 'turret') {
    out.bodyTop = height;
    out.headY = -1;
    out.headR = 0;
    return out;
  }
  const headR = downed ? 0.2 : Math.max(0.15, 0.22 * (height / 1.8));
  out.bodyTop = height - headR * 1.6;
  out.headY = height - headR;
  out.headR = headR;
  return out;
}

const hbTmp: Hitbox = { bodyTop: 0, headY: 0, headR: 0, height: 0 };

/** Ray vs every hittable entity (optionally rewound to `rewindTick`). */
export function raycastEntities(
  w: World,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
  skip: ((e: Entity) => boolean) | null,
  rewindTick?: number,
  inflate = 0,
): EntityRayHit | null {
  let best = maxDist;
  let bestE: Entity | null = null;
  let bestHead = false;
  const list = w.hittables();
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e.alive || e.hero?.dead) continue;
    if (skip && skip(e)) continue;
    if (findStatus(e, 'untargetable', w.time)) continue;
    const p = rewindTick !== undefined ? w.history.posAt(e, rewindTick, tmpPos) : e.pos;
    const hb = hitbox(e, hbTmp);
    const r = hitRadius(e) + inflate;
    // bounding-sphere reject
    const cy = p.y + hb.height * 0.5;
    const cx0 = p.x - ox;
    const cy0 = cy - oy;
    const cz0 = p.z - oz;
    const tc = cx0 * dx + cy0 * dy + cz0 * dz;
    const br = r + hb.height * 0.5 + 0.1;
    if (tc < -br || tc > best + br) continue;
    const perp2 = cx0 * cx0 + cy0 * cy0 + cz0 * cz0 - tc * tc;
    if (perp2 > br * br) continue;
    let t = rayCylinder(ox, oy, oz, dx, dy, dz, p.x, p.z, r, p.y, p.y + hb.bodyTop, best, cylHit);
    let head = false;
    if (hb.headR > 0) {
      const th = raySphere(ox, oy, oz, dx, dy, dz, p.x, p.y + hb.headY, p.z, hb.headR + inflate, best);
      if (th >= 0 && (t < 0 || th < t)) {
        t = th;
        head = true;
      }
    }
    if (t >= 0 && t < best) {
      best = t;
      bestE = e;
      bestHead = head;
    }
  }
  return bestE ? { t: best, entity: bestE, head: bestHead } : null;
}

const staticHit: StaticHit = { t: 0, nx: 0, ny: 0, nz: 0 };

/** Combined world + entity raycast. */
export function raycastAll(
  w: World,
  from: Vec3,
  dir: Vec3,
  maxDist: number,
  skip: ((e: Entity) => boolean) | null,
  entities = true,
  rewindTick?: number,
): RayHit | null {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len < 1e-9 || !(maxDist > 0)) return null;
  const dx = dir.x / len;
  const dy = dir.y / len;
  const dz = dir.z / len;
  let best = maxDist;
  let hit: RayHit | null = null;
  if (raycastStatic(w.cw, from.x, from.y, from.z, dx, dy, dz, maxDist, staticHit)) {
    best = staticHit.t;
    hit = {
      point: { x: from.x + dx * best, y: from.y + dy * best, z: from.z + dz * best },
      normal: { x: staticHit.nx, y: staticHit.ny, z: staticHit.nz },
      dist: best,
    };
  }
  if (entities) {
    const eh = raycastEntities(w, from.x, from.y, from.z, dx, dy, dz, best, skip, rewindTick);
    if (eh && eh.t <= best) {
      hit = {
        point: { x: from.x + dx * eh.t, y: from.y + dy * eh.t, z: from.z + dz * eh.t },
        normal: { x: -dx, y: -dy, z: -dz },
        dist: eh.t,
        entityId: eh.entity.id,
        head: eh.head,
      };
    }
  }
  return hit;
}

// ── Damage pipeline ─────────────────────────────────────────────────────────
/**
 * One hit being resolved (SimExt.redirectDamage): the request as it came in, the
 * request object the victim's hooks see, and the amount after the attacker's
 * outgoing step (before any incoming modifier).
 */
export interface DamageFrame {
  reqIn: DamageRequest;
  req: DamageRequest;
  outgoing: number;
  /** the victim handed this hit to another unit */
  redirected: boolean;
}

/** Hits that must not trigger the attacker's outgoing step again (their amount is final). */
const isReflectHit = (req: DamageRequest): boolean => req.abilityId === 'status:reflect' || req.abilityId === 'status:thorns';

/**
 * 铁索连环 bookkeeping of one strike (credit, abilityId) in one tick (QUN-7):
 * the chained units it hit directly, and those it reached through the chain.
 */
export interface ChainStrike {
  direct: Set<EntityId>;
  spread: Set<EntityId>;
}

/** Is this a fire / thunder ability hit that 铁索连环 spreads and dedupes (QUN-7)? */
const chainDedupKey = (req: DamageRequest, creditId: EntityId | undefined): string | undefined =>
  (req.type === 'fire' || req.type === 'thunder') && req.weaponId === undefined && creditId !== undefined ? `${creditId}|${req.abilityId ?? ''}` : undefined;

export function dealDamage(w: World, reqIn: DamageRequest): DamageResult {
  const depth = w.dmgDepth;
  try {
    return resolveDamage(w, reqIn);
  } finally {
    w.dmgDepth = depth;
  }
}

/** Push a frame for the hit being resolved (frames are pooled per depth: no garbage per hit). */
function pushFrame(w: World, reqIn: DamageRequest, req: DamageRequest, outgoing: number): DamageFrame {
  const d = w.dmgDepth++;
  let f = w.dmgStack[d];
  if (!f) {
    f = { reqIn, req, outgoing, redirected: false };
    w.dmgStack[d] = f;
  } else {
    f.reqIn = reqIn;
    f.req = req;
    f.outgoing = outgoing;
    f.redirected = false;
  }
  return f;
}

function resolveDamage(w: World, reqIn: DamageRequest): DamageResult {
  const res: DamageResult = { dealt: 0, absorbed: 0, killed: false };
  const target = w.ents.get(reqIn.targetId);
  if (!target || !target.alive || !DAMAGEABLE[target.kind] || target.hero?.dead) return res;
  if (!(reqIn.amount > 0) || !Number.isFinite(reqIn.amount)) return res;
  const req: DamageRequest = { ...reqIn };
  const now = w.time;
  const type: DamageType = req.type;
  const isZone = type === 'zone';
  const isTrue = type === 'true';
  const src = req.sourceId !== undefined ? w.ents.get(req.sourceId) : undefined;
  const creditId = w.creditOf(req.sourceId);
  const credit = creditId !== undefined ? w.ents.get(creditId) : undefined;
  const pos = req.pos ?? w.centerOf(target);
  // amount already final on the attacker's side: handed over (护驾 / 流离) or reflected back
  const passThrough = req.redirected === true || isReflectHit(req);

  // Own side never hurts itself (commander ⇄ own troops/turrets/summons), except true self-damage.
  if (!isZone && req.sourceId !== undefined && req.sourceId !== target.id && creditId !== undefined) {
    if (creditId === w.creditOf(target.id)) return res;
    if (!w.settings.friendlyFire && w.sameFaction(creditId, target.id)) return res;
  }
  // 铁索连环: a chained unit that already took this strike through the chain this tick
  // is not hit again by the same strike directly (an area blast over N chained units);
  // repeated direct hits (two projectiles of one cast, overlapping blasts) all land
  const chained = (type === 'fire' || type === 'thunder') && findStatus(target, 'chained', now) !== undefined;
  const chainKey = chained ? chainDedupKey(req, creditId) : undefined;
  if (chainKey !== undefined && !w.chainSpreading && w.chainStrikeThisTick(chainKey)?.spread.has(target.id)) return res;
  if (creditId !== undefined && creditId !== target.id) w.recordAttack(target.id, creditId, req.sourceId);

  // attacker pre-hook (may mutate req: canDodge, ignoreArmor, amount)
  if (src && src.kind === 'hero' && src !== target && !passThrough) w.hooks.beforeDamageDealt(src, target, req);
  let amount = req.amount;

  const blockedEvent = (blocked: NonNullable<DamageResult['blocked']>): DamageResult => {
    res.blocked = blocked;
    w.emit({ t: 'hit', target: target.id, src: creditId ?? req.sourceId, amount: 0, dtype: type, pos, head: req.head, blocked });
    if (src && src.kind === 'hero' && blocked !== 'redirect') w.onShotBlocked(src, req, blocked);
    return res;
  };

  // 1. invulnerability
  if (findStatus(target, 'invuln', now)) return blockedEvent('invuln');
  if (!isZone && findStatus(target, 'untargetable', now)) return blockedEvent('invuln');

  // 2. dodge: i-frames, 八卦, dodgeChance
  const bullet = isBulletDamage(req);
  const attackerUndodgeable =
    (src !== undefined && findStatus(src, 'undodgeable', now) !== undefined) ||
    (src === undefined && credit !== undefined && findStatus(credit, 'undodgeable', now) !== undefined);
  const canDodge = req.canDodge !== false && !isZone && !isTrue && !attackerUndodgeable;
  if (canDodge) {
    if (target.forced?.invuln && now < target.forced.until) return blockedEvent('dodge');
    if (target.hero && now < target.hero.dodgingUntil) return blockedEvent('dodge');
    if (bullet) {
      const evade = bulletEvadeChance(w, target, src, req);
      if (evade > 0 && w.rng.chance(evade)) return blockedEvent('dodge');
    }
  }

  // 2b. 无懈可击: a hostile hero's ability / item hit (not a weapon hit, DoT tick,
  // reflect or zone) is cancelled whole — no damage, status or knockback.
  if (isNullifiableHit(req, isZone) && nullifyEffect(w, target, req.sourceId)) {
    res.blocked = 'nullify';
    return res;
  }

  // 3. outgoing modifiers (not for redirected / reflected hits: their amount is final)
  if (!isZone && src && !passThrough) {
    amount *= statusValue(src, 'dmgBoost', now, 1);
    const direct = !req.noReflect && !(req.abilityId?.startsWith('status:') ?? false);
    if (direct && src.statuses.length > 0) {
      // 酒 (weaponOnly) doubles and is consumed only by weapon hits
      const weaponHit = req.weaponId !== undefined;
      const applies = (s: { params?: Record<string, number> }): boolean => weaponHit || !(s.params?.weaponOnly ?? 0);
      let drunkMul = 0;
      for (const s of src.statuses) {
        if (s.id === 'drunk' && s.until > now && applies(s)) drunkMul = Math.max(drunkMul, s.params?.mul ?? 2);
      }
      if (drunkMul > 0) {
        amount *= drunkMul;
        removeStatusIf(w, src, 'drunk', applies);
      }
    }
    if ((src.kind === 'troop' || src.kind === 'turret') && credit?.hero) amount *= w.modifiers(credit.id).troopDmgMul;
    if (req.weaponId) amount *= weaponOutgoingMul(w, weaponDef(req.weaponId), src, target);
    // 离间: the shots a charm forces onto its target hit softer (params.dmgMul, COMBAT-6)
    if (req.weaponId && src.statuses.length > 0) {
      const ch = findStatus(src, 'charm', now);
      if (ch?.params?.dmgMul !== undefined && ch.params.targetId === target.id) amount *= Math.max(0, ch.params.dmgMul);
    }
    if (src.kind === 'hero') amount = w.hooks.modifyOutgoing(src, target, req, amount);
  }
  const frame = pushFrame(w, reqIn, req, amount);

  // 4. incoming modifiers
  let armorBlocked = false;
  if (!isZone) {
    const pierce =
      isTrue ||
      type === 'pierce' ||
      req.ignoreArmor === true ||
      (src !== undefined && findStatus(src, 'pierce', now) !== undefined);
    const h = target.hero;
    if (h && h.armor && !pierce) {
      const before = amount;
      amount = applyArmor(w, target, h.armor, req, bullet, amount, src);
      if (amount <= 0 && before > 0) armorBlocked = true;
    }
    if (!isTrue) {
      amount *= statusValue(target, 'dmgTakenUp', now, 1);
      amount *= statusValue(target, 'dmgTakenDown', now, 1);
      if (h?.mount) {
        const m = mountDef(h.mount);
        if (m) amount *= m.damageTakenMul;
      }
    }
    if (target.kind === 'hero' && amount > 0) amount = w.hooks.modifyIncoming(target, src, req, amount);
  }
  // handed to another unit (SimExt.redirectDamage — 流离): the shooter sees it deflected
  if (frame.redirected && !(amount > 0)) return blockedEvent('redirect');
  // negated entirely: by armor (藤甲 vs troops…) or by an ability / multiplier (空城…)
  if (!(amount > 0)) return blockedEvent(armorBlocked ? 'armor' : 'invuln');

  // 5. shield (无双: only the hero's own hits pierce — not its troops / turrets / summons)
  if (!isZone && !isTrue && target.shield > 0) {
    const pierceFrac = src?.hero ? Math.min(1, Math.max(0, w.modifiers(src.id).shieldPierce)) : 0;
    const absorbable = amount * (1 - pierceFrac);
    const absorbed = Math.min(target.shield, absorbable);
    target.shield -= absorbed;
    amount -= absorbed;
    res.absorbed = absorbed;
    if (target.shield <= 1e-6) {
      target.shield = 0;
      w.removeStatus(target.id, 'shield');
    }
  }

  // 6. HP (or bleed-out while downed)
  const h = target.hero;
  if (amount > 0) {
    if (h?.downed) {
      h.downedUntil -= amount * DOWNED_DAMAGE_TO_SECONDS;
      res.dealt = amount;
    } else {
      const before = target.hp;
      target.hp = Math.max(0, target.hp - amount);
      res.dealt = before - target.hp;
    }
  }
  const total = res.dealt + res.absorbed;
  target.lastDamagedBy = creditId ?? req.sourceId;
  target.lastDamagedAt = now;
  // fully soaked by a shield: report it (followUp refunds, ability code) — the hit still "lands" for hooks/specials
  if (res.dealt <= 0 && res.absorbed > 0) {
    res.blocked = 'shield';
    if (src && src.kind === 'hero') w.onShotBlocked(src, req, 'shield');
  }
  w.emit({
    t: 'hit',
    target: target.id,
    src: creditId ?? req.sourceId,
    amount: Math.round(total * 10) / 10,
    dtype: type,
    pos,
    head: req.head,
    blocked: res.blocked,
  });
  // stats: HP actually removed (finishing a downed hero only shortens its bleed-out)
  if (credit?.hero && credit !== target && !h?.downed) credit.hero.stats.damage += res.dealt;

  // 7. reflect / thorns
  if (!req.noReflect && src && src !== target && src.alive && total > 0 && !isZone && target.statuses.length > 0) {
    const refl = bullet ? statusValue(target, 'reflect', now, 0) : 0;
    if (refl > 0) {
      dealDamage(w, {
        targetId: src.id,
        sourceId: target.id,
        amount: total * refl,
        type: 'normal',
        noReflect: true,
        canDodge: false,
        ignoreArmor: true,
        abilityId: 'status:reflect',
      });
    }
    const thorns = statusValue(target, 'thorns', now, 0);
    if (thorns > 0 && src.alive) {
      dealDamage(w, {
        targetId: src.id,
        sourceId: target.id,
        amount: total * thorns,
        type: 'normal',
        noReflect: true,
        canDodge: false,
        ignoreArmor: true,
        abilityId: 'status:thorns',
      });
    }
  }

  // 8. lifesteal
  if (src && src.alive && res.dealt > 0 && src !== target) {
    let frac = statusValue(src, 'lifesteal', now, 0);
    if (req.weaponId) {
      const wd = weaponDef(req.weaponId);
      if (wd.special === 'lifesteal') frac += wd.specialParams.frac ?? 0.2;
    }
    if (frac > 0) w.heal(src.id, res.dealt * frac, src.id);
  }

  // 9. chained spread (铁索连环): every other chained unit takes the hit once — once per strike
  //    and tick for ability hits: not to units this strike already hit directly or through the chain
  if (chained && !w.chainSpreading && findStatus(target, 'chained', now)) {
    const strike = chainKey !== undefined ? w.chainStrike(chainKey) : undefined;
    strike?.direct.add(target.id);
    w.chainSpreading = true;
    try {
      for (const other of w.unitsWithStatus('chained')) {
        if (other === target || !other.alive) continue;
        if (strike) {
          if (strike.direct.has(other.id) || strike.spread.has(other.id)) continue;
          strike.spread.add(other.id);
        }
        dealDamage(w, { ...req, targetId: other.id, pos: undefined, knockback: undefined, noReflect: true });
      }
    } finally {
      w.chainSpreading = false;
    }
  }

  // 10. hooks
  if (target.kind === 'hero' && total > 0) w.hooks.onDamageTaken(target, src, req, res.dealt);
  if (src && src.kind === 'hero' && src !== target && total > 0) w.hooks.onDamageDealt(src, target, req, res.dealt);

  // knockback (direction: away from the attacker, or from the impact point)
  if (req.knockback && req.knockback > 0 && target.alive && !h?.downed) {
    const from = src && src !== target ? src.pos : pos;
    let kx = target.pos.x - from.x;
    let kz = target.pos.z - from.z;
    const kl = Math.hypot(kx, kz);
    if (kl < 1e-4) {
      kx = Math.sin(target.yaw);
      kz = Math.cos(target.yaw);
    } else {
      kx /= kl;
      kz /= kl;
    }
    w.applyKnockback(target, { x: kx, y: 0, z: kz }, req.knockback);
  }

  // 11. downed / death
  if (h) {
    if (h.downed) {
      if (h.downedUntil <= now) {
        w.killHero(target, creditId, req.sourceId);
        res.killed = true;
      }
    } else if (target.hp <= 0) {
      w.downHero(target, creditId, req.sourceId);
      res.killed = true;
    }
  } else if (target.hp <= 0 && target.alive) {
    w.killUnit(target, creditId, false, req.sourceId);
    res.killed = true;
  }
  return res;
}

/**
 * Total chance to evade a dodgeable bullet: 八卦, every 'dodgeChance' status,
 * modifiers().evadeChance and bulletEvadeChance hooks (倾国) combine as
 * 1 − Π(1 − p), capped at BULLET_EVASION_CAP (data/items.ts).
 */
export function bulletEvadeChance(w: World, target: Entity, src: Entity | undefined, req: DamageRequest): number {
  let keep = 1;
  const armor = req.ignoreArmor ? undefined : armorDef(target.hero?.armor);
  if (armor?.special === 'bagua') keep *= 1 - clamp01(armor.params.chance ?? 0.35);
  if (target.statuses.length > 0) keep *= 1 - statusValue(target, 'dodgeChance', w.time, 0);
  if (target.hero) {
    keep *= 1 - clamp01(w.modifiers(target.id).evadeChance);
    keep *= 1 - clamp01(w.hooks.bulletEvadeChance(target, src, req));
  }
  return Math.min(BULLET_EVASION_CAP, Math.max(0, 1 - keep));
}

/**
 * Hits that 无懈可击 can cancel: ability / item damage, i.e. not weapons, DoT ticks,
 * reflects, redirected hits, noNullify hits (决斗's penalty) or the zone.
 */
function isNullifiableHit(req: DamageRequest, isZone: boolean): boolean {
  if (isZone || req.noNullify || req.redirected || req.sourceId === undefined || req.weaponId !== undefined) return false;
  return !(req.abilityId?.startsWith('status:') ?? false);
}

/**
 * SimExt.redirectDamage (WU-10): inside a modifyIncoming hook for `req`, hand the
 * hit to `newTargetId` — the amount after the attacker's outgoing step, as the
 * request came in (flags set by pre-hooks for the old victim do not ride along),
 * marked `redirected`; weapon on-hit specials apply to the new victim; the
 * original hit then reports blocked 'redirect' (the hook returns 0).
 */
export function redirectDamage(w: World, req: DamageRequest, newTargetId: EntityId): DamageResult {
  let frame: DamageFrame | undefined;
  for (let i = w.dmgDepth - 1; i >= 0; i--) {
    const f = w.dmgStack[i];
    if (f.req === req || f.reqIn === req) {
      frame = f;
      break;
    }
  }
  if (!frame) return dealDamage(w, { ...req, targetId: newTargetId, pos: undefined, head: false });
  if (newTargetId === frame.req.targetId) return { dealt: 0, absorbed: 0, killed: false };
  frame.redirected = true;
  const r = dealDamage(w, { ...frame.reqIn, targetId: newTargetId, amount: frame.outgoing, redirected: true, pos: undefined, head: false });
  const wid = frame.reqIn.weaponId;
  const src = frame.reqIn.sourceId !== undefined ? w.ents.get(frame.reqIn.sourceId) : undefined;
  const t = w.ents.get(newTargetId);
  // like every weapon hit: specials skip a hit fully soaked by a shield
  if (wid && src && t && !r.blocked) applyWeaponSpecialOnHit(w, src, weaponDef(wid), t, r.dealt + r.absorbed);
  return r;
}

function weaponOutgoingMul(w: World, def: WeaponDef, src: Entity, target: Entity): number {
  const p = def.specialParams;
  switch (def.special) {
    case 'genderBonus': {
      const sg = src.hero ? w.heroDef(src)?.gender : undefined;
      const tg = target.hero ? w.heroDef(target)?.gender : undefined;
      return sg && tg && sg !== tg ? (p.mul ?? 1.4) : 1;
    }
    case 'noArmorBonus':
      return target.hero?.armor ? 1 : (p.mul ?? 1.5);
    default:
      return 1;
  }
}

function applyArmor(w: World, target: Entity, armorId: string, req: DamageRequest, bullet: boolean, amount: number, src: Entity | undefined): number {
  const def = armorDef(armorId);
  if (!def) return amount;
  const p = def.params;
  // bulletReduction applies to damage type 'normal' only (data/items.ts)
  const normalBullet = bullet && req.type === 'normal';
  if (normalBullet) amount *= 1 - Math.min(1, Math.max(0, def.bulletReduction));
  switch (def.special) {
    case 'renwang': {
      if (!normalBullet) break;
      const from = src && src !== target ? src.pos : req.pos;
      if (!from) break;
      const dx = from.x - target.pos.x;
      const dz = from.z - target.pos.z;
      const dl = Math.hypot(dx, dz);
      if (dl < 1e-4) break;
      const fx = -Math.sin(target.yaw);
      const fz = -Math.cos(target.yaw);
      const cos = (dx * fx + dz * fz) / dl;
      const half = ((p.frontArc ?? 90) / 2) * (Math.PI / 180);
      if (cos >= Math.cos(half)) amount *= Math.min(1, Math.max(0, p.mul ?? 0.3));
      break;
    }
    case 'tengjia': {
      if (bullet && (p.troopImmune ?? 1) > 0 && src && (src.kind === 'troop' || src.kind === 'npc' || src.kind === 'turret')) return 0;
      if (req.type === 'fire') amount *= p.fireMul ?? 2;
      break;
    }
    case 'baiyin':
      if (req.type !== 'zone') amount = Math.min(amount, p.cap ?? 60);
      break;
    default:
      break;
  }
  void w;
  return amount;
}

// ── Healing / shields ───────────────────────────────────────────────────────
export function healEntity(w: World, targetId: EntityId, amount: number, sourceId?: EntityId): number {
  const e = w.ents.get(targetId);
  if (!e || !e.alive || e.hero?.dead || e.hero?.downed || !(amount > 0)) return 0;
  let amt = amount;
  if (e.hero) {
    amt *= w.modifiers(e.id).healTakenMul;
    amt = w.hooks.modifyHealTaken(e, amt, sourceId);
  }
  const before = e.hp;
  e.hp = Math.min(e.maxHp, e.hp + Math.max(0, amt));
  const healed = e.hp - before;
  if (healed > 0) {
    w.emit({ t: 'heal', target: e.id, amount: Math.round(healed * 10) / 10, src: sourceId });
    const credit = w.creditOf(sourceId);
    const healer = credit !== undefined ? w.ents.get(credit) : undefined;
    if (healer?.hero) {
      healer.hero.stats.healing += healed;
      w.hooks.onHealGiven(healer, e, healed);
    }
  }
  return healed;
}

// ── Explosions ──────────────────────────────────────────────────────────────
const UNIT_KINDS: Entity['kind'][] = ['hero', 'troop', 'npc', 'turret'];

export function explodeAt(
  w: World,
  pos: Vec3,
  radius: number,
  damage: number,
  dtype: DamageType,
  sourceId: EntityId | undefined,
  opts: {
    kind?: string;
    falloff?: boolean;
    knockback?: number;
    selfDamage?: boolean;
    canDodge?: boolean;
    status?: { id: import('../core/types').StatusId; duration: number; params?: Record<string, number> };
    abilityId?: string;
    weaponId?: string;
  } = {},
): void {
  if (!(radius > 0)) return;
  w.emit({ t: 'explosion', pos: { x: pos.x, y: pos.y, z: pos.z }, radius, kind: opts.kind ?? explosionKind(dtype) });
  const owner = w.creditOf(sourceId);
  const origin = { x: pos.x, y: pos.y + 0.3, z: pos.z };
  const targets = w.queryRadius(pos, radius, { kinds: UNIT_KINDS });
  for (const t of targets) {
    if (!t.alive || t.hero?.dead) continue;
    if (owner !== undefined) {
      if (t.id === owner && !opts.selfDamage) continue;
      if (t.id !== owner && w.creditOf(t.id) === owner) continue;
    }
    const hb = hitbox(t);
    const c = { x: t.pos.x, y: t.pos.y + hb.height * 0.5, z: t.pos.z };
    const dist = Math.max(0, Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z) - t.radius);
    if (dist > radius) continue;
    if (!w.lineOfSight(origin, c) && !w.lineOfSight(origin, { x: c.x, y: t.pos.y + hb.height - 0.1, z: c.z })) continue;
    const f = opts.falloff === false ? 1 : 1 - 0.5 * Math.min(1, dist / radius);
    if (damage > 0) {
      const r = dealDamage(w, {
        targetId: t.id,
        sourceId,
        amount: damage * f,
        type: dtype,
        pos: c,
        canDodge: opts.canDodge ?? true,
        weaponId: opts.weaponId,
        abilityId: opts.abilityId,
      });
      // dodged / immune / nullified: the blast's status and shove miss too
      if (r.blocked === 'dodge' || r.blocked === 'invuln' || r.blocked === 'nullify') continue;
    } else if (!opts.weaponId && nullifyEffect(w, t, sourceId)) {
      continue;
    }
    if (!t.alive) continue;
    if (opts.status) w.applyStatus(t.id, opts.status.id, opts.status.duration, { sourceId, params: opts.status.params });
    if (opts.knockback && opts.knockback > 0 && !t.hero?.downed) {
      let kx = t.pos.x - pos.x;
      let kz = t.pos.z - pos.z;
      const kl = Math.hypot(kx, kz);
      if (kl < 1e-3) {
        kx = 0;
        kz = 1;
      } else {
        kx /= kl;
        kz /= kl;
      }
      w.applyKnockback(t, { x: kx, y: 0.3, z: kz }, opts.knockback * f);
    }
  }
}

const explosionKind = (dtype: DamageType): string =>
  dtype === 'fire' ? 'fire' : dtype === 'thunder' ? 'thunder' : dtype === 'explosive' ? 'rocket' : 'frag';

// ── Hero weapon fire ────────────────────────────────────────────────────────
/** Spread cone in degrees for the hero's current state. */
export function currentSpread(w: World, e: Entity, def: WeaponDef): number {
  const h = e.hero!;
  let spread = h.ads ? def.spreadAds : def.spreadHip;
  const moving = Math.hypot(e.vel.x, e.vel.z) > 1;
  if (moving && !h.ads) spread *= 1.35;
  if (!e.onGround) spread *= 1.8;
  if (def.special !== 'rapid') spread *= 1 + Math.min(1, h.burst * 0.12);
  void w;
  return Math.max(0, spread);
}

/** Perturb a unit direction by a random angle within a cone of `deg` degrees. */
export function spreadDir(w: World, d: Vec3, deg: number): Vec3 {
  if (deg <= 0) return { x: d.x, y: d.y, z: d.z };
  const ang = (deg * Math.PI) / 180 * Math.sqrt(w.rng.next());
  const th = w.rng.next() * Math.PI * 2;
  // orthonormal basis
  let ux: number;
  let uy: number;
  let uz: number;
  if (Math.abs(d.y) < 0.99) {
    // u = normalize(cross(d, up))
    ux = -d.z;
    uy = 0;
    uz = d.x;
  } else {
    ux = 1;
    uy = 0;
    uz = 0;
  }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  // v = cross(d, u)
  const vx = d.y * uz - d.z * uy;
  const vy = d.z * ux - d.x * uz;
  const vz = d.x * uy - d.y * ux;
  const k = Math.tan(ang);
  const c = Math.cos(th) * k;
  const s = Math.sin(th) * k;
  const rx = d.x + ux * c + vx * s;
  const ry = d.y + uy * c + vy * s;
  const rz = d.z + uz * c + vz * s;
  const rl = Math.hypot(rx, ry, rz) || 1;
  return { x: rx / rl, y: ry / rl, z: rz / rl };
}

export function falloffMul(def: WeaponDef, dist: number): number {
  if (dist <= def.falloffStart) return 1;
  if (def.maxRange <= def.falloffStart) return 1;
  const t = Math.min(1, (dist - def.falloffStart) / (def.maxRange - def.falloffStart));
  return 1 - 0.5 * t;
}

export function startReload(w: World, e: Entity): boolean {
  const h = e.hero;
  if (!h) return false;
  if (h.reloadUntil > 0) {
    if (w.time < h.reloadUntil) return false; // already reloading
    // due this very tick (R is processed before tickReload): finish it, never restart it
    tickReload(w, e);
  }
  const inst = h.weapons[h.activeSlot];
  if (!inst) return false;
  const def = weaponDef(inst.id);
  if (!usesAmmo(def) || inst.mag >= def.magSize || inst.reserve <= 0) return false;
  const t = def.reloadTime * w.modifiers(e.id).reloadMul;
  h.reloadUntil = w.time + Math.max(0.2, t);
  return true;
}

/** Finish reloads whose timer elapsed. */
export function tickReload(w: World, e: Entity): void {
  const h = e.hero!;
  if (h.reloadUntil <= 0 || w.time < h.reloadUntil) return;
  h.reloadUntil = 0;
  const inst = h.weapons[h.activeSlot];
  if (!inst) return;
  const def = weaponDef(inst.id);
  const need = def.magSize - inst.mag;
  const take = Math.min(need, inst.reserve);
  if (take > 0) {
    inst.mag += take;
    inst.reserve -= take;
  }
}

export function fireRateOf(w: World, e: Entity, def: WeaponDef): number {
  let rate = def.fireRate * statusValue(e, 'fireRateUp', w.time, 1);
  if (e.hero) rate *= w.modifiers(e.id).fireRateMul;
  if (def.special === 'rapid' && e.hero) {
    const rt = w.heroRt(e.id);
    const rampTime = Math.max(0.05, def.specialParams.rampTime ?? 1.5);
    const mul = def.specialParams.rampMul ?? 1.5;
    const firing = rt ? Math.max(0, w.time - rt.rampStart) : 0;
    rate *= 1 + (mul - 1) * Math.min(1, firing / rampTime);
  }
  return Math.max(0.05, rate);
}

/**
 * Process the fire button for a hero this tick. `input` is the effective
 * frame (charm may force BTN_FIRE). Returns true if at least one shot fired.
 */
export function heroFire(w: World, e: Entity, rt: HeroRuntime, input: InputFrame, canShoot: boolean): boolean {
  const h = e.hero!;
  const held = (input.buttons & BTN_FIRE) !== 0;
  const wasHeld = rt.prevFireHeld;
  rt.prevFireHeld = held;
  if (!held) {
    if (w.time - rt.lastFireAt > BURST_RESET) h.burst = 0;
    return false;
  }
  if (!canShoot) return false;
  const inst = h.weapons[h.activeSlot];
  if (!inst) return false;
  const def = weaponDef(inst.id);
  if (!def.auto && wasHeld) return false;
  if (h.channel) w.cancelChannel(e.id);
  if (h.reloadUntil > w.time) return false;
  const ammo = usesAmmo(def);
  if (ammo && inst.mag <= 0) {
    startReload(w, e);
    return false;
  }
  if (w.time + 1e-9 < h.nextFireAt) return false;
  if (h.nextFireAt < w.time - SIM_DT) h.nextFireAt = w.time;
  if (w.time - rt.lastFireAt > (def.specialParams.resetAfter ?? BURST_RESET)) rt.rampStart = w.time;
  h.sprinting = false;
  let shots = 0;
  const aim = w.crosshairPoint(e, Math.max(def.maxRange, 30) + 40);
  while (w.time + 1e-9 >= h.nextFireAt && shots < MAX_SHOTS_PER_TICK) {
    if (ammo && inst.mag <= 0) break;
    fireOne(w, e, rt, def, inst, aim);
    shots++;
    h.nextFireAt += 1 / fireRateOf(w, e, def);
    if (!def.auto) break;
    if (!e.alive || e.hero!.downed) break;
  }
  if (shots > 0 && ammo && inst.mag <= 0) {
    w.hooks.onMagEmpty(e, def.id);
    if (inst.mag <= 0) startReload(w, e);
  }
  return shots > 0;
}

function fireOne(w: World, e: Entity, rt: HeroRuntime, def: WeaponDef, inst: WeaponInstance, aim: Vec3): void {
  const h = e.hero!;
  const now = w.time;
  if (usesAmmo(def) && !findStatus(e, 'noReload', now) && !w.modifiers(e.id).infiniteAmmo) inst.mag = Math.max(0, inst.mag - 1);
  h.burst++;
  rt.lastFireAt = now;
  if (e.statuses.length > 0) removeStatusIf(w, e, 'stealth', breaksOnFire);

  let mul = 1;
  if (rt.followUpMul > 1) {
    if (now <= rt.followUpUntil) mul *= rt.followUpMul;
    rt.followUpMul = 1;
  }
  const eye = w.eyePos(e);
  let dx = aim.x - eye.x;
  let dy = aim.y - eye.y;
  let dz = aim.z - eye.z;
  const dl = Math.hypot(dx, dy, dz);
  if (dl < 1e-4) {
    const r = w.aimRay(e);
    dx = r.dir.x;
    dy = r.dir.y;
    dz = r.dir.z;
  } else {
    dx /= dl;
    dy /= dl;
    dz /= dl;
  }
  const baseDir = { x: dx, y: dy, z: dz };
  const spread = currentSpread(w, e, def);
  const isHuman = !w.isBotHero(e);
  const rewind = isHuman ? w.rewindTickFor(e) : undefined;

  if (def.melee) {
    meleeSwing(w, e, def, baseDir, mul);
    w.hooks.onFire(e, def.id);
    return;
  }

  if (def.projectile) {
    const pr = def.projectile;
    const count = Math.max(1, def.pellets);
    const homing = def.special === 'multiTarget';
    const targets = homing ? pickHomingTargets(w, e, aim, def) : [];
    const fan = count > 1 ? (def.specialParams.fanDeg ?? 8) : 0;
    const forceHit = def.special === 'forceHit' || (def.specialParams.dodgeIgnore ?? 0) > 0;
    for (let i = 0; i < count; i++) {
      let d = spreadDir(w, baseDir, spread);
      if (fan > 0) d = rotateYaw(d, (i / (count - 1) - 0.5) * fan * (Math.PI / 180));
      const proj = w.spawnProjectile({
        kind: pr.kind,
        ownerId: e.id,
        pos: { x: eye.x + d.x * 0.6, y: eye.y + d.y * 0.6, z: eye.z + d.z * 0.6 },
        vel: { x: d.x * pr.speed, y: d.y * pr.speed, z: d.z * pr.speed },
        damage: def.damage * mul,
        dtype: def.special === 'fireConvert' ? 'fire' : def.dtype,
        gravity: pr.gravity,
        explodeRadius: pr.explodeRadius,
        explodeDamage: pr.explodeDamage * mul,
        lifetime: pr.lifetime,
        pierce: 0,
        canDodge: !forceHit,
        weaponId: def.id,
      });
      if (targets.length > 0) {
        w.projHoming.set(proj.id, { targetId: targets[i % targets.length].id, turnRate: def.specialParams.turnRate ?? 4 });
      }
    }
    w.emit({ t: 'shot', src: e.id, weapon: def.id, from: eye, to: aim });
    w.hooks.onFire(e, def.id);
    return;
  }

  // Hitscan: pellets aggregated per target.
  const pellets = Math.max(1, def.pellets);
  const maxPierce = def.special === 'multiTarget' ? Math.max(0, (def.specialParams.targets ?? 3) - 1) : 0;
  const acc = w.scratchHits;
  acc.clear();
  let firstEnd: Vec3 | null = null;
  let firstHit: EntityId | undefined;
  const ignoreOwn = (x: Entity): boolean => x === e || w.creditOf(x.id) === e.id;
  for (let p = 0; p < pellets; p++) {
    const d = spreadDir(w, baseDir, spread);
    let from = eye;
    let remaining = def.maxRange;
    const skipIds: Entity[] = [];
    for (let k = 0; k <= maxPierce; k++) {
      const hit = raycastAll(
        w,
        from,
        d,
        remaining,
        skipIds.length ? (x) => ignoreOwn(x) || skipIds.includes(x) : ignoreOwn,
        true,
        rewind,
      );
      const travelled = def.maxRange - remaining + (hit ? hit.dist : remaining);
      if (!hit) {
        if (!firstEnd) firstEnd = { x: from.x + d.x * remaining, y: from.y + d.y * remaining, z: from.z + d.z * remaining };
        break;
      }
      if (!firstEnd) {
        firstEnd = hit.point;
        firstHit = hit.entityId;
      }
      if (hit.entityId === undefined) break;
      const target = w.ents.get(hit.entityId)!;
      const amount = def.damage * falloffMul(def, travelled) * (hit.head ? def.headshotMul : 1) * mul;
      const prev = acc.get(target.id);
      if (prev) {
        prev.amount += amount;
        prev.head = prev.head || !!hit.head;
      } else {
        acc.set(target.id, { amount, head: !!hit.head, pos: hit.point, dist: travelled });
      }
      skipIds.push(target);
      from = hit.point;
      remaining = def.maxRange - travelled;
      if (remaining <= 0.1) break;
    }
  }
  w.emit({ t: 'shot', src: e.id, weapon: def.id, from: eye, to: firstEnd ?? aim, hit: firstHit });
  for (const [tid, a] of acc) {
    const target = w.ents.get(tid);
    if (!target) continue;
    const res = dealDamage(w, {
      targetId: tid,
      sourceId: e.id,
      amount: a.amount,
      type: def.special === 'fireConvert' ? 'fire' : def.dtype,
      weaponId: def.id,
      pos: a.pos,
      head: a.head,
      canDodge: true,
      ignoreArmor: def.special === 'pierceArmor',
    });
    rt.focusId = tid;
    rt.focusAt = now;
    if (!res.blocked) applyWeaponSpecialOnHit(w, e, def, target, res.dealt + res.absorbed);
  }
  if (acc.size === 0 && firstHit === undefined) {
    const tgt = w.inputOf(e).aimTargetId;
    if (tgt !== undefined) {
      rt.focusId = tgt;
      rt.focusAt = now;
    }
  }
  w.hooks.onFire(e, def.id);
}

/** Distinct lock-on targets near the aim point for multiTarget rockets (方天画戟). */
function pickHomingTargets(w: World, e: Entity, aim: Vec3, def: WeaponDef): Entity[] {
  const radius = def.specialParams.lockRadius ?? 10;
  const max = Math.max(1, def.specialParams.maxTargets ?? 3);
  const cands = w
    .queryRadius(aim, radius, { kinds: UNIT_KINDS, notFriendlyTo: e.id, exclude: [e.id] })
    .filter((c) => !c.hero?.dead && !findStatus(c, 'untargetable', w.time));
  cands.sort((a, b) => Math.hypot(a.pos.x - aim.x, a.pos.z - aim.z) - Math.hypot(b.pos.x - aim.x, b.pos.z - aim.z));
  return cands.slice(0, max);
}

function rotateYaw(d: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: d.x * c + d.z * s, y: d.y, z: -d.x * s + d.z * c };
}

/** Weapon specials that trigger on a successful hit. */
export function applyWeaponSpecialOnHit(w: World, src: Entity, def: WeaponDef, target: Entity, dealt: number): void {
  const p = def.specialParams;
  const now = w.time;
  switch (def.special) {
    case 'freeze': {
      if (!target.alive || target.hero?.dead) break;
      let st = w.freezeStacks.get(target.id);
      if (!st || now > st.until) st = { stacks: 0, until: 0, immuneUntil: st?.immuneUntil ?? 0 };
      st.stacks++;
      st.until = now + (p.stackTime ?? 2);
      w.freezeStacks.set(target.id, st);
      if (st.stacks >= (p.freezeAt ?? 8) && now >= st.immuneUntil) {
        st.stacks = 0;
        st.immuneUntil = now + (p.freezeTime ?? 1.2) + (p.immuneTime ?? 4);
        w.removeStatus(target.id, 'slow');
        w.applyStatus(target.id, 'freeze', p.freezeTime ?? 1.2, { sourceId: src.id });
      } else {
        const amount = Math.min(0.8, st.stacks * (p.slowPerStack ?? 0.06));
        w.removeStatus(target.id, 'slow');
        w.applyStatus(target.id, 'slow', p.stackTime ?? 2, { sourceId: src.id, params: { amount } });
      }
      break;
    }
    case 'fireConvert':
      if (target.alive) w.applyStatus(target.id, 'burn', p.burnTime ?? 3, { sourceId: src.id, params: { dps: p.burnDps ?? 12 } });
      break;
    case 'dismount':
      if (target.hero?.mount && (p.dropMount ?? 1) > 0) {
        // the horse bolts 2.5 m off and the rider can't climb back on for dropLock s (COMBAT-2)
        const mount = target.hero.mount;
        target.hero.mount = null;
        flingGear(w, target, src.pos, [mount], { scatter: p.scatter ?? 2.5, lock: p.dropLock ?? 5 });
      }
      if ((p.slow ?? 0) > 0 && target.alive) w.applyStatus(target.id, 'slow', p.slowTime ?? 1.5, { sourceId: src.id, params: { amount: p.slow } });
      break;
    case 'chainLightning': {
      const jumps = p.chains ?? 2;
      const range = p.radius ?? 7;
      const frac = p.mul ?? 0.5;
      let from = target;
      const hitIds: EntityId[] = [src.id, target.id];
      let amount = dealt;
      for (let j = 0; j < jumps; j++) {
        amount *= frac;
        if (amount < 1) break;
        const cands = w.queryRadius(from.pos, range, { kinds: UNIT_KINDS, exclude: hitIds, notFriendlyTo: src.id });
        let best: Entity | undefined;
        let bd = Infinity;
        for (const c of cands) {
          if (c.hero?.dead || findStatus(c, 'untargetable', now)) continue;
          const d = Math.hypot(c.pos.x - from.pos.x, c.pos.z - from.pos.z);
          if (d < bd) {
            bd = d;
            best = c;
          }
        }
        if (!best) break;
        hitIds.push(best.id);
        w.emit({ t: 'shot', src: src.id, weapon: def.id, from: w.centerOf(from), to: w.centerOf(best), hit: best.id });
        dealDamage(w, { targetId: best.id, sourceId: src.id, amount, type: 'thunder', abilityId: 'weapon:chainLightning', canDodge: false });
        from = best;
      }
      break;
    }
    default:
      break;
  }
}

/** Melee weapon swing: cone in front of the attacker. */
export function meleeSwing(w: World, e: Entity, def: WeaponDef, dir: Vec3, mul: number): Entity[] {
  const range = def.melee?.range ?? 2.2;
  const arc = def.melee?.arcDeg ?? 90;
  const origin = { x: e.pos.x, y: e.pos.y + e.height * 0.55, z: e.pos.z };
  const flat = { x: dir.x, y: 0, z: dir.z };
  const fl = Math.hypot(flat.x, flat.z) || 1;
  flat.x /= fl;
  flat.z /= fl;
  w.emit({ t: 'melee', src: e.id, pos: origin, dir: flat, range, arc });
  const hits = w.queryCone(origin, flat, range, ((arc / 2) * Math.PI) / 180, { kinds: UNIT_KINDS, notFriendlyTo: e.id, exclude: [e.id] });
  for (const t of hits) {
    if (t.hero?.dead) continue;
    const res = dealDamage(w, {
      targetId: t.id,
      sourceId: e.id,
      amount: def.damage * mul,
      type: def.dtype === 'normal' ? 'melee' : def.dtype,
      weaponId: def.id,
      pos: w.centerOf(t),
      canDodge: true,
      knockback: def.specialParams.knockback,
    });
    if (!res.blocked) applyWeaponSpecialOnHit(w, e, def, t, res.dealt + res.absorbed);
  }
  return hits;
}

/** Generic ability hitscan (SimExt.fireHitscan). */
export function fireHitscanShot(w: World, srcId: EntityId, origin: Vec3, dir: Vec3, o: HitscanOptions): RayHit | null {
  const src = w.ents.get(srcId);
  const dl = Math.hypot(dir.x, dir.y, dir.z);
  if (dl < 1e-9) return null;
  const d = { x: dir.x / dl, y: dir.y / dl, z: dir.z / dl };
  const credit = w.creditOf(srcId);
  const skip = (x: Entity): boolean => x.id === srcId || (credit !== undefined && w.creditOf(x.id) === credit);
  let from = origin;
  let remaining = o.range;
  let first: RayHit | null = null;
  const pierced: Entity[] = [];
  const wdef = o.weaponId ? weaponDef(o.weaponId) : undefined;
  for (let k = 0; k <= Math.max(0, o.pierce ?? 0); k++) {
    const hit = raycastAll(w, from, d, remaining, pierced.length ? (x) => skip(x) || pierced.includes(x) : skip, true);
    if (!first) first = hit;
    if (!hit || hit.entityId === undefined) break;
    const target = w.ents.get(hit.entityId)!;
    const travelled = o.range - remaining + hit.dist;
    let amount = o.damage * (hit.head ? (o.headshotMul ?? 1) : 1);
    if (o.falloff && wdef) amount *= falloffMul(wdef, travelled);
    const res = dealDamage(w, {
      targetId: target.id,
      sourceId: srcId,
      amount,
      type: o.dtype,
      weaponId: o.weaponId,
      abilityId: o.abilityId,
      pos: hit.point,
      head: hit.head,
      canDodge: o.canDodge ?? true,
      ignoreArmor: o.ignoreArmor,
      knockback: o.knockback,
    });
    // fired with the held weapon (params.weaponHit): its on-hit special applies like a normal shot
    if (wdef && src && !res.blocked && o.weaponSpecials !== false) applyWeaponSpecialOnHit(w, src, wdef, target, res.dealt + res.absorbed);
    // a shield soaks damage, not the ability's status
    if ((!res.blocked || res.blocked === 'shield') && o.status && target.alive) {
      w.applyStatus(target.id, o.status.id, o.status.duration, { sourceId: srcId, params: o.status.params });
    }
    pierced.push(target);
    from = hit.point;
    remaining = o.range - travelled;
    if (remaining <= 0.1) break;
  }
  if (o.emitShot !== false && src) {
    const to = first ? first.point : { x: origin.x + d.x * o.range, y: origin.y + d.y * o.range, z: origin.z + d.z * o.range };
    w.emit({ t: 'shot', src: srcId, weapon: o.weaponId ?? o.abilityId ?? 'ability', from: origin, to, hit: first?.entityId });
  }
  return first;
}

// ── Projectiles ─────────────────────────────────────────────────────────────
export function makeProjectileState(spec: ProjectileSpec, now: number): Entity['proj'] {
  return {
    kind: spec.kind,
    weaponId: spec.weaponId,
    abilityId: spec.abilityId,
    damage: spec.damage,
    dtype: spec.dtype,
    gravity: spec.gravity ?? 0,
    explodeRadius: spec.explodeRadius ?? 0,
    explodeDamage: spec.explodeDamage ?? 0,
    expiresAt: now + (spec.lifetime ?? 4),
    pierce: spec.pierce ?? 0,
    canDodge: spec.canDodge ?? true,
    onHitStatus: spec.onHitStatus,
  };
}

export function updateProjectiles(w: World, list: readonly Entity[], dt: number): void {
  for (const p of list) {
    if (!p.alive || !p.proj) continue;
    const pr = p.proj;
    if (w.time >= pr.expiresAt) {
      detonate(w, p, p.pos);
      continue;
    }
    const hom = w.projHoming.get(p.id);
    if (hom) steerProjectile(w, p, hom.targetId, hom.turnRate * dt);
    p.vel.y -= pr.gravity * dt;
    const vx = p.vel.x;
    const vy = p.vel.y;
    const vz = p.vel.z;
    const len = Math.hypot(vx, vy, vz) * dt;
    if (len < 1e-6) continue;
    const d = { x: vx / (len / dt), y: vy / (len / dt), z: vz / (len / dt) };
    const owner = p.ownerId;
    const ownerCredit = w.creditOf(owner);
    // the pierced set is read live: a unit pierced earlier in this very step is not hit again
    const skip = (x: Entity): boolean =>
      x.id === owner || (ownerCredit !== undefined && w.creditOf(x.id) === ownerCredit) || (w.projPierced.get(p.id)?.has(x.id) ?? false);
    let from = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
    let remaining = len;
    let done = false;
    for (let guard = 0; guard < 4 && remaining > 1e-4; guard++) {
      let staticT = Infinity;
      if (raycastStatic(w.cw, from.x, from.y, from.z, d.x, d.y, d.z, remaining, staticHit)) staticT = staticHit.t;
      const eh = raycastEntities(w, from.x, from.y, from.z, d.x, d.y, d.z, Math.min(remaining, staticT), skip, undefined, p.radius);
      if (eh) {
        const hp = { x: from.x + d.x * eh.t, y: from.y + d.y * eh.t, z: from.z + d.z * eh.t };
        const t = eh.entity;
        if (pr.damage > 0) {
          const res = dealDamage(w, {
            targetId: t.id,
            sourceId: owner,
            amount: pr.damage * (eh.head ? (pr.weaponId ? weaponDef(pr.weaponId).headshotMul : 1.25) : 1),
            type: pr.dtype,
            weaponId: pr.weaponId,
            abilityId: pr.abilityId,
            pos: hp,
            head: eh.head,
            canDodge: pr.canDodge,
          });
          if (!res.blocked && pr.weaponId && owner !== undefined) {
            const src = w.ents.get(owner);
            if (src) applyWeaponSpecialOnHit(w, src, weaponDef(pr.weaponId), t, res.dealt + res.absorbed);
          }
          if ((!res.blocked || (res.blocked === 'shield' && !pr.weaponId)) && pr.onHitStatus && t.alive) {
            w.applyStatus(t.id, pr.onHitStatus.id, pr.onHitStatus.duration, { sourceId: owner, params: pr.onHitStatus.params });
          }
        }
        if (pr.explodeRadius > 0) {
          detonate(w, p, hp, t.id);
          done = true;
          break;
        }
        if (pr.pierce > 0) {
          pr.pierce--;
          let set = w.projPierced.get(p.id);
          if (!set) {
            set = new Set();
            w.projPierced.set(p.id, set);
          }
          set.add(t.id);
          remaining -= eh.t;
          from = hp;
          continue;
        }
        projectileGone(w, p, hp, t.id);
        w.removeEntity(p.id);
        done = true;
        break;
      }
      if (staticT < Infinity) {
        const hp = { x: from.x + d.x * staticT, y: from.y + d.y * staticT, z: from.z + d.z * staticT };
        detonate(w, p, hp);
        done = true;
        break;
      }
      from = { x: from.x + d.x * remaining, y: from.y + d.y * remaining, z: from.z + d.z * remaining };
      remaining = 0;
    }
    if (done) continue;
    p.pos.x = from.x;
    p.pos.y = from.y;
    p.pos.z = from.z;
    p.yaw = Math.atan2(-d.x, -d.z);
    p.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    // out of the world
    if (Math.abs(p.pos.x) > w.map.size / 2 + 20 || Math.abs(p.pos.z) > w.map.size / 2 + 20 || p.pos.y < -100) {
      projectileGone(w, p, p.pos);
      w.removeEntity(p.id);
    }
  }
}

// ── custom projectile kinds (WU-7) ──────────────────────────────────────────
export interface ProjectileKindImpl {
  kind: string;
  /**
   * Called once when a projectile of this kind ends: it explodes, hits a unit
   * (`hitId`; before it is removed), hits a wall / the ground or expires
   * (`hitId` undefined). `at` is where it went off.
   */
  onDetonate?(sim: SimApi, proj: Entity, at: Vec3, hitId?: EntityId): void;
}

const PROJECTILE_KINDS = new Map<string, ProjectileKindImpl>();

/** Register per-kind projectile logic (黄盖 诈降火船: blast + fire field where the ship went off). */
export function registerProjectileKind(impl: ProjectileKindImpl): void {
  PROJECTILE_KINDS.set(impl.kind, impl);
}

export function getProjectileKind(kind: string): ProjectileKindImpl | undefined {
  return PROJECTILE_KINDS.get(kind);
}

/** Fire the kind's onDetonate once (isolated; the owner is the acting hero meanwhile). */
function projectileGone(w: World, p: Entity, at: Vec3, hitId?: EntityId): void {
  const pr = p.proj;
  if (!pr || w.projDetonated.has(p.id)) return;
  const impl = PROJECTILE_KINDS.get(pr.kind);
  if (!impl?.onDetonate) return;
  w.projDetonated.add(p.id);
  const prev = w.actorId;
  w.actorId = w.creditOf(p.ownerId);
  try {
    impl.onDetonate(w, p, { x: at.x, y: at.y, z: at.z }, hitId);
  } catch (err) {
    warnOnce(`projectile:${pr.kind}`, `projectile kind '${pr.kind}' onDetonate threw: ${String(err)}`);
  } finally {
    w.actorId = prev;
  }
}

/** Turn a projectile's velocity toward a target by at most `maxAngle` radians. */
function steerProjectile(w: World, p: Entity, targetId: EntityId, maxAngle: number): void {
  const tg = w.ents.get(targetId);
  if (!tg || !tg.alive || tg.hero?.dead) return;
  const c = w.centerOf(tg);
  const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
  if (speed < 1e-6) return;
  const dx = p.vel.x / speed;
  const dy = p.vel.y / speed;
  const dz = p.vel.z / speed;
  let tx = c.x - p.pos.x;
  let ty = c.y - p.pos.y;
  let tz = c.z - p.pos.z;
  const tl = Math.hypot(tx, ty, tz);
  if (tl < 1e-6) return;
  tx /= tl;
  ty /= tl;
  tz /= tl;
  const dot = Math.max(-1, Math.min(1, dx * tx + dy * ty + dz * tz));
  const ang = Math.acos(dot);
  let nx = tx;
  let ny = ty;
  let nz = tz;
  if (ang > maxAngle && ang > 1e-6) {
    const s = Math.sin(ang);
    const a = Math.sin(ang - maxAngle) / s;
    const b = Math.sin(maxAngle) / s;
    nx = dx * a + tx * b;
    ny = dy * a + ty * b;
    nz = dz * a + tz * b;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
  }
  p.vel.x = nx * speed;
  p.vel.y = ny * speed;
  p.vel.z = nz * speed;
}

function detonate(w: World, p: Entity, at: Vec3, hitId?: EntityId): void {
  const pr = p.proj!;
  projectileGone(w, p, at, hitId);
  if (pr.explodeRadius > 0) {
    const src = p.ownerId !== undefined ? w.ents.get(p.ownerId) : undefined;
    explodeAt(w, at, pr.explodeRadius, pr.explodeDamage, pr.dtype === 'normal' ? 'explosive' : pr.dtype, p.ownerId, {
      kind: pr.kind,
      canDodge: pr.canDodge,
      weaponId: pr.weaponId,
      abilityId: pr.abilityId,
      knockback: pr.explodeRadius * 0.6,
    });
    if (pr.weaponId && src) {
      const def = weaponDef(pr.weaponId);
      if (def.special === 'fireConvert' || pr.dtype === 'fire') {
        w.spawnHazard({
          kind: 'fire',
          ownerId: p.ownerId,
          pos: at,
          radius: Math.max(1.5, pr.explodeRadius * 0.6),
          duration: def.specialParams.fieldTime ?? 3,
          tickEvery: 0.5,
          params: { damage: def.specialParams.fieldDps ? def.specialParams.fieldDps * 0.5 : 5 },
          dtype: 'fire',
        });
      }
    }
  }
  w.removeEntity(p.id);
}

// ── Troop / turret weapon fire ──────────────────────────────────────────────
/**
 * Simplified unit fire: hit chance from TroopTypeDef.accuracy, range and
 * target motion; LOS required. Projectile weapons launch real projectiles.
 */
export function unitFire(w: World, unit: Entity, target: Entity, def: WeaponDef, accuracy: number, dmgMul = 1): boolean {
  const from = w.eyePos(unit);
  const hb = hitbox(target);
  const to = { x: target.pos.x, y: target.pos.y + hb.height * 0.6, z: target.pos.z };
  const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  if (dist > def.maxRange + 2) return false;
  if (!w.lineOfSight(from, to)) return false;
  if (unit.statuses.length > 0) removeStatusIf(w, unit, 'stealth', breaksOnFire);
  const ai = unit.troop?.ai ?? unit.npc?.ai;
  if (ai) ai.lastShot = w.time; // VF_FIRING in snapshots
  if (def.melee) {
    w.emit({ t: 'melee', src: unit.id, pos: from, dir: normFlat(to.x - from.x, to.z - from.z), range: def.melee.range, arc: def.melee.arcDeg });
    dealDamage(w, { targetId: target.id, sourceId: unit.id, amount: def.damage * dmgMul, type: def.dtype === 'normal' ? 'melee' : def.dtype, weaponId: def.id, pos: to });
    return true;
  }
  if (def.projectile) {
    const pr = def.projectile;
    const lead = dist / Math.max(1, pr.speed);
    const aimP = { x: to.x + target.vel.x * lead, y: to.y + (pr.gravity * lead * lead) / 2, z: to.z + target.vel.z * lead };
    const base = { x: aimP.x - from.x, y: aimP.y - from.y, z: aimP.z - from.z };
    const bl = Math.hypot(base.x, base.y, base.z) || 1;
    const d = spreadDir(w, { x: base.x / bl, y: base.y / bl, z: base.z / bl }, (1 - Math.min(1, accuracy)) * 6);
    w.spawnProjectile({
      kind: pr.kind,
      ownerId: unit.id,
      pos: { x: from.x + d.x * 0.5, y: from.y + d.y * 0.5, z: from.z + d.z * 0.5 },
      vel: { x: d.x * pr.speed, y: d.y * pr.speed, z: d.z * pr.speed },
      damage: def.damage * dmgMul,
      dtype: def.dtype,
      gravity: pr.gravity,
      explodeRadius: pr.explodeRadius,
      explodeDamage: pr.explodeDamage * dmgMul,
      lifetime: pr.lifetime,
      weaponId: def.id,
    });
    w.emit({ t: 'shot', src: unit.id, weapon: def.id, from, to: aimP });
    return true;
  }
  const rangeF = Math.max(0.3, Math.min(1.25, 1.3 - (dist / Math.max(10, def.maxRange)) * 0.9));
  const speed = Math.hypot(target.vel.x, target.vel.z);
  const moveF = speed > 6 ? 0.7 : speed > 2 ? 0.85 : 1;
  const p = Math.max(0.03, Math.min(0.95, accuracy * rangeF * moveF));
  const pellets = Math.max(1, def.pellets);
  let hits = 0;
  for (let i = 0; i < pellets; i++) if (w.rng.chance(pellets > 1 ? p * 0.8 : p)) hits++;
  let end = to;
  if (hits === 0) {
    const off = 0.8 + w.rng.next() * 1.6;
    const a = w.rng.next() * Math.PI * 2;
    end = { x: to.x + Math.cos(a) * off, y: to.y + (w.rng.next() - 0.5) * 1.2, z: to.z + Math.sin(a) * off };
  }
  w.emit({ t: 'shot', src: unit.id, weapon: def.id, from, to: end, hit: hits > 0 ? target.id : undefined });
  if (hits > 0) {
    dealDamage(w, {
      targetId: target.id,
      sourceId: unit.id,
      amount: def.damage * falloffMul(def, dist) * hits * dmgMul,
      type: def.dtype,
      weaponId: def.id,
      pos: to,
    });
  }
  return true;
}

function normFlat(x: number, z: number): Vec3 {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, y: 0, z: z / l };
}
