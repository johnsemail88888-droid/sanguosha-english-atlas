import { describe, expect, it } from 'vitest';
import type { MapData } from '../../../src/core/map';
import { SurfaceIndex } from '../../../src/audio/surfaces';

function map(): MapData {
  return {
    seed: 1,
    nameZh: '',
    nameEn: '',
    size: 100,
    res: 2,
    heights: new Float32Array(9),
    waterLevel: -5,
    props: [
      { type: 'wall', x: 10, y: 0, z: 0, rot: 0, sx: 10, sy: 4, sz: 1, variant: 0 },
      { type: 'bridge', x: -20, y: 2, z: 10, rot: 0, sx: 8, sy: 0.4, sz: 3, variant: 0 },
    ],
    colliders: [],
    lordSpawn: { x: 0, y: 0, z: 0 },
    spawns: [],
    lootSpots: [],
    crateSpots: [],
    camps: [],
    regions: [{ id: 'luoyang', nameZh: '洛阳宫城', nameEn: 'Luoyang Palace City', center: { x: 0, y: 0, z: -30 }, radius: 10 }],
  };
}

describe('SurfaceIndex', () => {
  const idx = new SurfaceIndex(map());

  it('classifies ground and prop hits', () => {
    expect(idx.impactAt({ x: 30, y: 0.1, z: 30 })).toBe('dirt');
    expect(idx.impactAt({ x: 10, y: 2, z: 0.4 })).toBe('stone');
  });

  it('returns null for a miss that ended in mid-air', () => {
    expect(idx.impactAt({ x: 30, y: 12, z: 30 })).toBeNull();
    expect(idx.impactAt({ x: 30, y: 1.5, z: 30 })).toBeNull();
    expect(idx.impactAt({ x: Number.NaN, y: 0, z: 0 })).toBeNull();
  });

  it('paved city streets are stone underfoot and under fire', () => {
    expect(idx.floorAt({ x: 2, y: 0, z: -28 })).toBe('stone');
    expect(idx.impactAt({ x: 2, y: 0.05, z: -28 })).toBe('stone');
    expect(idx.floorAt({ x: 30, y: 0, z: 30 })).toBe('dirt');
    expect(idx.floorAt({ x: -20, y: 2.4, z: 10 })).toBe('wood');
  });
});
