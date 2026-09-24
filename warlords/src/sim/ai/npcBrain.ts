// Basic NPC AI: 黄巾 camps (aggro + leash home), summoned NPCs (rush a point,
// then attack everything not on the summoner's side), disbanded squads (flee
// from heroes, fight back when attacked, vanish after 20 s).
import type { Entity } from '../../core/types';
import type { SimApi } from '../api';
import { ext } from '../ext';
import { troopDef } from '../defs';
import { dist2d, hasLineOfSight, isTargetable, pickTarget, scanJitter } from './perception';
import { fleeFrom, steerTo } from './steer';
import type { NpcBrain, UnitIntent } from './types';

const SCAN_EVERY = 0.45;
const WANDER_EVERY = 4;

export class BasicNpcBrain implements NpcBrain {
  think(sim: SimApi, self: Entity, _dt: number, out: UnitIntent): UnitIntent {
    const npc = self.npc!;
    const ai = npc.ai;
    const now = sim.time;
    const def = troopDef(npc.npcType);
    const x = ext(sim);

    // ── disbanded squad: flee, fight back only when hurt recently ──
    if ((ai.flee ?? 0) > 0) {
      const attackers = x.recentAttackers(self.id, 4);
      const attacker = attackers.map((id) => sim.get(id)).find((e) => e && isTargetable(sim, self, e));
      if (attacker && dist2d(self.pos, attacker.pos) <= def.attackRange) {
        npc.targetId = attacker.id;
        out.targetId = attacker.id;
        out.faceYaw = Math.atan2(-(attacker.pos.x - self.pos.x), -(attacker.pos.z - self.pos.z));
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

    // ── target acquisition ──
    if (now >= (ai.nextScan ?? 0)) {
      ai.nextScan = now + SCAN_EVERY * scanJitter(self.id, sim.tick);
      const summoned = npc.summonerId !== undefined;
      const range = summoned ? Math.max(def.aggroRange, 35) : def.aggroRange;
      const cur = npc.targetId !== undefined ? sim.get(npc.targetId) : undefined;
      const keep = cur && isTargetable(sim, self, cur) && sim.isHostileTo(self, cur) && dist2d(self.pos, cur.pos) < range * 1.5;
      if (!keep) {
        npc.targetId = pickTarget(sim, self, range, (e) => sim.isHostileTo(self, e), (e) => (e.kind === 'hero' ? 3 : 0))?.id;
      }
    }
    let target = npc.targetId !== undefined ? sim.get(npc.targetId) : undefined;
    if (target && !isTargetable(sim, self, target)) {
      npc.targetId = undefined;
      target = undefined;
    }

    // ── leash (camps) ──
    const homeDist = dist2d(self.pos, npc.home);
    if (npc.summonerId === undefined && npc.leash < 999) {
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
      const seen = def.melee || hasLineOfSight(sim, self, target);
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
    if (npc.summonerId !== undefined) {
      const s = sim.get(npc.summonerId);
      if (s && s.alive && !s.hero?.dead) steerTo(sim, self, s.pos, ai, out, 4);
      return out;
    }
    // idle wander around home
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
}
