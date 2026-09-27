// The five-tier quality ladder (极速 / 流畅 / 均衡 / 高清 / 极致): preset ordering,
// saved-setting migration, the frame-rate cap, draw-distance culling and the
// character LOD decisions.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { QUALITIES, loadSettingsForTest, migrateQuality, type Quality } from '../../../src/game/settings';
import { HERO_VIEW_RANGE, QUALITY_PRESETS, atMost, groundVariant, presetPixelRatio, qualityPreset, qualityRank } from '../../../src/render/quality';
import { FrameLimiter } from '../../../src/render/frameCap';
import { DepthCuller } from '../../../src/render/scene/depthCull';
import { setFarPlane } from '../../../src/render/world/propModels';
import { ANIM_MIN_HZ, LOD_DIST, OFFSCREEN_STRIDE, animDue, animStride, farBody, inViewSides } from '../../../src/render/entities/lod';
import { NATURE_LOD_DIST } from '../../../src/render/world/nature';
import { skirtTile } from '../../../src/render/scene/terrain';
import { PRIM, lowBuildDetail, withBuildDetail } from '../../../src/render/core/geo';
import { buildWorld } from '../../../src/render/world/world';
import { generateMap } from '../../../src/sim/map/generate';

class MemStore {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

describe('quality ladder', () => {
  it('has five tiers, cheapest first, each with a preset', () => {
    expect(QUALITIES).toEqual(['potato', 'low', 'medium', 'high', 'ultra']);
    for (const q of QUALITIES) expect(QUALITY_PRESETS[q]).toBeDefined();
    expect(QUALITIES.map(qualityRank)).toEqual([0, 1, 2, 3, 4]);
    expect(atMost('potato', 'low')).toBe(true);
    expect(atMost('low', 'low')).toBe(true);
    expect(atMost('medium', 'low')).toBe(false);
    // an unknown id falls back to 均衡
    expect(qualityPreset('nope' as Quality)).toBe(QUALITY_PRESETS.medium);
  });

  it('every knob grows (or stays) up the ladder', () => {
    const P = QUALITIES.map((q) => QUALITY_PRESETS[q]);
    const monotone = (f: (p: (typeof P)[number]) => number): void => {
      for (let i = 1; i < P.length; i++) expect(f(P[i]), `${QUALITIES[i]}`).toBeGreaterThanOrEqual(f(P[i - 1]));
    };
    monotone((p) => p.maxPixelRatio);
    monotone((p) => p.pixelRatioScale);
    monotone((p) => p.drawDistance);
    monotone((p) => p.characterDistance);
    monotone((p) => p.particles);
    monotone((p) => p.grass);
    monotone((p) => p.msaa);
    monotone((p) => p.brazierLights + p.vfxLights);
    monotone((p) => (p.shadows ? p.shadowMapSize * p.shadowExtent : 0));
    monotone((p) => p.lodScale);
    monotone((p) => ({ basic: 0, lite: 1, full: 2 })[p.shading]);
    monotone((p) => ({ none: 0, heroes: 1, all: 2 })[p.glbCharacters]);
    monotone((p) => ({ low: 0, full: 1 })[p.worldDetail]);
  });

  it('极速 is the software-rendering tier: half resolution, procedural, 30 fps', () => {
    const p = QUALITY_PRESETS.potato;
    expect(p.maxPixelRatio).toBeLessThanOrEqual(0.5);
    expect(p.shadows).toBe(false);
    expect(p.bloom || p.post).toBe(false);
    expect(p.msaa).toBe(0);
    expect(p.grass).toBe(0);
    expect(p.glbCharacters).toBe('none');
    expect(p.worldArt).toBe(false);
    expect(p.shading).toBe('basic');
    expect(p.worldDetail).toBe('low');
    expect(p.brazierLights + p.vfxLights).toBe(0);
    expect(p.particles).toBeLessThanOrEqual(0.3);
    expect(p.maxFps).toBe(30);
    expect(p.drawDistance).toBeLessThanOrEqual(130);
    expect(p.characterDistance).toBeLessThanOrEqual(40);
    expect(groundVariant('potato')).toBe('plain');
    // heroes stay visible to weapon range on every tier (the far plane stretches to them)
    expect(HERO_VIEW_RANGE).toBeGreaterThan(p.drawDistance);
  });

  it('极速 keeps its pixel budget in big windows; the other tiers follow DPR only', () => {
    const P = QUALITY_PRESETS;
    expect(presetPixelRatio(P.potato, 1, 1280, 720)).toBe(0.5); // 640×360
    const big = presetPixelRatio(P.potato, 1, 2560, 1440);
    expect(2560 * 1440 * big * big).toBeCloseTo(P.potato.maxPixels, -2);
    expect(big).toBeLessThan(0.5);
    expect(presetPixelRatio(P.potato, 2, 1280, 720)).toBe(0.5); // the cap
    expect(presetPixelRatio(P.medium, 1, 2560, 1440)).toBe(1);
    expect(presetPixelRatio(P.medium, 2, 1280, 720)).toBe(1.5);
    expect(presetPixelRatio(P.ultra, 3, 1280, 720)).toBe(2);
    expect(presetPixelRatio(P.low, 2, 1280, 720)).toBe(1);
  });

  it('极致 is the strong-GPU tier: full DPR, 4096 shadows, MSAA 4, the longest view', () => {
    const p = QUALITY_PRESETS.ultra;
    expect(p.maxPixelRatio).toBe(2);
    expect(p.shadowMapSize).toBe(4096);
    expect(p.msaa).toBe(4);
    expect(p.drawDistance).toBeGreaterThan(QUALITY_PRESETS.high.drawDistance);
    expect(p.maxFps).toBe(0);
    expect(groundVariant('ultra')).toBe('full');
    expect(groundVariant('low')).toBe('lq');
  });
});

describe('saved quality migration', () => {
  it('keeps the five ids (any case / padding), drops anything else', () => {
    for (const q of QUALITIES) expect(migrateQuality(q)).toBe(q);
    expect(migrateQuality(' High ')).toBe('high');
    expect(migrateQuality('POTATO')).toBe('potato');
    for (const bad of ['', 'epic', 'max', 3, null, undefined, {}]) expect(migrateQuality(bad)).toBeNull();
  });

  it('a stored older tier keeps its meaning; an unknown one gets the first-run default', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { matchMedia: g.matchMedia, localStorage: g.localStorage };
    try {
      g.matchMedia = () => ({ matches: false });
      const st = new MemStore();
      g.localStorage = st;
      for (const q of ['low', 'medium', 'high', 'potato', 'ultra'] as const) {
        st.setItem('sgwl.settings.v1', JSON.stringify({ quality: q, lang: 'en' }));
        expect(loadSettingsForTest()).toMatchObject({ quality: q, lang: 'en' });
      }
      st.setItem('sgwl.settings.v1', JSON.stringify({ quality: 'insane' }));
      expect(loadSettingsForTest().quality).toBe('medium');
    } finally {
      g.matchMedia = saved.matchMedia;
      g.localStorage = saved.localStorage;
    }
  });
});

