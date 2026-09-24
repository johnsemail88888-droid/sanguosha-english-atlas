// STUB (orchestrator) — MAP replaces this with the real 虎牢·赤壁 generator.
import type { MapData } from '../../core/map';

export function generateMap(seed: number): MapData {
  const res = 64;
  const size = 320;
  return {
    seed,
    nameZh: '测试平原',
    nameEn: 'Test Plain',
    size,
    res,
    heights: new Float32Array((res + 1) * (res + 1)),
    waterLevel: -5,
    props: [],
    colliders: [],
    lordSpawn: { x: 0, y: 0, z: 0 },
    spawns: Array.from({ length: 8 }, (_, i) => ({
      x: Math.cos((i / 8) * Math.PI * 2) * 110,
      y: 0,
      z: Math.sin((i / 8) * Math.PI * 2) * 110,
    })),
    lootSpots: [],
    crateSpots: [],
    camps: [],
    regions: [],
  };
}
