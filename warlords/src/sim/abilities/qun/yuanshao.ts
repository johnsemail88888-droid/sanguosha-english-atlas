// 袁绍 Yuan Shao ★ — 名门 (passive), 乱击 (Q), 四世三公 (E), 血裔 (passive lord skill).
import { crosshairPoint, param, summonTroops } from '../common';
import { registerAbility } from '../registry';
import { canAct, setCastEvent } from './util';

// 名门 (passive): squad +1 (HeroDef.troopBonus, applied by the world at spawn — not again
// here); every soldier you field (squad, 征兵令, 四世三公 crossbowmen) has +20 % max HP.
registerAbility({
  id: 'yuanshao_mingmen',
  modifiers(ctx) {
    return { troopHpMul: param(ctx, 'troopHpMul', 1.2) };
  },
});

// 乱击 (Q): arrow rain on a 10 m circle at the crosshair (≤ 60 m) for 3 s: 16 damage to every
// enemy inside every 0.5 s (a lingering field: undodgeable, never consumes 无懈可击).
registerAbility({
  id: 'yuanshao_luanji',
  activate(ctx) {
    const { sim, self } = ctx;
    if (!canAct(self)) return false;
    const point = crosshairPoint(ctx, param(ctx, 'range', 60));
    sim.spawnHazard({
      kind: 'arrowRain',
      ownerId: self.id,
      pos: point,
      radius: param(ctx, 'radius', 10),
      duration: param(ctx, 'duration', 3),
      tickEvery: Math.max(0.1, param(ctx, 'tickEvery', 0.5)),
      params: { damage: param(ctx, 'damage', 16) },
      dtype: ctx.def.dtype ?? 'normal',
    });
    setCastEvent(ctx, { pos: point });
    return true;
  },
});

// 四世三公 (E): 4 Yuan crossbowmen join your squad for 25 s (they follow your orders).
registerAbility({
  id: 'yuanshao_sishi',
  activate(ctx) {
    const { self } = ctx;
    if (!canAct(self)) return false;
    const count = Math.max(0, Math.floor(param(ctx, 'count', 4)));
    const spawned = summonTroops(ctx, 'qun_crossbowman', count, param(ctx, 'lifetime', 25));
    setCastEvent(ctx, { pos: { ...self.pos } });
    return spawned.length > 0;
  },
});

// 血裔 (passive lord skill — no cooldown, no activate): as the real Lord, +50 max HP per other
// living (not yet dead; downed counts) Qun hero, at most 3; and 1 more soldier at spawn.
registerAbility({
  id: 'yuanshao_xueyi',
  modifiers(ctx) {
    const { sim, self } = ctx;
    if (sim.roleOf(self) !== 'lord') return undefined;
    let qun = 0;
    for (const h of sim.heroes()) {
      if (h === self || !h.hero || h.hero.dead) continue;
      if (sim.heroDef(h)?.kingdom === 'qun') qun++;
    }
    const n = Math.min(Math.max(0, Math.floor(param(ctx, 'maxQun', 3))), qun);
    return { maxHpBonus: param(ctx, 'hpPerQun', 50) * n, squadBonus: param(ctx, 'squadBonus', 1) };
  },
});
