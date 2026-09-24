// 郭嘉 Guo Jia — 天妒 / 遗计 / 鬼谋.
import type { Vec3 } from '../../../core/math';
import { ext } from '../../ext';
import { rollRewardItems } from '../../loot';
import { crosshairEnemy, crosshairPoint, getState, param, setState } from '../common';
import { registerAbility } from '../registry';
import { canAct, emitProc, grantRandomItems, isDirectHit, setCast } from './shared';

// 天妒 (passive): a single hit that takes ≥ 40 HP from you grants 1 random item and refills your
// magazine (6 s internal cooldown). DoT ticks, reflects and the zone are not "hits".
registerAbility({
  id: 'guojia_tiandu',
  onDamageTaken(ctx, dealt) {
    const { sim, self, req } = ctx;
    if (self.hero?.dead || self.hero?.downed || !isDirectHit(req)) return;
    if (!(dealt >= param(ctx, 'threshold', 40))) return;
    const now = sim.time;
    if (now < getState(ctx, 'readyAt')) return;
    setState(ctx, 'readyAt', now + param(ctx, 'icd', 6));
    grantRandomItems(sim, self, Math.max(1, Math.round(param(ctx, 'items', 1))));
    ext(sim).refillMag(self.id);
    emitProc(ctx, 0);
  },
});

// 遗计 (Q): call a supply drop at the crosshair (≤ 40 m). A smoke marker shows where it will
// land (everyone can see — and contest — it); after 3 s it lands with 2 random items. The drop
// arrives even if you die meanwhile (it is a *legacy* stratagem).
registerAbility({
  id: 'guojia_yiji',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    const range = param(ctx, 'range', 40);
    const p = crosshairPoint(ctx, range);
    // step back off wall faces toward the caster so the crate never lands inside geometry
    const dx = self.pos.x - p.x;
    const dz = self.pos.z - p.z;
    const d = Math.hypot(dx, dz);
    const back = Math.min(0.8, d);
    const at: Vec3 = d > 1e-3 ? { x: p.x + (dx / d) * back, y: p.y, z: p.z + (dz / d) * back } : { ...p };
    if (!Number.isFinite(at.x + at.y + at.z)) return false;
    const delay = Math.max(0, param(ctx, 'delay', 3));
    const n = Math.max(0, Math.round(param(ctx, 'items', 2)));
    sim.spawnHazard({ kind: 'yijiSmoke', ownerId: self.id, pos: at, radius: 1.5, duration: delay, tickEvery: 5, params: {} });
    setCast(ctx, { pos: at });
    sim.schedule(delay, () => {
      const ids = rollRewardItems(sim.rng, n);
      ids.forEach((itemId, i) => {
        const a = (i / Math.max(1, ids.length)) * Math.PI * 2 + 0.4;
        const r = ids.length > 1 ? 1.1 : 0;
        sim.spawnLoot({ x: at.x + Math.cos(a) * r, y: at.y, z: at.z + Math.sin(a) * r }, { itemId });
      });
      sim.emit({ t: 'explosion', pos: { ...at }, radius: 2, kind: 'holy' });
      sim.emit({ t: 'sfx', name: 'airdropLand', pos: { ...at } });
    });
    return true;
  },
});

// 鬼谋 (E): mark the enemy under the crosshair for 6 s — it takes ×1.25 damage from every
// source, is revealed to everyone and your squad focuses it. The reveal / mark are
// information (never stopped by 无懈可击); the vulnerability is a debuff 无懈可击 can cancel.
registerAbility({
  id: 'guojia_guimou',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(ctx)) return false;
    const target = crosshairEnemy(ctx, param(ctx, 'range', 60));
    if (!target) return false;
    const duration = param(ctx, 'duration', 6);
    sim.applyStatus(target.id, 'reveal', duration, { sourceId: self.id });
    sim.applyStatus(target.id, 'marked', duration, { sourceId: self.id });
    sim.applyStatus(target.id, 'dmgTakenUp', duration, { sourceId: self.id, params: { mul: param(ctx, 'takenMul', 1.25) } });
    setCast(ctx, { pos: target.pos, target: target.id });
    return true;
  },
});
