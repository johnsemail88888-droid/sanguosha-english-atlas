// Coarse CPU budget check for the per-frame entity work (no WebGL needed):
// 8 heroes + 50 troops + 30 NPCs animated, IK-posed and nameplated.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HEROES, TROOPS } from '../../../src/data';
import type { ViewEntity } from '../../../src/core/types';
import { VF_ADS, VF_FIRING } from '../../../src/core/types';
import { EntityManager } from '../../../src/render/entities/manager';
import type { EntityCtx } from '../../../src/render/entities/context';
import { Effects } from '../../../src/render/vfx/effects';

describe('entity update budget', () => {
  it('animates ~90 characters well within a frame', () => {
    const ents: ViewEntity[] = [];
    let id = 1;
    const mk = (kind: ViewEntity['kind'], sub: string, i: number): ViewEntity => ({
      id: id++,
      kind,
      sub,
      x: (i % 10) * 3,
      y: 0,
      z: Math.floor(i / 10) * 3,
      yaw: i,
      pitch: 0.1,
      speed: i % 3 === 0 ? 4 : 0,
      hp: 80,
      maxHp: 100,
      shield: 0,
      flags: i % 4 === 0 ? VF_ADS | VF_FIRING : 0,
      kingdom: 'shu',
      name: `P${i}`,
    });
    HEROES.slice(0, 8).forEach((h, i) => ents.push(mk('hero', h.id, i)));
    for (let i = 0; i < 50; i++) ents.push(mk('troop', TROOPS[i % TROOPS.length].id, 8 + i));
    for (let i = 0; i < 30; i++) ents.push(mk('npc', 'yellowTurban', 58 + i));
    const scene = new THREE.Scene();
    const fx = new Effects(scene, 2);
    const mgr = new EntityManager();
    const ctx: EntityCtx = {
      time: 0,
      dt: 1 / 60,
      camPos: new THREE.Vector3(10, 5, 40),
      fovDeg: 75,
      localId: ents[0].id,
      local: null,
      squad: new Set(),
      lang: 'zh',
      fx,
      blocked: () => false,
      groundY: () => 0,
      characterDistance: 200,
      shadows: true,
      frame: 0,
    };
    mgr.sync(ents, ctx); // build
    const frames = 60;
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) {
      ctx.time += 1 / 60;
      ctx.frame++;
      for (const e of ents) {
        e.x += e.speed / 60;
      }
      mgr.sync(ents, ctx);
      fx.update(1 / 60);
    }
    const ms = (performance.now() - t0) / frames;
    // generous bound (shared CI CPUs); typical is a few ms
    expect(ms).toBeLessThan(25);
    console.log(`entity sync: ${ms.toFixed(2)} ms/frame for ${ents.length} characters`);
    mgr.dispose();
    fx.dispose();
  });
});
