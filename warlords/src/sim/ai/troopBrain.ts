// Basic squad AI (带兵): wedge-formation follow, hold / attack / charge
// orders, commander marks, identity-aware engagement via sim.isHostileTo.
import type { Vec3 } from '../../core/math';
import type { Entity } from '../../core/types';
import type { SimApi } from '../api';
import { troopDef } from '../defs';
import { dist2d, hasLineOfSight, isTargetable, pickTarget } from './perception';
import { fleeFrom, steerTo } from './steer';
import type { TroopBrain, UnitIntent } from './types';

const SCAN_EVERY = 0.35;
const CHARGE_RANGE = 40;
const FORMATION_SPACING = 1.8;
const FORMATION_BACK = 2.4;

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
      ai.nextScan = now + SCAN_EVERY + (self.id % 5) * 0.02;
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

    const slotGoal = goal;
    if (target) {
      const d = dist2d(self.pos, target.pos);
      const reach = def.melee ? Math.max(1.2, def.attackRange * 0.8) : def.attackRange * 0.75;
      const seen = d <= def.attackRange && (def.melee || hasLineOfSight(sim, self, target));
      const fromGoal = dist2d(target.pos, slotGoal);
      if (!seen || d > reach) {
        // close in, but don't abandon the order point beyond the leash
        if (fromGoal < leash + def.attackRange || leash > 1e8) goal = target.pos;
      } else {
        goal = self.pos; // in range with LOS: stand and shoot
      }
      out.targetId = target.id;
    }
    const dist = steerTo(sim, self, goal, ai, out, target && goal !== target.pos ? 0.8 : def.melee ? 1.0 : 1.2);
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

  private validTarget(sim: SimApi, self: Entity, id: number | undefined, range: number): boolean {
    if (id === undefined) return false;
    const t = sim.get(id);
    if (!t || !isTargetable(sim, self, t)) return false;
    return dist2d(self.pos, t.pos) <= range;
  }

  private chooseTarget(sim: SimApi, self: Entity, cmd: Entity, aggro: number, attackRange: number): Entity | undefined {
    const order = cmd.hero!.order;
    // explicit attack order on a target
    if (order.kind === 'attack' && order.targetId !== undefined) {
      const t = sim.get(order.targetId);
      if (t && isTargetable(sim, self, t) && dist2d(self.pos, t.pos) < 120) return t;
    }
    const range = order.kind === 'charge' ? Math.max(CHARGE_RANGE, aggro) : Math.max(aggro, attackRange);
    return pickTarget(
      sim,
      self,
      range,
      (e) => sim.isHostileTo(self, e),
      (e) => {
        let b = 0;
        const markedBy = e.statuses.find((s) => s.id === 'marked' && s.until > sim.time)?.sourceId;
        if (markedBy === cmd.id) b += 60;
        if (e.id === cmd.lastDamagedBy && (cmd.lastDamagedAt ?? -99) > sim.time - 5) b += 20;
        if (e.kind === 'hero') b += 4;
        return b;
      },
    );
  }
}
