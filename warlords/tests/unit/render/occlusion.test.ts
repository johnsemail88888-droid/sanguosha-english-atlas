// Overhead UI line of sight (G3-1): nameplates / pennants are drawn on top of
// the world (depthTest off), so anything behind a wall or a hill must fade to 0
// — except your own hero / squad and revealed (VF_EXPOSED) heroes.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Vec3 } from '../../../src/core/math';
import type { MapData } from '../../../src/core/map';
import type { ViewEntity } from '../../../src/core/types';
import { VF_EXPOSED } from '../../../src/core/types';
import { PickWorld } from '../../../src/render/camera/pick';
import type { EntityCtx } from '../../../src/render/entities/context';
import { EntityManager } from '../../../src/render/entities/manager';
import {
  LOS_MAX_AGE_HERO,
  LOS_STAGGER,
  LosCache,
  needsLos,
  overheadTarget,
  stepOcclusion,
} from '../../../src/render/entities/occlusion';
import { Effects } from '../../../src/render/vfx/effects';

const open = { exposed: false, local: false, squad: false };

describe('overheadTarget / stepOcclusion', () => {
  it('blocked → target 0; in sight → 1', () => {
    expect(overheadTarget(true, open)).toBe(0);
    expect(overheadTarget(false, open)).toBe(1);
  });

  it('blocked but revealed (VF_EXPOSED), own hero or own squad → visible', () => {
    expect(overheadTarget(true, { ...open, exposed: true })).toBe(1);
    expect(overheadTarget(true, { ...open, local: true })).toBe(1);
    expect(overheadTarget(true, { ...open, squad: true })).toBe(1);
  });

  it('always-visible markers never pay for a line-of-sight test', () => {
    expect(needsLos(open, 30)).toBe(true);
    expect(needsLos(open, 2)).toBe(false);
    expect(needsLos({ ...open, squad: true }, 30)).toBe(false);
    expect(needsLos({ ...open, exposed: true }, 30)).toBe(false);
  });

  it('fades all the way to 0 (not a 0.12 ghost) and back to 1', () => {
    let o = 1;
    for (let i = 0; i < 30; i++) o = stepOcclusion(o, 0, 1 / 60);
    expect(o).toBe(0);
    for (let i = 0; i < 30; i++) o = stepOcclusion(o, 1, 1 / 60);
    expect(o).toBe(1);
  });
});

describe('LosCache (staggered, cached)', () => {
  it('tests on the first frame, then every LOS_STAGGER frames', () => {
    const c = new LosCache();
    expect(c.due(3, 0, 7)).toBe(true);
    c.set(true, 0);
    let tests = 0;
    for (let f = 4; f < 4 + LOS_STAGGER * 10; f++) if (c.due(f, 0, 7)) tests++;
    expect(tests).toBe(10);
  });

  it('heroes are re-tested once the result is LOS_MAX_AGE_HERO old (low frame rates)', () => {
    const c = new LosCache();
    c.set(true, 1);
    // frame (1 + 7) % 8 === 0 would be the stagger slot; pick frames off-slot
    expect(c.due(2, 1 + LOS_MAX_AGE_HERO * 0.5, 7, LOS_MAX_AGE_HERO)).toBe(false);
    expect(c.due(2, 1 + LOS_MAX_AGE_HERO, 7, LOS_MAX_AGE_HERO)).toBe(true);
  });
});

// ── integration: EntityManager + CharacterView with a real PickWorld ─────────

/** 128 m map, flat at 0 with a 12 m ridge across z ∈ [-6, 6]. */
function hillMap(): MapData {
  const res = 64;
  const n = res + 1;
  const size = 128;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const z = -size / 2 + (j * size) / res;
      heights[j * n + i] = Math.abs(z) <= 6 ? 12 : 0;
    }
  return {
    seed: 1,
    nameZh: '',
    nameEn: '',
    size,
    res,
    heights,
    waterLevel: -5,
    props: [],
    colliders: [],
    lordSpawn: { x: 0, y: 0, z: 0 },
    spawns: [],
    lootSpots: [],
    crateSpots: [],
    camps: [],
    regions: [],
  };
}

const unit = (id: number, kind: ViewEntity['kind'], sub: string, x: number, z: number, flags = 0): ViewEntity => ({
  id,
  kind,
  sub,
  x,
  y: 0,
  z,
  yaw: 0,
  pitch: 0,
  speed: 0,
  hp: 100,
  maxHp: 100,
  shield: 0,
  flags,
  kingdom: 'shu',
  name: `P${id}`,
});

