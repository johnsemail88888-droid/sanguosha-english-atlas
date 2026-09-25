// GameEvent → visuals: ability events. A passive proc (ev.proc, e.g. 奸雄 / 流离 /
// 连营) plays its VFX but never the caster's cast gesture (WEI-10).
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { GameEvent } from '../../../src/core/types';
import { registerAbilityVfx } from '../../../src/render/vfx/abilities';
import { handleEvents, type EventVfxDeps } from '../../../src/render/vfx/eventVfx';

/** A stand-in for a CharacterView: counts cast gestures. */
function fakeCharacter(id: number) {
  const v = {
    id,
    casts: 0,
    last: { id, kind: 'hero', sub: 'caocao', kingdom: 'wei', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 400, maxHp: 400, shield: 0, flags: 0 },
    onCast() {
      v.casts++;
    },
    chestWorld(out: THREE.Vector3) {
      return out.set(0, 1.2, 0);
    },
  };
  return v;
}

/** Effects stub: every property is a no-op function returning another stub. */
function stubFx(): EventVfxDeps['fx'] {
  const fn: unknown = new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : fn),
    apply: () => fn,
  });
  return fn as EventVfxDeps['fx'];
}

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

function run(evs: GameEvent[], ch: ReturnType<typeof fakeCharacter>): void {
  handleEvents(evs, {
    fx: stubFx(),
    entities: { character: (id: number) => (id === ch.id ? ch : undefined), view: () => undefined } as unknown as EventVfxDeps['entities'],
    localId: null,
    consumePredictedShot: () => false,
    lang: 'zh',
    time: 1,
    camPos: new THREE.Vector3(0, 2, 5),
  });
}

describe('eventVfx: ability events', () => {
  it('an activation plays the cast gesture and the ability VFX', () => {
    let vfx = 0;
    unregister = registerAbilityVfx('test_ability', () => void vfx++);
    const ch = fakeCharacter(3);
    run([{ t: 'ability', src: 3, ability: 'test_ability' }], ch);
    expect(ch.casts).toBe(1);
    expect(vfx).toBe(1);
  });

  it('a passive proc skips the cast gesture but still plays its VFX', () => {
    let vfx = 0;
    let sawProc: boolean | undefined;
    unregister = registerAbilityVfx('test_ability', (_ctx, ev) => {
      vfx++;
      sawProc = ev.proc;
    });
    const ch = fakeCharacter(3);
    run([{ t: 'ability', src: 3, ability: 'test_ability', proc: true }], ch);
    expect(ch.casts).toBe(0);
    expect(vfx).toBe(1);
    expect(sawProc).toBe(true);
  });
});
