// Every VFX module is registered by registerAllVfx() (render/vfx/registerAll.ts
// glob): the four per-kingdom ability files and items-vfx. Every active hero
// ability and every card item then has a bespoke effect.
import { describe, expect, it } from 'vitest';
import { HEROES, ITEMS, isPassiveAbility } from '../../../src/data';
import { getAbilityVfx } from '../../../src/render/vfx/abilities';
import { getItemVfx } from '../../../src/render/vfx/itemRegistry';
import { registerAllVfx } from '../../../src/render/vfx/registerAll';
import * as shu from '../../../src/render/vfx/abilities-shu';
import * as wei from '../../../src/render/vfx/abilities-wei';
import * as wu from '../../../src/render/vfx/abilities-wu';
import * as qun from '../../../src/render/vfx/abilities-qun';
import * as items from '../../../src/render/vfx/items-vfx';

describe('registerAllVfx', () => {
  it('finds a register…Vfx export in every VFX module', () => {
    for (const [name, mod] of Object.entries({ shu, wei, wu, qun, items })) {
      const fns = Object.entries(mod).filter(([k, v]) => /^register\w*Vfx$/.test(k) && typeof v === 'function');
      expect(fns.length, name).toBeGreaterThan(0);
    }
  });

  it('registers a VFX for every active ability of all 30 heroes', () => {
    registerAllVfx();
    expect(HEROES.length).toBe(30);
    const missing: string[] = [];
    for (const h of HEROES) {
      for (const a of h.abilities) {
        if (a.slot === 'passive' || isPassiveAbility(a)) continue;
        if (!getAbilityVfx(a.id)) missing.push(`${h.id}:${a.id}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('registers a VFX for every playable card (basic / trick / delayed trick / utility)', () => {
    registerAllVfx();
    const cards = ITEMS.filter((i) => i.kind === 'basic' || i.kind === 'trick' || i.kind === 'delayTrick' || i.kind === 'utility');
    expect(cards.length).toBeGreaterThan(15);
    expect(cards.filter((i) => !getItemVfx(i.id)).map((i) => i.id)).toEqual([]);
  });
});
