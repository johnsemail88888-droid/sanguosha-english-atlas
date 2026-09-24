// Squad AI (带兵): wedge-formation follow, hold / attack / charge orders,
// commander marks, identity-aware engagement via sim.isHostileTo, plus:
//  - sensible targets: whoever hurts the commander or this soldier first, then
//    the commander's focus / mark, then the nearest real threat (low HP and
//    heroes preferred), with stickiness so soldiers don't flicker between targets;
//  - a bot commander's own beliefs veto shooting at its believed allies
//    (a stray friendly bullet must not start a feud between allied squads);
//  - leashed engagement around the order point, nav paths for long trips
//    (steer.ts), catch-up speed when far behind the formation;
//  - cover while reloading (budgeted per tick), stepping out of harmful hazards.
import type { Vec3 } from '../../core/math';
import type { Entity, EntityId } from '../../core/types';
import type { SimApi } from '../api';
import { troopDef } from '../defs';
import { ext } from '../ext';
import { findCover } from './cover';
import { dist2d, hasLineOfSight, hazardEscape, isTargetable, pickTarget, scanJitter } from './perception';
import { mindOf } from './registry';
import { fleeFrom, steerTo } from './steer';
import type { TroopBrain, UnitIntent } from './types';

const SCAN_EVERY = 0.35;
const CHARGE_RANGE = 40;
const FORMATION_SPACING = 1.8;
const FORMATION_BACK = 2.4;
/** cover searches allowed per world tick across all soldiers */
const COVER_BUDGET_PER_TICK = 2;
const HAZARD_CHECK = 0.5;

/** Wedge slot position behind the commander (slot 0 = first row left). */
export function wedgeSlot(cmd: Entity, slot: number): Vec3 {
  const row = Math.floor(slot / 2) + 1;
  const side = slot % 2 === 0 ? -1 : 1;
  const back = FORMATION_BACK + (row - 1) * FORMATION_SPACING;
  const lat = side * FORMATION_SPACING * row * 0.8;
  const fx = -Math.sin(cmd.yaw);
  const fz = -Math.cos(cmd.yaw);
  const rx = Math.cos(cmd.yaw);
  const rz = -Math.sin(cmd.yaw);
  return { x: cmd.pos.x - fx * back + rx * lat, y: cmd.pos.y, z: cmd.pos.z - fz * back + rz * lat };
}

/** Ring slot around a hold point. */
export function ringSlot(center: Vec3, slot: number, count: number): Vec3 {
  const n = Math.max(1, count);
  const a = (slot / n) * Math.PI * 2;
  const r = n <= 1 ? 0 : 2.2;
  return { x: center.x + Math.cos(a) * r, y: center.y, z: center.z + Math.sin(a) * r };
}

const coverTick = new WeakMap<SimApi, { tick: number; used: number }>();

function coverAllowed(sim: SimApi): boolean {
  let c = coverTick.get(sim);
  if (!c) {
    c = { tick: -1, used: 0 };
    coverTick.set(sim, c);
  }
  if (c.tick !== sim.tick) {
    c.tick = sim.tick;
    c.used = 0;
  }
  if (c.used >= COVER_BUDGET_PER_TICK) return false;
  c.used++;
  return true;
}

