// Smoke test for the bespoke 蜀 ability VFX (render/vfx/abilities-shu.ts):
// every effect runs headless (no WebGL needed for the pools), spawns something
// for a normal cast, and survives degenerate contexts (caster out of view, no
// target, no point, zero direction, ev.pos far away).
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SHU_HEROES } from '../../../src/data/heroes-shu';
import { getAbilityVfx, type AbilityEvent, type AbilityVfxContext } from '../../../src/render/vfx/abilities';
import { SHU_VFX_IDS, registerShuAbilityVfx } from '../../../src/render/vfx/abilities-shu';
import { Effects } from '../../../src/render/vfx/effects';

function ctxFor(fx: Effects, over: Partial<AbilityVfxContext> = {}): AbilityVfxContext {
  return {
    fx,
    src: undefined,
    srcPos: new THREE.Vector3(0, 1.2, 0),
    targetPos: new THREE.Vector3(0, 1.1, -8),
    point: new THREE.Vector3(0, 0, -6),
    dir: new THREE.Vector3(0, 0, -1),
    color: new THREE.Color(2, 0.6, 0.5),
    localId: 1,
    ...over,
  };
}

describe('蜀 ability VFX', () => {
  it('registers a bespoke effect for every Shu active and the event-emitting passives', () => {
    registerShuAbilityVfx();
    const actives = SHU_HEROES.flatMap((h) => h.abilities.filter((a) => a.slot !== 'passive').map((a) => a.id));
    for (const id of actives) expect(SHU_VFX_IDS, id).toContain(id);
    for (const id of ['zhugeliang_guanxing', 'zhaoyun_longdan', 'huangyueying_jizhi']) expect(SHU_VFX_IDS).toContain(id);
    for (const id of SHU_VFX_IDS) expect(getAbilityVfx(id), id).toBeTypeOf('function');
  });

  it('every effect spawns something and survives degenerate contexts', () => {
    registerShuAbilityVfx();
    const fx = new Effects(new THREE.Scene(), 2);
    const live = (): number => fx.add.liveCount + fx.alpha.liveCount;
    for (const id of SHU_VFX_IDS) {
      const fn = getAbilityVfx(id)!;
      const ev: AbilityEvent = { t: 'ability', src: 1, ability: id };
      expect(live(), 'previous effects expired').toBe(0);
      fn(ctxFor(fx), ev);
      fx.update(1e-3);
      expect(live(), `${id} spawns particles`).toBeGreaterThan(0);
      for (const over of [
        { srcPos: null },
        { targetPos: null },
        { point: null, targetPos: null },
        { dir: new THREE.Vector3(0, 0, 0) },
        { point: new THREE.Vector3(0, 0, -59) },
      ] as Partial<AbilityVfxContext>[]) {
        expect(() => fn(ctxFor(fx, over), ev), `${id} ${JSON.stringify(Object.keys(over))}`).not.toThrow();
      }
      fx.update(5);
    }
    fx.dispose();
  });
});
