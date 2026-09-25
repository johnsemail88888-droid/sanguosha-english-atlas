// 周瑜 Zhou Yu — 英姿 (reload + cooldowns), 反间 (charm onto the nearest other
// hero it can see, else disarm), 火烧赤壁 (delayed 25 m napalm line + burning ground).
import type { Vec3 } from '../../../core/math';
import type { Entity } from '../../../core/types';
import type { AbilityCtx, SimApi } from '../../api';
import { ext } from '../../ext';
import { UNIT_KINDS, flatAimDir, getState, param, setState } from '../common';
import { registerAbility } from '../registry';
import { applyDebuff, centerOf, crosshairFoe, isUp, publiclyVisible, registerFieldKind, setCast } from './util';

// 英姿 (passive): reload ×reloadMul, ability cooldowns ×cdMul.
registerAbility({
  id: 'zhouyu_yingzi',
  modifiers: (ctx) => ({ reloadMul: param(ctx, 'reloadMul', 0.75), cooldownMul: param(ctx, 'cdMul', 0.85) }),
});

/**
 * The hero a charmed `victim` turns on: the nearest standing hero within `r` m of it that
 * is neither the victim nor the caster and that the victim can see — a hero hidden in
 * stealth is never picked (the victim's forced aim and tracers would give it away) —
 * preferring one in clear line of sight.
 */
function discordTarget(sim: SimApi, victim: Entity, caster: Entity, r: number): Entity | undefined {
  const x = ext(sim);
  const eye = sim.eyePos(victim);
  let best: Entity | undefined;
  let bestD = Infinity;
  let bestSeen = false;
  for (const h of sim.heroes()) {
    if (h === victim || h === caster || !h.alive || h.hero?.dead || h.hero?.downed) continue;
    if (sim.hasStatus(h.id, 'untargetable') || !x.canSee(victim, h)) continue;
    const d = Math.hypot(h.pos.x - victim.pos.x, h.pos.y - victim.pos.y, h.pos.z - victim.pos.z);
    if (d > r) continue;
    const seen = sim.lineOfSight(eye, centerOf(h)) || sim.lineOfSight(eye, sim.eyePos(h));
    if ((seen && !bestSeen) || (seen === bestSeen && d < bestD)) {
      best = h;
      bestD = d;
      bestSeen = seen;
    }
  }
  return best;
}

/** Is the charm target still one the victim should be attacking (standing, visible to it)? */
function validDiscord(sim: SimApi, victim: Entity, t: Entity | undefined): boolean {
  return !!t && t.alive && !t.hero?.dead && !t.hero?.downed && !sim.hasStatus(t.id, 'untargetable') && ext(sim).canSee(victim, t);
}

// 反间 (Q): charm the crosshair enemy hero for `duration` s onto the nearest other hero it can
// see (never you); nobody around → disarm it instead. 谦逊-immune targets can't be chosen (no
// cooldown). While the charm lasts, a target that drops, dies or slips into stealth is swapped
// for the next one (none left → the charm ends).
registerAbility({
  id: 'zhouyu_fanjian',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!isUp(self)) return false;
    const t = crosshairFoe(ctx, param(ctx, 'range', 30), ['hero']);
    if (!t) return false;
    const other = discordTarget(sim, t, self, param(ctx, 'searchRadius', 30));
    // pos = whom it turns on (the renderer draws the discord line target → pos); never a stealthed hero
    setCast(ctx, { target: t.id, pos: centerOf(other && publiclyVisible(sim, other) ? other : t) });
    const outcome = other
      ? applyDebuff(ctx, t, 'charm', param(ctx, 'duration', 2), { targetId: other.id })
      : applyDebuff(ctx, t, 'disarm', param(ctx, 'disarm', 2));
    if (outcome === 'landed' && other) setState(ctx, 'victim', t.id);
    return outcome !== 'resisted';
  },
  tick(ctx) {
    const { sim, self } = ctx;
    const vid = getState(ctx, 'victim', -1);
    if (vid < 0) return;
    const v = sim.get(vid);
    const now = sim.time;
    // our charm only (a later charmer owns the instance once it re-charms the victim)
    const ch = v?.alive ? v.statuses.find((s) => s.id === 'charm' && s.until > now && s.sourceId === self.id) : undefined;
    if (!v || !ch) {
      setState(ctx, 'victim', -1);
      return;
    }
    if (validDiscord(sim, v, sim.get(ch.params?.targetId))) return;
    const next = discordTarget(sim, v, self, param(ctx, 'searchRadius', 30));
    if (next) ch.params = { ...(ch.params ?? {}), targetId: next.id };
    else {
      ch.until = now; // expires with its 'off' event in this tick's status pass
      setState(ctx, 'victim', -1);
    }
  },
});

