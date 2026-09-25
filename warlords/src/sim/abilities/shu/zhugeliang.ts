// 诸葛亮 Zhuge Liang — 观星 (passive), 八阵图 (Q), 空城 (E).
import type { Entity } from '../../../core/types';
import type { SimApi } from '../../api';
import { registerHazardKind } from '../../hazards';
import { registerAbility } from '../registry';
import { crosshairPoint, getState, param, setState } from '../common';
import { emitAbility, knownAlly, setCast } from './util';

const MAZE_KIND = 'bazhen';
const MAZE_TICK = 0.25;
/** statuses applied by the maze outlive one tick a little, so they never flicker */
const MAZE_LINGER = 0.35;

// 观星 (passive): every `interval` s, other heroes within `radius` are revealed
// to you alone (private reveal: only your client gets the outline / marker).
registerAbility({
  id: 'zhugeliang_guanxing',
  tick(ctx) {
    const { sim, self } = ctx;
    const h = self.hero;
    if (!h || h.dead || h.downed) return; // the pulse waits until you are back up
    const now = sim.time;
    const next = getState(ctx, 'next', 0);
    if (next > 0 && now < next) return;
    setState(ctx, 'next', now + Math.max(1, param(ctx, 'interval', 20)));
    const duration = param(ctx, 'duration', 3);
    const priv = param(ctx, 'privateReveal', 1) > 0;
    let seen = 0;
    for (const e of sim.queryRadius(self.pos, param(ctx, 'radius', 45), { kinds: ['hero'], exclude: [self.id] })) {
      if (!e.hero || e.hero.dead) continue;
      const params = priv ? { viewerId: self.id } : undefined;
      if (sim.applyStatus(e.id, 'reveal', duration, { sourceId: self.id, params })) seen++;
    }
    // a cue for your own client only (the pulse itself is hidden information)
    if (seen > 0) emitAbility(sim, self, ctx.def.id, { pos: { ...self.pos }, privateTo: priv ? self.id : undefined });
  },
});

// 八阵图 (Q): a stone maze at the crosshair. Enemies inside are slowed and
// silenced; you and your own units inside gain bullet evasion. "Enemies" =
// everything not on your own side except your KNOWN allies (util.ts knownAlly:
// a loyalist's maze never slows / silences the Lord or the Lord's soldiers).
registerHazardKind({
  kind: MAZE_KIND,
  tick(sim, hz, affected) {
    const st = hz.hazard;
    if (!st) return true;
    const p = st.params;
    const owner = sim.get(hz.ownerId);
    const linger = st.tickEvery + MAZE_LINGER;
    for (const u of affected) {
      if (!u.alive || u.hero?.dead) continue;
      if (owner && sim.isOwnSide(owner, u)) {
        if ((p.dodge ?? 0) > 0) sim.applyStatus(u.id, 'dodgeChance', linger, { sourceId: hz.ownerId, params: { chance: p.dodge } });
        continue;
      }
      if (u.kind === 'turret') continue;
      if (owner && knownAlly(sim, owner, u)) continue;
      if ((p.slow ?? 0) > 0) sim.applyStatus(u.id, 'slow', linger, { sourceId: hz.ownerId, params: { amount: p.slow } });
      if (u.kind === 'hero' && (p.silence ?? 0) > 0) sim.applyStatus(u.id, 'silence', linger, { sourceId: hz.ownerId });
    }
    return true;
  },
});

registerAbility({
  id: 'zhugeliang_bazhen',
  activate(ctx) {
    const { sim, self } = ctx;
    const pos = crosshairPoint(ctx, param(ctx, 'range', 30));
    sim.spawnHazard({
      kind: MAZE_KIND,
      ownerId: self.id,
      pos,
      radius: param(ctx, 'radius', 7),
      duration: param(ctx, 'duration', 8),
      tickEvery: MAZE_TICK,
      params: { slow: param(ctx, 'slow', 0.4), dodge: param(ctx, 'dodge', 0.3), silence: 1 },
    });
    setCast(ctx, { pos });
    return true;
  },
});

// 空城 (E): play the guqin — invulnerable and untargetable, but disarmed and
// slowed; soldiers / NPCs nearby that are fighting you (hostile to you, or
// targeting you / your own units) drop their targets and hesitate. Troops of a
// commander you have no quarrel with keep their fight.
registerAbility({
  id: 'zhugeliang_kongcheng',
  activate(ctx) {
    const { sim, self } = ctx;
    const duration = param(ctx, 'duration', 3);
    const src = { sourceId: self.id };
    sim.applyStatus(self.id, 'invuln', duration, src);
    sim.applyStatus(self.id, 'untargetable', duration, src);
    sim.applyStatus(self.id, 'disarm', duration, src);
    const slow = param(ctx, 'selfSlow', 0.3);
    if (slow > 0) sim.applyStatus(self.id, 'slow', duration, { ...src, params: { amount: slow } });
    for (const u of sim.queryRadius(self.pos, param(ctx, 'radius', 15), { kinds: ['troop', 'npc'], notFriendlyTo: self.id })) {
      if (u.alive && fightingSide(sim, self, u)) loseAggro(sim, u, duration);
    }
    setCast(ctx, { pos: { ...self.pos } });
    return true;
  },
});

/** Is soldier / NPC `u` fighting `self`'s side: targeting him or his units, or hostile to him? */
function fightingSide(sim: SimApi, self: Entity, u: Entity): boolean {
  const tid = u.troop?.targetId ?? u.npc?.targetId;
  const t = tid !== undefined ? sim.get(tid) : undefined;
  if (t && sim.isOwnSide(self, t)) return true;
  return sim.isHostileTo(u, self);
}

/**
 * Drop the current target and hold off re-scanning for `hold` seconds.
 * Workaround: writes the troop / NPC brain's scan timer directly (both brains
 * gate target acquisition on `ai.nextScan`). docs/SIM_REQUESTS.md SHU-4 asks
 * for a proper SimExt.dropAggro(unitId, seconds) so a brain rewrite cannot
 * silently break 空城.
 */
function loseAggro(sim: SimApi, u: Entity, hold: number): void {
  const until = sim.time + hold;
  if (u.troop) {
    u.troop.targetId = undefined;
    u.troop.ai.nextScan = Math.max(u.troop.ai.nextScan ?? 0, until);
  }
  if (u.npc) {
    u.npc.targetId = undefined;
    u.npc.ai.nextScan = Math.max(u.npc.ai.nextScan ?? 0, until);
  }
}