export class BasicTroopBrain implements TroopBrain {
  think(sim: SimApi, self: Entity, _dt: number, out: UnitIntent): UnitIntent {
    const tr = self.troop!;
    const ai = tr.ai;
    const now = sim.time;
    const def = troopDef(tr.troopType);
    const cmd = sim.get(tr.commanderId);
    const cmdAlive = !!cmd && cmd.alive && !cmd.hero?.dead;

    // fleeing (张辽 威震逍遥津 etc.)
    if ((ai.fleeUntil ?? 0) > now) {
      const threat = sim.get(ai.fleeFrom) ?? cmd;
      if (threat) fleeFrom(self, threat.pos, out);
      out.speedMul = 1.3;
      tr.targetId = undefined;
      return out;
    }
    if (!cmdAlive) {
      out.targetId = this.validTarget(sim, self, tr.targetId, def.attackRange * 1.2) ? tr.targetId : undefined;
      return out;
    }
    const order = cmd!.hero!.order;

    // ── target selection ──
    if (now >= (ai.nextScan ?? 0)) {
      ai.nextScan = now + SCAN_EVERY * scanJitter(self.id, sim.tick);
      tr.targetId = this.chooseTarget(sim, self, cmd!, def.aggroRange, def.attackRange)?.id;
    } else if (tr.targetId !== undefined && !this.validTarget(sim, self, tr.targetId, Math.max(def.aggroRange, CHARGE_RANGE) + 10)) {
      tr.targetId = undefined;
    }
    const target = tr.targetId !== undefined ? sim.get(tr.targetId) : undefined;

    // ── movement goal from the order ──
    const squadSize = cmd!.hero!.squad.length;
    let goal: Vec3;
    let leash = 10;
    switch (order.kind) {
      case 'hold':
        goal = ringSlot(order.point ?? cmd!.pos, tr.slot, squadSize);
        leash = 6;
        break;
      case 'attack':
        if (order.targetId !== undefined && target && target.id === order.targetId) {
          goal = target.pos;
          leash = 1e9;
        } else if (order.point) {
          goal = ringSlot(order.point, tr.slot, squadSize);
          leash = 14;
        } else {
          goal = wedgeSlot(cmd!, tr.slot);
        }
        break;
      case 'charge':
        goal = target ? target.pos : wedgeSlot(cmd!, tr.slot);
        leash = target ? 1e9 : 10;
        break;
      default:
        goal = wedgeSlot(cmd!, tr.slot);
        break;
    }

    // step out of fire / storm clouds first
    if (now >= (ai.hazAt ?? 0)) {
      ai.hazAt = now + HAZARD_CHECK * scanJitter(self.id, sim.tick);
      const esc = hazardEscape(sim, self);
      ai.hazX = esc ? esc.x : 0;
      ai.hazZ = esc ? esc.z : 0;
      ai.hazUntil = esc ? now + 0.6 : 0;
    }
    if ((ai.hazUntil ?? 0) > now) {
      out.moveX = ai.hazX ?? 0;
      out.moveZ = ai.hazZ ?? 0;
      out.speedMul = 1.25;
      if (target) {
        out.targetId = target.id;
        out.faceYaw = Math.atan2(-(target.pos.x - self.pos.x), -(target.pos.z - self.pos.z));
      }
      return out;
    }

    const slotGoal = goal;
    let arrive = 0.8;
    if (target) {
      const d = dist2d(self.pos, target.pos);
      const reach = def.melee ? Math.max(1.2, def.attackRange * 0.8) : def.attackRange * 0.75;
      const seen = d <= def.attackRange && (def.melee || this.los(sim, self, target));
      const fromGoal = dist2d(target.pos, slotGoal);
      if (!seen || d > reach) {
        // close in, but don't abandon the order point beyond the leash
        if (fromGoal < leash + def.attackRange || leash > 1e8) goal = target.pos;
      } else {
        goal = self.pos; // in range with LOS: stand and shoot
        // reloading in the open: duck behind the nearest cover (a few searches per tick world-wide)
        if (!def.melee && tr.reloadUntil > now && d > 6) {
          const cover = this.coverSpot(sim, self, target);
          if (cover && dist2d(cover, slotGoal) < leash + 4) {
            goal = cover;
            arrive = 0.5;
          }
        }
      }
      out.targetId = target.id;
    }
    const dist = steerTo(sim, self, goal, ai, out, target && goal !== target.pos ? arrive : def.melee ? 1.0 : 1.2);
    // catch up when far behind the formation
    if (!target && dist > 8) out.speedMul = 1.35;
    else if (dist > 25) out.speedMul = 1.35;
    if (target) {
      out.faceYaw = Math.atan2(-(target.pos.x - self.pos.x), -(target.pos.z - self.pos.z));
    } else if (order.kind !== 'hold' && dist < 1.5) {
      out.faceYaw = cmd!.yaw;
    }
    return out;
  }