describe('frame-rate cap', () => {
  const run = (fps: number, hz: number, seconds: number): number => {
    const l = new FrameLimiter(fps);
    let n = 0;
    for (let t = 0; t < seconds * 1000; t += 1000 / hz) if (l.due(t)) n++;
    return n;
  };

  it('renders every other frame of a 60 Hz display at 30 fps, ~30 of a 144 Hz one', () => {
    expect(run(30, 60, 10)).toBeGreaterThanOrEqual(299);
    expect(run(30, 60, 10)).toBeLessThanOrEqual(301);
    const n144 = run(30, 144, 10);
    expect(n144).toBeGreaterThanOrEqual(285);
    expect(n144).toBeLessThanOrEqual(305);
  });

  it('0 = uncapped; a slow machine is not held back further', () => {
    expect(run(0, 60, 2)).toBe(120);
    // 20 fps machine under a 30 fps cap: every frame renders
    expect(run(30, 20, 5)).toBe(100);
  });

  it('a late frame re-anchors the schedule (no burst to catch up); reset renders at once', () => {
    const l = new FrameLimiter(30);
    expect(l.due(0)).toBe(true);
    expect(l.due(16.7)).toBe(false);
    expect(l.due(500)).toBe(true); // after a hitch
    expect(l.due(516.7)).toBe(false);
    expect(l.due(533.4)).toBe(true);
    l.reset();
    expect(l.due(540)).toBe(true);
  });
});

