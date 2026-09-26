// NPC AI: 黄巾 camps guard their loot (idle patrol around home, aggro on
// heroes / soldiers that come close, chase only briefly beyond the aggro
// range, leash back home and heal), summoned NPCs (rush a point, then attack
// everything not on the summoner's side, else follow the summoner), disbanded
// squads (flee from heroes, fight back when attacked, vanish after 20 s).
// Everyone steps out of harmful hazards.
import type { Entity } from '../../core/types';
import type { SimApi } from '../api';
import { ext } from '../ext';
import { troopDef } from '../defs';
import { dist2d, hasLineOfSight, hazardEscape, isTargetable, pickTarget, scanJitter } from './perception';
import { fleeFrom, steerTo } from './steer';
import type { NpcBrain, UnitIntent } from './types';

const SCAN_EVERY = 0.45;
const WANDER_EVERY = 4;
/** seconds a camp NPC keeps chasing a target that left its aggro range */
const CHASE_TIME = 6;
const HAZARD_CHECK = 0.5;

export class BasicNpcBrain implements NpcBrain {
  think(sim: SimApi, self: Entity, _dt: number, out: UnitIntent): UnitIntent {
    const npc = self.npc!;
    const ai = npc.ai;
    const now = sim.time;
    const def = troopDef(npc.npcType);
    const x = ext(sim);

    // ── step out of fire / clouds ──
    if (now >= (ai.hazAt ?? 0)) {
      ai.hazAt = now + HAZARD_CHECK * scanJitter(self.id, sim.tick);
      const esc = hazardEscape(sim, self);
      ai.hazX = esc ? esc.x : 0;
      ai.hazZ = esc ? esc.z : 0;
      ai.hazUntil = esc ? now + 0.6 : 0;
    }
    const inHazard = (ai.hazUntil ?? 0) > now;

    // ── disbanded squad: flee, fight back only when hurt recently ──
    if ((ai.flee ?? 0) > 0) {
      const attackers = x.recentAttackers(self.id, 4);
      const attacker = attackers.map((id) => sim.get(id)).find((e) => e && isTargetable(sim, self, e));
      if (attacker && dist2d(self.pos, attacker.pos) <= def.attackRange) {
        npc.targetId = attacker.id;
        out.targetId = attacker.id;
        out.faceYaw = Math.atan2(-(attacker.pos.x - self.pos.x), -(attacker.pos.z - self.pos.z));
        if (inHazard) {
          out.moveX = ai.hazX ?? 0;
          out.moveZ = ai.hazZ ?? 0;
        }
        return out;
      }
      npc.targetId = undefined;
      const threat = pickTarget(sim, self, 25, (e) => e.kind === 'hero', undefined, 1);
      if (threat) {
        fleeFrom(self, threat.pos, out);
        out.speedMul = 1.2;
      }
      return out;
    }

    // ── target acquisition ── (ai.aggroHoldUntil: calm / taunt-off effects, SHU-4; being shot breaks it)
    const summoned = npc.summonerId !== undefined;
    const aggro = summoned ? Math.max(def.aggroRange, 35) : def.aggroRange;
    const held = (ai.aggroHoldUntil ?? 0) > now && x.recentAttackers(self.id, 1).length === 0;
    if (held) {
      npc.targetId = undefined;
    } else if (now >= (ai.nextScan ?? 0)) {
      ai.nextScan = now + SCAN_EVERY * scanJitter(self.id, sim.tick);
      const cur = npc.targetId !== undefined ? sim.get(npc.targetId) : undefined;
      const hurtBy = cur ? x.recentAttackers(self.id, 3).some((a) => a === cur.id || x.creditOf(a) === cur.id) : false;
      let keep = !!cur && isTargetable(sim, self, cur) && sim.isHostileTo(self, cur);
      if (keep && cur) {
        const d = dist2d(self.pos, cur.pos);
        if (d > aggro * 1.3) {
          // chase briefly beyond the aggro range (longer when it keeps hurting us)
          if (ai.chaseSince === undefined || !Number.isFinite(ai.chaseSince)) ai.chaseSince = now;
          if (now - ai.chaseSince > (hurtBy ? CHASE_TIME * 1.5 : CHASE_TIME)) keep = false;
        } else {
          ai.chaseSince = NaN;
        }
      }
      if (!keep) {
        ai.chaseSince = NaN;
        // anyone who just hurt us comes first, then the nearest hostile (heroes slightly preferred)
        const attackers = new Set(x.recentAttackers(self.id, 4).map((a) => x.creditOf(a) ?? a));
        npc.targetId = pickTarget(
          sim,
          self,
          aggro,
          (e) => sim.isHostileTo(self, e),
          (e) => (e.kind === 'hero' ? 3 : 0) + (attackers.has(e.id) || attackers.has(x.creditOf(e.id) ?? -1) ? 12 : 0),
        )?.id;
      }
    }
    let target = npc.targetId !== undefined ? sim.get(npc.targetId) : undefined;
    if (target && !isTargetable(sim, self, target)) {
      npc.targetId = undefined;
      target = undefined;
    }

    if (inHazard) {
      out.moveX = ai.hazX ?? 0;
      out.moveZ = ai.hazZ ?? 0;
      out.speedMul = 1.2;
      if (target) {
        out.targetId = target.id;
        out.faceYaw = Math.atan2(-(target.pos.x - self.pos.x), -(target.pos.z - self.pos.z));
      }
      return out;
    }

    // ── leash (camps) ──
    const homeDist = dist2d(self.pos, npc.home);
    if (!summoned && npc.leash < 999) {
      if ((ai.returning ?? 0) > 0 || homeDist > npc.leash) {
        ai.returning = 1;
        npc.targetId = undefined;
        const d = steerTo(sim, self, npc.home, ai, out, 1.5);
        out.speedMul = 1.25;
        if (d <= 2) {
          ai.returning = 0;
          if (self.hp < self.maxHp) sim.heal(self.id, self.maxHp, self.id);
        }
        return out;
      }
    }

    if (target) {
      const d = dist2d(self.pos, target.pos);
      const reach = def.melee ? Math.max(1.0, def.attackRange * 0.8) : def.attackRange * 0.75;
      const seen = def.melee || this.los(sim, self, target);
      if (d > reach || !seen) steerTo(sim, self, target.pos, ai, out, def.melee ? 0.9 : 1.2);
      out.targetId = target.id;
      out.faceYaw = Math.atan2(-(target.pos.x - self.pos.x), -(target.pos.z - self.pos.z));
      if (def.melee) out.speedMul = 1.1;
      return out;
    }

    // summoned rush point (南蛮入侵 → crosshair point)
    if (ai.goalX !== undefined && ai.goalZ !== undefined && (ai.goalDone ?? 0) === 0) {
      const d = steerTo(sim, self, { x: ai.goalX, y: self.pos.y, z: ai.goalZ }, ai, out, 2);
      if (d <= 2.5) ai.goalDone = 1;
      out.speedMul = 1.15;
      return out;
    }
    // summoned without a target: follow the summoner
    if (summoned) {
      const s = sim.get(npc.summonerId);
      if (s && s.alive && !s.hero?.dead) steerTo(sim, self, s.pos, ai, out, 4);
      return out;
    }
    // idle patrol around home (guarding the camp's loot)
    if (now >= (ai.wanderAt ?? 0)) {
      ai.wanderAt = now + WANDER_EVERY + (self.id % 3);
      const a = sim.rng.next() * Math.PI * 2;
      const r = sim.rng.next() * Math.min(6, npc.leash * 0.3);
      ai.wx = npc.home.x + Math.cos(a) * r;
      ai.wz = npc.home.z + Math.sin(a) * r;
    }
    if (ai.wx !== undefined && ai.wz !== undefined) {
      steerTo(sim, self, { x: ai.wx, y: self.pos.y, z: ai.wz }, ai, out, 1);
      out.speedMul = 0.45;
    }
    return out;
  }

  /** LOS cached for 0.3 s per NPC. */
  private los(sim: SimApi, self: Entity, target: Entity): boolean {
    const ai = self.npc!.ai;
    const now = sim.time;
    if (ai.losId === target.id && now < (ai.losUntil ?? 0)) return (ai.losOk ?? 0) > 0;
    const ok = hasLineOfSight(sim, self, target);
    ai.losId = target.id;
    ai.losUntil = now + 0.3 * scanJitter(self.id, sim.tick);
    ai.losOk = ok ? 1 : 0;
    return ok;
  }
}
