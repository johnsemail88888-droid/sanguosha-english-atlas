// Smoke test for src/render/vfx/abilities-wei.ts: every Wei ability has a
// bespoke VFX, and each runs against a real Effects instance (headless
// three.js objects) with full, partial and empty contexts without throwing.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../../src/core/types';
import { HERO_BY_ID, isPassiveAbility } from '../../../src/data';
import { getAbilityVfx, type AbilityVfxContext } from '../../../src/render/vfx/abilities';
import { registerWeiAbilityVfx } from '../../../src/render/vfx/abilities-wei';
import { Effects } from '../../../src/render/vfx/effects';

const WEI = ['caocao', 'simayi', 'xiahoudun', 'zhangliao', 'xuchu', 'guojia', 'zhenji', 'xiahouyuan'];
/** Passives whose triggers the sim reports as ability events (the rest are silent hooks). */
const PROCS = ['caocao_jianxiong', 'simayi_fankui', 'guojia_tiandu'];

describe('魏 ability VFX', () => {
  it('registers a bespoke effect for every Wei active / reported proc and none of them throw', () => {
    registerWeiAbilityVfx();
    registerWeiAbilityVfx(); // idempotent
    const fx = new Effects(new THREE.Scene(), 2);
    const ids = [...WEI.flatMap((h) => HERO_BY_ID[h].abilities.filter((a) => !isPassiveAbility(a)).map((a) => a.id)), ...PROCS];
    expect(ids.length).toBe(17 + PROCS.length);
    for (const id of ids) {
      const fn = getAbilityVfx(id);
      expect(fn, id).toBeTypeOf('function');
      const ev: Extract<GameEvent, { t: 'ability' }> = { t: 'ability', src: 1, ability: id, pos: { x: 0, y: 0, z: -70 }, target: 2, dir: { x: 0, y: -0.2, z: -1 } };
      const full: AbilityVfxContext = {
        fx,
        src: undefined,
        srcPos: new THREE.Vector3(0, 1, 0),
        targetPos: new THREE.Vector3(0, 1, -8),
        point: new THREE.Vector3(0, 0, -70),
        dir: new THREE.Vector3(0, -0.2, -1).normalize(),
        color: new THREE.Color(0.5, 0.9, 2.2),
        localId: 1,
      };
      expect(() => fn!(full, ev), `${id} full`).not.toThrow();
      expect(() => fn!({ ...full, targetPos: null, point: null }, ev), `${id} no target`).not.toThrow();
      expect(() => fn!({ ...full, srcPos: null, targetPos: null, point: null }, ev), `${id} nothing`).not.toThrow();
    }
    expect(() => fx.update(0.1)).not.toThrow();
    fx.dispose();
  });
});