describe('draw-distance culling', () => {
  const cam = (): THREE.PerspectiveCamera => {
    const c = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
    c.position.set(0, 2, 0);
    c.lookAt(0, 2, -10); // forward = −z
    c.updateMatrixWorld();
    return c;
  };
  const box = (x: number, z: number, r = 1): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 4, 2));
    m.position.set(x, 0, z);
    m.updateMatrixWorld();
    return m;
  };

  it('hides static meshes wholly deeper than the draw distance along the view, by view depth', () => {
    const d = new DepthCuller();
    const near = box(0, -50);
    const far = box(0, -200);
    const side = box(150, -60, 5); // radially 162 m away but only 60 m deep: kept
    const behind = box(0, 300);
    for (const m of [near, far, side, behind]) d.add(m);
    expect(d.size).toBe(4);
    d.update(cam(), 125);
    expect([near.visible, far.visible, side.visible, behind.visible]).toEqual([true, false, true, true]);
    d.update(cam(), Infinity);
    expect(far.visible).toBe(true);
    d.clear();
    expect(d.size).toBe(0);
  });

  it('a mesh straddling the draw distance stays', () => {
    const d = new DepthCuller();
    const m = box(0, -130, 10);
    d.add(m);
    d.update(cam(), 125);
    expect(m.visible).toBe(true);
  });

  it('setFarPlane puts the far plane `dist` ahead of the camera', () => {
    const c = cam();
    const pl = setFarPlane(new THREE.Plane(), c.matrixWorld.elements, 100);
    // inside: distanceToPoint ≥ 0
    expect(pl.distanceToPoint(new THREE.Vector3(0, 2, -99))).toBeGreaterThan(0);
    expect(pl.distanceToPoint(new THREE.Vector3(0, 2, -101))).toBeLessThan(0);
    expect(pl.distanceToPoint(new THREE.Vector3(0, 2, 50))).toBeGreaterThan(0);
  });

  it('the terrain skirt splits into 16-sector bands near the map and 8 sectors beyond 700 m', () => {
    const half = 160;
    const seen = new Set<number>();
    for (let a = 0; a < Math.PI * 2; a += 0.02) for (const r of [200, 400, 700, 1300]) seen.add(skirtTile(Math.cos(a) * r, Math.sin(a) * r, half));
    expect([...seen].sort((x, y) => x - y)).toEqual(Array.from({ length: 56 }, (_, i) => i));
    expect(skirtTile(170, 0, half)).toBeLessThan(16);
    expect(skirtTile(170 + 150, 0, half)).toBeGreaterThanOrEqual(16);
    expect(skirtTile(170 + 150, 0, half)).toBeLessThan(32);
    expect(skirtTile(170 + 400, 0, half)).toBeGreaterThanOrEqual(32);
    expect(skirtTile(170 + 900, 0, half)).toBeGreaterThanOrEqual(48);
  });
});

