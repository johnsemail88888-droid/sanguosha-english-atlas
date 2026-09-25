// Smoke test for the 群 Qun ability VFX (render/vfx/abilities-qun.ts): every entry
// registers and draws without throwing, with full and with missing anchors.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { HERO_BY_ID, isPassiveAbility } from '../../../src/data';
import { getAbilityVfx, type AbilityEvent, type AbilityVfxContext } from '../../../src/render/vfx/abilities';
import { registerQunAbilityVfx } from '../../../src/render/vfx/abilities-qun';
import { Effects } from '../../../src/render/vfx/effects';

const QUN = ['huatuo', 'lubu', 'diaochan', 'zhangjiao', 'yuanshao', 'menghuo'];
/** passives that announce themselves with an 'ability' event */
const EVENT_PASSIVES = ['huatuo_jijiu', 'menghuo_zaiqi'];

describe('群 ability VFX', () => {
  it('registers a bespoke effect for every cast (and event-emitting passive) and never throws', () => {
    registerQunAbilityVfx();
    registerQunAbilityVfx(); // idempotent
    const fx = new Effects(new THREE.Scene(), 2);
    const ids = QUN.flatMap((h) => HERO_BY_ID[h].abilities.filter((a) => !isPassiveAbility(a) || EVENT_PASSIVES.includes(a.id)).map((a) => a.id));
    expect(ids.length).toBeGreaterThanOrEqual(15);
    const src = { id: 1, kind: 'hero' as const, sub: 'lubu', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 400, maxHp: 400, shield: 0, flags: 0, kingdom: 'qun' as const };
    const full: AbilityVfxContext = {
      fx,
      src,
      srcPos: new THREE.Vector3(0, 1, 0),
      targetPos: new THREE.Vector3(0, 1, -12),
      point: new THREE.Vector3(3, 1, -80), // beyond every range: clamped
      dir: new THREE.Vector3(0, 0, -1),
      color: new THREE.Color(1, 1, 1),
      localId: 1,
    };
    const empty: AbilityVfxContext = { ...full, src: undefined, srcPos: null, targetPos: null, point: null };
    // someone else's cast (self-centred pillars are only toned down for the local caster), no local player at all
    const remote: AbilityVfxContext = { ...full, localId: 2 };
    const spectator: AbilityVfxContext = { ...full, localId: null };
    for (const id of ids) {
      const fn = getAbilityVfx(id);
      expect(fn, id).toBeTypeOf('function');
      const ev: AbilityEvent = { t: 'ability', src: 1, ability: id };
      expect(() => fn!(full, ev), id).not.toThrow();
      expect(() => fn!(empty, ev), `${id} without anchors`).not.toThrow();
      expect(() => fn!(remote, ev), `${id} remote caster`).not.toThrow();
      expect(() => fn!(spectator, ev), `${id} no local player`).not.toThrow();
    }
    expect(() => fx.update(0.1)).not.toThrow();
    fx.dispose();
  });
});