function setup() {
  const world = new PickWorld(hillMap());
  const scene = new THREE.Scene();
  const fx = new Effects(scene, 1);
  const mgr = new EntityManager();
  let segTests = 0;
  const ctx: EntityCtx = {
    time: 0,
    dt: 1 / 60,
    // camera south of the ridge, looking north over it
    camPos: new THREE.Vector3(0, 3, 30),
    fovDeg: 70,
    localId: 1,
    local: null,
    squad: new Set([11]),
    lang: 'zh',
    fx,
    blocked: (a: Vec3, b: Vec3) => {
      segTests++;
      return world.segmentBlocked(a, b);
    },
    groundY: () => 0,
    characterDistance: 200,
    badges: mgr.badges,
    shadows: false,
    frame: 0,
  };
  const step = (ents: ViewEntity[], frames: number, dt = 1 / 60): void => {
    for (let f = 0; f < frames; f++) {
      ctx.frame++;
      ctx.time += dt;
      ctx.dt = dt;
      mgr.sync(ents, ctx);
    }
  };
  const plate = (id: number) => (mgr.character(id) as unknown as { plate: { opacity: number; sprite: THREE.Sprite } | null }).plate;
  return { world, mgr, ctx, step, plate, fx, segs: () => segTests };
}

describe('CharacterView overhead UI behind a hill', () => {
  it('segmentBlocked sees the terrain ridge (not only colliders)', () => {
    const { world } = setup();
    expect(world.segmentBlocked({ x: 0, y: 3, z: 30 }, { x: 0, y: 2, z: -30 })).toBe(true);
    expect(world.segmentBlocked({ x: 0, y: 3, z: 30 }, { x: 0, y: 2, z: 12 })).toBe(false);
  });

  it('a hero behind the hill has no plate; a revealed one keeps it', () => {
    const s = setup();
    const me = unit(1, 'hero', 'zhangfei', 0, 27);
    const hidden = unit(2, 'hero', 'liubei', 0, -30);
    const exposed = unit(3, 'hero', 'caocao', 4, -30, VF_EXPOSED);
    const ents = [me, hidden, exposed];
    s.step(ents, 1);
    // never flashes in, not even on the first frame
    expect(s.plate(2)!.opacity).toBe(0);
    s.step(ents, 30);
    expect(s.plate(2)!.opacity).toBe(0);
    expect(s.plate(2)!.sprite.visible).toBe(false);
    expect(s.plate(3)!.opacity).toBeGreaterThan(0.9);
    expect(s.plate(3)!.sprite.visible).toBe(true);
    s.mgr.dispose();
    s.fx.dispose();
  });

  it('the plate comes back within ~0.3 s once the hero is in sight (60 and 20 fps)', () => {
    for (const fps of [60, 20]) {
      const s = setup();
      const me = unit(1, 'hero', 'zhangfei', 0, 27);
      const other = unit(2, 'hero', 'liubei', 0, -30);
      const ents = [me, other];
      s.step(ents, 20, 1 / fps);
      expect(s.plate(2)!.opacity).toBe(0);
      // walks over to this side of the ridge
      other.z = 14;
      let t = 0;
      while (t < 1 && !(s.plate(2)!.opacity > 0.8)) {
        s.step(ents, 1, 1 / fps);
        t += 1 / fps;
      }
      expect(t, `${fps} fps`).toBeLessThanOrEqual(0.3 + 1e-6);
      s.mgr.dispose();
      s.fx.dispose();
    }
  });

  it('troop pennants behind the hill are hidden, your own squad keeps its chevron', () => {
    const s = setup();
    const me = unit(1, 'hero', 'zhangfei', 0, 27);
    const enemyTroop = unit(10, 'troop', 'shu_rifleman', 2, -20);
    const ownTroop = unit(11, 'troop', 'shu_rifleman', -2, -20);
    const nearTroop = unit(12, 'troop', 'shu_rifleman', 3, 20);
    s.step([me, enemyTroop, ownTroop, nearTroop], 20);
    // own squad (behind the hill) + the troop on this side: one pennant quad each (full HP: no bar)
    expect(s.mgr.badges.count).toBe(2);
    s.step([me, enemyTroop, nearTroop], 20);
    expect(s.mgr.badges.count).toBe(1);
    s.mgr.dispose();
    s.fx.dispose();
  });

  it('is staggered: ~1/8 of the characters test per frame', () => {
    const s = setup();
    const ents: ViewEntity[] = [unit(1, 'hero', 'zhangfei', 0, 27)];
    for (let i = 0; i < 40; i++) ents.push(unit(100 + i, 'troop', 'shu_rifleman', (i % 10) * 3 - 15, -20 - Math.floor(i / 10) * 3));
    s.step(ents, 1); // first sight: everyone tests once
    const before = s.segs();
    s.step(ents, 80);
    const perFrame = (s.segs() - before) / 80;
    expect(perFrame).toBeGreaterThan(40 / LOS_STAGGER - 1);
    expect(perFrame).toBeLessThan(40 / LOS_STAGGER + 1);
    s.mgr.dispose();
    s.fx.dispose();
  });
});