describe('character LOD', () => {
  it('GLB heroes switch to the decimated body beyond ~35 m (scaled per tier, with hysteresis)', () => {
    expect(LOD_DIST.heroBody).toBe(35);
    expect(farBody(true, 30, 1, false)).toBe(false);
    expect(farBody(true, 40, 1, false)).toBe(true);
    // hysteresis band keeps the previous choice
    expect(farBody(true, 35.5, 1, false)).toBe(false);
    expect(farBody(true, 35.5, 1, true)).toBe(true);
    // 极致 (lodScale 1.6) keeps the full body further out; 极速 (0.7) drops it sooner
    expect(farBody(true, 50, QUALITY_PRESETS.ultra.lodScale, false)).toBe(false);
    expect(farBody(true, 28, QUALITY_PRESETS.potato.lodScale, false)).toBe(true);
    // troops switch sooner than heroes
    expect(farBody(false, 30, 1, false)).toBe(true);
    expect(farBody(true, 30, 1, false)).toBe(false);
  });

  it('far characters animate every 2nd / 3rd / 4th frame; off-screen ones at most every 4th', () => {
    const dt = 1 / 60;
    expect(animStride(true, 20, 1, true, dt)).toBe(1);
    expect(animStride(true, 50, 1, true, dt)).toBe(2);
    expect(animStride(true, 120, 1, true, dt)).toBe(3);
    expect(animStride(true, 300, 1, true, dt)).toBe(4);
    expect(animStride(false, 30, 1, true, dt)).toBe(2);
    expect(animStride(false, 60, 1, true, dt)).toBe(3);
    expect(animStride(true, 5, 1, false, dt)).toBe(OFFSCREEN_STRIDE);
    expect(animStride(true, 300, 1, false, dt)).toBe(OFFSCREEN_STRIDE);
    // a higher tier keeps full-rate animation further out
    expect(animStride(true, 50, QUALITY_PRESETS.ultra.lodScale, true, dt)).toBe(1);
  });

  it('nothing on screen updates less than ANIM_MIN_HZ times a second, whatever the frame rate', () => {
    for (const fps of [8, 15, 30, 60, 144]) {
      const s = animStride(true, 300, 1, true, 1 / fps);
      // (below ANIM_MIN_HZ frames a second: every frame)
      expect(fps / s, `${fps} fps`).toBeGreaterThanOrEqual(Math.min(fps, ANIM_MIN_HZ) - 1e-9);
    }
    // at 8 fps every visible character animates every frame
    expect(animStride(false, 200, 1, true, 1 / 8)).toBe(1);
  });

  it('staggers the work: each stride frame animates about 1/stride of the characters', () => {
    for (const stride of [1, 2, 3, 4]) {
      let due = 0;
      for (let id = 0; id < 120; id++) if (animDue(stride, 7, id)) due++;
      expect(due).toBe(120 / stride);
      // and every character gets its turn within `stride` frames
      for (let id = 0; id < 10; id++) {
        let turns = 0;
        for (let f = 0; f < stride; f++) if (animDue(stride, f, id)) turns++;
        expect(turns).toBe(1);
      }
    }
  });

  it('inViewSides ignores the far plane (the renderer stretches it to far heroes later)', () => {
    const c = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 50);
    c.lookAt(0, 0, -1);
    c.updateMatrixWorld();
    const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse));
    expect(inViewSides(f, 0, 0, -300, 1)).toBe(true); // beyond far, straight ahead
    expect(inViewSides(f, 300, 0, -10, 1)).toBe(false); // far to the right
    expect(inViewSides(f, 0, 0, 30, 1)).toBe(false); // behind
  });

  it('vegetation LOD distance is shorter than every draw distance', () => {
    for (const q of QUALITIES) expect(NATURE_LOD_DIST * QUALITY_PRESETS[q].lodScale).toBeLessThan(QUALITY_PRESETS[q].drawDistance);
  });
});

describe('极速 world build detail', () => {
  it('the low-detail props keep the layout with far fewer triangles; nothing else is affected', () => {
    const map = generateMap(20260924);
    const full = buildWorld(map, { art: false });
    const low = buildWorld(map, { art: false, detail: 'low' });
    expect(low.stats.props).toBe(full.stats.props);
    expect(low.stats.failed).toBe(0);
    expect(low.stats.triangles).toBeLessThan(full.stats.triangles * 0.7);
    expect(low.stats.triangles).toBeGreaterThan(full.stats.triangles * 0.3);
    // the same camera occluders (roof shells) either way
    expect(low.cameraOccluders.length).toBe(full.cameraOccluders.length);
    full.dispose();
    low.dispose();
    // the flag is scoped: round primitives outside the build are full detail
    expect(lowBuildDetail()).toBe(false);
    const n = (g: { getAttribute(n: string): { count: number } }): number => g.getAttribute('position').count;
    const cylLow = withBuildDetail(true, () => n(PRIM.cyl(8)));
    expect(n(PRIM.cyl(8))).toBeGreaterThan(cylLow);
    expect(withBuildDetail(true, () => lowBuildDetail())).toBe(true);
    expect(lowBuildDetail()).toBe(false);
  });
});
