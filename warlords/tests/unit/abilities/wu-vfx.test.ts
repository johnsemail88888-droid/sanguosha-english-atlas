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
  it('火烧赤壁 lays one terrain-hugging warning decal and cleans it up after the strike', async () => {
    registerWuAbilityVfx();
    const fx = new Effects(new THREE.Scene(), 2);
    // bumpy heightfield on the 2 m map grid, sampled bilinearly like core/map terrainHeight
    const node = (i: number, k: number): number => 0.9 * Math.sin(i * 1.7 + k * 0.3) * Math.cos(k * 2.3 - i * 0.4);
    fx.groundY = (x, z) => {
      const fx0 = (x + 160) / 2;
      const fz0 = (z + 160) / 2;
      const i = Math.floor(fx0);
      const k = Math.floor(fz0);
      const tx = fx0 - i;
      const tz = fz0 - k;
      return (node(i, k) * (1 - tx) + node(i + 1, k) * tx) * (1 - tz) + (node(i, k + 1) * (1 - tx) + node(i + 1, k + 1) * tx) * tz;
    };
    // the renderer splits each 2 m cell along one diagonal: the decal must be above both choices
    const triHeight = (x: number, z: number, flip: boolean): number => {
      const i = Math.floor((x + 160) / 2);
      const k = Math.floor((z + 160) / 2);
      const tx = (x + 160) / 2 - i;
      const tz = (z + 160) / 2 - k;
      const [h00, h10, h01, h11] = [node(i, k), node(i + 1, k), node(i, k + 1), node(i + 1, k + 1)];
      if (!flip) return tx >= tz ? h00 + (h10 - h00) * tx + (h11 - h10) * tz : h00 + (h01 - h00) * tz + (h11 - h01) * tx;
      return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
    };
    const ctx: AbilityVfxContext = {
      fx,
      src: undefined,
      srcPos: new THREE.Vector3(3.3, 1, -7.1),
      targetPos: null,
      point: null,
      dir: new THREE.Vector3(0.6, 0, -0.8),
      color: new THREE.Color(0.5, 2, 1),
      localId: null,
    };
    const decals = (): THREE.Mesh[] => fx.group.children.filter((o): o is THREE.Mesh => o.name === 'vfx_chibi_warning');
    getAbilityVfx('zhouyu_chibi')!(ctx, { t: 'ability', src: 1, ability: 'zhouyu_chibi' });
    expect(decals()).toHaveLength(1);
    const mesh = decals()[0];
    const pos = mesh.geometry.getAttribute('position');
    expect(pos.count).toBeGreaterThan(100);
    // on or above the triangulated ground at every vertex and every triangle centroid, whichever
    // diagonal the terrain mesh used (never buried)
    for (let i = 0; i < pos.count; i++) {
      for (const flip of [false, true]) expect(pos.getY(i)).toBeGreaterThanOrEqual(triHeight(pos.getX(i), pos.getZ(i), flip) - 1e-9);
    }
    const index = mesh.geometry.getIndex()!;
    for (let t = 0; t < index.count; t += 3) {
      const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
      const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
      const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
      for (const flip of [false, true]) expect(y).toBeGreaterThanOrEqual(triHeight(x, z, flip) - 1e-9);
    }
    // it covers the whole 25 m line (local "along" coordinate)
    const loc = mesh.geometry.getAttribute('aLocal');
    let maxAlong = -Infinity;
    for (let i = 0; i < loc.count; i++) maxAlong = Math.max(maxAlong, loc.getX(i));
    expect(maxAlong).toBeGreaterThanOrEqual(25 + 3.5);
    // after the bombs land (+ fade) the next rendered frame retires it
    fx.update(1);
    mesh.onBeforeRender(null as never, null as never, null as never, null as never, null as never, null as never);
    expect(mesh.visible).toBe(true);
    fx.update(1);
    mesh.onBeforeRender(null as never, null as never, null as never, null as never, null as never, null as never);
    expect(mesh.visible).toBe(false);
    await Promise.resolve();
    expect(decals()).toHaveLength(0);
    fx.dispose();
  });
});