// 火烧赤壁 (E): the line is fixed at cast time (your position + aim yaw). After `delay` s,
// `blasts` napalm bombs land i × length / (blasts − 1) m ahead: every unit within `radius` of
// any bomb takes `damage` once per cast, and each bomb leaves burning ground.
export const NAPALM_FIELD = 'chibi_napalm';
registerFieldKind(NAPALM_FIELD, 'fire');

function napalmStrike(ctx: AbilityCtx, centers: Vec3[]): void {
  const { sim, self, def } = ctx;
  const dtype = def.dtype ?? 'fire';
  const radius = param(ctx, 'radius', 3.5);
  const damage = param(ctx, 'damage', 100);
  const hit = new Set<number>();
  const victims: { e: Entity; at: Vec3 }[] = [];
  for (const c of centers) {
    c.y = sim.groundHeight(c.x, c.z);
    sim.emit({ t: 'explosion', pos: { ...c }, radius, kind: 'fire' });
    // like any blast: walls and roofs between the bomb and a unit shield it
    const origin = { x: c.x, y: c.y + 0.3, z: c.z };
    for (const u of sim.queryRadius(c, radius, { kinds: UNIT_KINDS, notFriendlyTo: self.id })) {
      if (u.hero?.dead || hit.has(u.id)) continue;
      const top = { x: u.pos.x, y: u.pos.y + Math.max(0.2, u.height - 0.1), z: u.pos.z };
      if (!sim.lineOfSight(origin, centerOf(u)) && !sim.lineOfSight(origin, top)) continue;
      hit.add(u.id);
      victims.push({ e: u, at: c });
    }
  }
  for (const v of victims) {
    if (!v.e.alive || v.e.hero?.dead) continue;
    sim.dealDamage({ targetId: v.e.id, sourceId: self.id, amount: damage, type: dtype, abilityId: def.id, pos: centerOf(v.e) });
  }
  const dps = param(ctx, 'fieldDps', 15);
  const time = param(ctx, 'fieldTime', 6);
  if (dps <= 0 || time <= 0) return;
  for (const c of centers) {
    sim.spawnHazard({
      kind: NAPALM_FIELD,
      ownerId: self.id,
      pos: { ...c },
      radius: param(ctx, 'fieldRadius', 3),
      duration: time,
      tickEvery: 0.5,
      params: { damage: dps * 0.5 },
      dtype,
    });
  }
}

registerAbility({
  id: 'zhouyu_chibi',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!isUp(self)) return false;
    const dir = flatAimDir(ctx);
    const length = Math.max(0, param(ctx, 'length', 25));
    const n = Math.max(1, Math.round(param(ctx, 'blasts', 5)));
    const centers: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const d = n > 1 ? (i * length) / (n - 1) : length / 2;
      centers.push({ x: self.pos.x + dir.x * d, y: self.pos.y, z: self.pos.z + dir.z * d });
    }
    // pos = far end of the strike line, dir = its (flat) direction: the 1.5 s warning telegraph
    const end = centers[centers.length - 1];
    setCast(ctx, { pos: { x: end.x, y: sim.groundHeight(end.x, end.z), z: end.z }, dir });
    const snapshot: AbilityCtx = { ...ctx };
    sim.schedule(Math.max(0, param(ctx, 'delay', 1.5)), () => napalmStrike(snapshot, centers));
    return true;
  },
});
