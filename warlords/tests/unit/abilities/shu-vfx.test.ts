// Smoke test for the bespoke 蜀 ability VFX (render/vfx/abilities-shu.ts):
// every effect runs headless (no WebGL needed for the pools), spawns something
// for a normal cast, and survives degenerate contexts (caster out of view, no
// target, no point, zero direction, ev.pos far away).
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SHU_HEROES } from '../../../src/data/heroes-shu';
import { getAbilityVfx, type AbilityEvent, type AbilityVfxContext } from '../../../src/render/vfx/abilities';
import { SHU_VFX_IDS, registerShuAbilityVfx } from '../../../src/render/vfx/abilities-shu';
import { Effects, type BurstOptions } from '../../../src/render/vfx/effects';

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

  it('geometry: small 八阵图 seal, dashes ignore the raw crosshair, 青龙斩 stops short of its target, no long 百步穿杨 tracer', () => {
    registerShuAbilityVfx();
    const fx = new Effects(new THREE.Scene(), 2);
    const sizes: number[] = [];
    const beams: number[] = [];
    const tracers: number[] = [];
    const burst = fx.burst.bind(fx);
    fx.burst = (p: THREE.Vector3, o: BurstOptions): void => {
      if (o.size) sizes.push(Math.max(o.size[0], o.size[1]));
      burst(p, o);
    };
    const beam = fx.beams.beam.bind(fx.beams);
    fx.beams.beam = (a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color, width: number, life: number, alpha?: number): void => {
      beams.push(a.distanceTo(b));
      beam(a, b, color, width, life, alpha);
    };
    const tracer = fx.beams.tracer.bind(fx.beams);
    fx.beams.tracer = (a: THREE.Vector3, b: THREE.Vector3, ...rest: [THREE.Color, number?, number?, number?, number?]): void => {
      tracers.push(a.distanceTo(b));
      tracer(a, b, ...rest);
    };
    const run = (id: string, over: Partial<AbilityVfxContext> = {}): void => {
      sizes.length = 0;
      beams.length = 0;
      tracers.length = 0;
      getAbilityVfx(id)!(ctxFor(fx, over), { t: 'ability', src: 1, ability: id });
    };
    const P = (id: string, key: string): number => SHU_HEROES.flatMap((h) => h.abilities).find((a) => a.id === id)!.params[key];
    // 八阵图: particles face the camera — no sprite bigger than a ~2 m seal
    run('zhugeliang_bazhen', { point: new THREE.Vector3(0, 0, -14) });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2.5);
    // direction dashes: the raw crosshair 6 m ahead (ctxFor's point) is not where they end
    run('zhaoyun_qijin');
    expect(beams[0]).toBeCloseTo(P('zhaoyun_qijin', 'dash'), 3);
    run('machao_charge');
    expect(beams[0]).toBeCloseTo(P('machao_charge', 'dash'), 3);
    run('guanyu_qinglong', { targetPos: null });
    expect(beams[0]).toBeCloseTo(P('guanyu_qinglong', 'dash'), 3);
    run('guanyu_qinglong', { targetPos: new THREE.Vector3(0.5, 1.1, -6) }); // in the corridor: stops ~1.6 m short
    expect(beams[0]).toBeCloseTo(6 - 1.6, 3);
    run('guanyu_qinglong', { targetPos: new THREE.Vector3(5, 1.1, -6) }); // off to the side: full charge
    expect(beams[0]).toBeCloseTo(P('guanyu_qinglong', 'dash'), 3);
    // 百步穿杨: the projectile renderer draws the arrow; no tracer through walls
    run('huangzhong_chuanyang');
    expect(tracers).toEqual([]);
    expect(Math.max(...beams)).toBeLessThanOrEqual(3.01);
    // 长坂救主: an aimed hero beyond the rescue range is not the one he dashed to
    run('zhaoyun_jiuzhu', { targetPos: new THREE.Vector3(0, 1.1, -40) });
    expect(beams).toEqual([]);
    run('zhaoyun_jiuzhu', { targetPos: new THREE.Vector3(0, 1.1, -12) });
    expect(beams.length).toBeGreaterThan(0);
    fx.update(5);
    fx.dispose();
  });
});