  /** LOS cached for 0.3 s per soldier (ai memory). */
  private los(sim: SimApi, self: Entity, target: Entity): boolean {
    const ai = self.troop!.ai;
    const now = sim.time;
    if (ai.losId === target.id && now < (ai.losUntil ?? 0)) return (ai.losOk ?? 0) > 0;
    const ok = hasLineOfSight(sim, self, target);
    ai.losId = target.id;
    ai.losUntil = now + 0.3 * scanJitter(self.id, sim.tick);
    ai.losOk = ok ? 1 : 0;
    return ok;
  }

  private coverSpot(sim: SimApi, self: Entity, target: Entity): Vec3 | null {
    const ai = self.troop!.ai;
    const now = sim.time;
    if (now < (ai.coverAt ?? 0)) {
      return ai.coverX !== undefined && Number.isFinite(ai.coverX) ? { x: ai.coverX, y: self.pos.y, z: ai.coverZ } : null;
    }
    if (!coverAllowed(sim)) return null;
    ai.coverAt = now + 3;
    const c = findCover(sim, self, { threats: [sim.eyePos(target)], maxDist: 7, budget: 4, maxAdvance: 1 });
    ai.coverX = c ? c.x : NaN;
    ai.coverZ = c ? c.z : NaN;
    return c;
  }

  private validTarget(sim: SimApi, self: Entity, id: number | undefined, range: number): boolean {
    if (id === undefined) return false;
    const t = sim.get(id);
    if (!t || !isTargetable(sim, self, t)) return false;
    return dist2d(self.pos, t.pos) <= range;
  }

  private chooseTarget(sim: SimApi, self: Entity, cmd: Entity, aggro: number, attackRange: number): Entity | undefined {
    const order = cmd.hero!.order;
    const x = ext(sim);
    // explicit attack order on a target
    if (order.kind === 'attack' && order.targetId !== undefined) {
      const t = sim.get(order.targetId);
      if (t && isTargetable(sim, self, t) && dist2d(self.pos, t.pos) < 120) return t;
    }
    const mind = mindOf(sim, cmd);
    const cur = self.troop!.targetId;
    const attackers = new Set<EntityId>();
    for (const a of x.recentAttackers(cmd.id, 5)) attackers.add(a);
    for (const a of x.recentAttackers(self.id, 5)) attackers.add(a);
    const range = order.kind === 'charge' ? Math.max(CHARGE_RANGE, aggro) : Math.max(aggro, attackRange);
    return pickTarget(
      sim,
      self,
      range,
      (e) => {
        if (!sim.isHostileTo(self, e)) return false;
        if (!mind) return true;
        // a bot commander's believed allies are off limits unless marked / ordered
        const owner = x.commanderOf(e);
        if (!owner || owner === cmd) return true;
        if (e.statuses.some((s) => s.id === 'marked' && s.sourceId === cmd.id && s.until > sim.time)) return true;
        // soldiers fight whom their commander fights (a stray friendly bullet is not a war)
        return mind.allyScore(owner) < 0.5 && mind.hostility(owner) >= 0.5;
      },
      (e) => {
        let b = 0;
        // the commander's own mark (several commanders may mark the same unit)
        if (e.statuses.some((s) => s.id === 'marked' && s.sourceId === cmd.id && s.until > sim.time)) b += 60;
        const credit = x.creditOf(e.id);
        if (attackers.has(e.id) || (credit !== undefined && attackers.has(credit))) b += 20;
        const focus = sim.get(cmd.lastDamagedBy);
        if (focus && focus === e && (cmd.lastDamagedAt ?? -99) > sim.time - 5) b += 10;
        if (e.kind === 'hero') b += 4;
        if (e.id === cur) b += 6;
        b += (1 - e.hp / Math.max(1, e.maxHp)) * 6;
        return b;
      },
    );
  }
}
