// Smoke test for the 吴 Wu ability VFX (render/vfx/abilities-wu.ts): every cast (and every
// passive that announces itself) has a bespoke effect that draws without throwing, with
// full and with missing anchors.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { HERO_BY_ID, isPassiveAbility } from '../../../src/data';
import { getAbilityVfx, type AbilityEvent, type AbilityVfxContext } from '../../../src/render/vfx/abilities';
import { WU_VFX_IDS, registerWuAbilityVfx } from '../../../src/render/vfx/abilities-wu';
import { Effects } from '../../../src/render/vfx/effects';

const WU = ['sunquan', 'ganning', 'lumeng', 'huanggai', 'zhouyu', 'daqiao', 'luxun', 'sunshangxiang'];
/** passives that emit an 'ability' event when they trigger (wu/util.ts emitTrigger) */
const EVENT_PASSIVES = ['lumeng_keji', 'daqiao_liuli', 'luxun_lianying', 'sunshangxiang_xiaoji'];

describe('吴 ability VFX', () => {
  it('registers a bespoke effect for every cast and event-emitting passive, and never throws', () => {
    registerWuAbilityVfx();
    registerWuAbilityVfx(); // idempotent
    const fx = new Effects(new THREE.Scene(), 2);
    const ids = WU.flatMap((h) => HERO_BY_ID[h].abilities.filter((a) => !isPassiveAbility(a) || EVENT_PASSIVES.includes(a.id)).map((a) => a.id));
    expect(ids.length).toBe(21);
    expect([...WU_VFX_IDS].sort()).toEqual([...ids].sort());
    const src = { id: 1, kind: 'hero' as const, sub: 'zhouyu', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 300, maxHp: 300, shield: 0, flags: 0, kingdom: 'wu' as const };
    const full: AbilityVfxContext = {
      fx,
      src,
      srcPos: new THREE.Vector3(0, 1, 0),
      targetPos: new THREE.Vector3(0, 1, -12),
      point: new THREE.Vector3(3, 1, -20),
      dir: new THREE.Vector3(0, 0, -1),
      color: new THREE.Color(0.5, 2, 1),
      localId: 1,
    };
    const empty: AbilityVfxContext = { ...full, src: undefined, srcPos: null, targetPos: null, point: null, dir: new THREE.Vector3(0, 0, 0) };
    for (const id of ids) {
      const fn = getAbilityVfx(id);
      expect(fn, id).toBeTypeOf('function');
      const ev: AbilityEvent = { t: 'ability', src: 1, ability: id };
      expect(() => fn!(full, ev), id).not.toThrow();
      expect(() => fn!(empty, ev), `${id} without anchors`).not.toThrow();
    }
    expect(() => fx.update(0.1)).not.toThrow();
    fx.dispose();
  });
});
