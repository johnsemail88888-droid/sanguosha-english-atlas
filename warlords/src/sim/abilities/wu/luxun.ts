// 陆逊 Lu Xun — 谦逊 (immune to charm / dance / theft), 连营 (half-mag refill on
// empty), 火烧连营 (line of fire fields), 燎原 (no-ammo + fields grow and refresh).
import type { Vec3 } from '../../../core/math';
import type { Entity } from '../../../core/types';
import type { SimApi } from '../../api';
import { usesAmmo } from '../../defs';
import { ext } from '../../ext';
import { flatAimDir, getState, param, setState } from '../common';
import { registerAbility } from '../registry';
import { centerOf, emitTrigger, isUp, otherAbilityParam, otherAbilityState, registerFieldKind, setCast } from './util';

const QIANXUN_IMMUNE: ReadonlySet<string> = new Set(['charm', 'dance', 'steal']);

// 谦逊 (passive): charm, 乐不思蜀 (dance) and theft never land on you.
registerAbility({
  id: 'luxun_qianxun',
  canBeAffected: (_ctx, status) => !QIANXUN_IMMUNE.has(status),
});

// 连营 (passive): when the magazine empties, load refillFrac of a magazine from reserve (icd s).
registerAbility({
  id: 'luxun_lianying',
  onMagEmpty(ctx, weaponId) {
    const { sim, self } = ctx;
    if (!isUp(self) || sim.time < getState(ctx, 'ready')) return;
    const w = ext(sim).activeWeapon(self.id);
    if (!w || w.inst.id !== weaponId || !usesAmmo(w.def) || w.inst.mag > 0) return;
    const want = Math.max(1, Math.ceil(w.def.magSize * Math.min(1, Math.max(0, param(ctx, 'refillFrac', 0.5)))));
    const take = Math.min(want, w.inst.reserve);
    if (take <= 0) return;
    w.inst.mag += take;
    w.inst.reserve -= take;
    if (self.hero) self.hero.reloadUntil = 0;
    setState(ctx, 'ready', sim.time + param(ctx, 'icd', 5));
    emitTrigger(ctx);
  },
});

// ── fire fields ─────────────────────────────────────────────────────────────
/** 陆逊's fire fields: overlapping fields of one cast burn a unit once per tick (see registerFieldKind). */
export const LUXUN_FIELD = 'luxun_fire';
const HUOSHAO_ID = 'luxun_huoshao';
const LIAOYUAN_ID = 'luxun_liaoyuan';

registerFieldKind(LUXUN_FIELD, 'fire');

/** A fire field of `owner`: grows ×mul once (params._grown) and burns for `dur` s more. */
function spreadField(sim: SimApi, e: Entity, mul: number, dur: number): void {
  const hz = e.hazard;
  if (!hz || !e.alive) return;
  if (!(hz.params._grown ?? 0)) {
    hz.radius *= mul;
    e.radius = hz.radius;
    hz.params._grown = 1;
  }
  hz.expiresAt = Math.max(hz.expiresAt, sim.time + Math.max(0, hz.params._dur ?? dur));
}

// 火烧连营 (Q): `count` fire fields along the aim yaw, `spacing` m apart, stopping at walls.
// Laid while 燎原 burns, they are already spread (×spreadMul radius).
registerAbility({
  id: HUOSHAO_ID,
  activate(ctx) {
    const { sim, self, def } = ctx;
    if (!isUp(self)) return false;
    const dir = flatAimDir(ctx);
    const count = Math.max(1, Math.round(param(ctx, 'count', 5)));
    const spacing = Math.max(0.5, param(ctx, 'spacing', 4));
    const duration = param(ctx, 'duration', 5);
    const spread = sim.time < otherAbilityState(self, LIAOYUAN_ID, 'until');
    const mul = spread ? Math.max(1, otherAbilityParam(ctx, LIAOYUAN_ID, 'spreadMul', 1.5)) : 1;
    const radius = param(ctx, 'radius', 2.5) * mul;
    const chest: Vec3 = { x: self.pos.x, y: self.pos.y + 1.1, z: self.pos.z };
    let last: Vec3 | undefined;
    for (let i = 0; i < count; i++) {
      const d = spacing * (0.75 + i);
      // spawnHazard settles the field on the floor at his level (terrain, or a surface ≤ 2.5 m
      // above his feet — never the roof over his head)
      const field = sim.spawnHazard({
        kind: LUXUN_FIELD,
        ownerId: self.id,
        pos: { x: self.pos.x + dir.x * d, y: self.pos.y + 0.5, z: self.pos.z + dir.z * d },
        radius,
        duration,
        tickEvery: 0.5,
        params: { damage: param(ctx, 'dps', 20) * 0.5, _dur: duration, _grown: spread ? 1 : 0 },
        dtype: def.dtype ?? 'fire',
      });
      // the fire doesn't jump walls (or climb cliffs): the line ends at the first blocked field
      if (!sim.lineOfSight(chest, { x: field.pos.x, y: field.pos.y + 0.8, z: field.pos.z })) {
        sim.removeEntity(field.id);
        break;
      }
      last = { ...field.pos };
    }
    // pos = the last field laid, dir = the line's direction
    setCast(ctx, { pos: last ?? centerOf(self), dir });
    return true;
  },
});

// 燎原 (E): `duration` s of shots that use no ammo; every fire field you own grows ×spreadMul in
// radius (once) and its burn time is refreshed.
registerAbility({
  id: LIAOYUAN_ID,
  activate(ctx) {
    const { sim, self } = ctx;
    if (!isUp(self)) return false;
    const dur = param(ctx, 'duration', 6);
    sim.applyStatus(self.id, 'noReload', dur, { sourceId: self.id });
    setState(ctx, 'until', sim.time + dur);
    const mul = Math.max(1, param(ctx, 'spreadMul', 1.5));
    const fieldDur = otherAbilityParam(ctx, HUOSHAO_ID, 'duration', 5);
    for (const e of sim.entities()) {
      if (e.kind !== 'hazard' || e.ownerId !== self.id || !e.hazard) continue;
      const k = e.hazard.kind;
      if (k === LUXUN_FIELD || k.includes('fire') || k.includes('napalm')) spreadField(sim, e, mul, fieldDur);
    }
    setCast(ctx, { pos: centerOf(self) });
    return true;
  },
});

