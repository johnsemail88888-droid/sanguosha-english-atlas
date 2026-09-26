// Material lookup for bullet impacts and footsteps, derived from map props.
// A coarse spatial hash over MapData.props is built once per map (cached).
import { terrainHeight } from '../core/map';
import type { MapData, MapProp, PropType } from '../core/map';
import type { Vec3 } from '../core/math';

export type Surface = 'dirt' | 'stone' | 'wood' | 'metal' | 'water' | 'soft';

export const SURFACES: readonly Surface[] = ['dirt', 'stone', 'wood', 'metal', 'water', 'soft'];

const PROP_SURFACE: Record<PropType, Surface> = {
  wall: 'stone',
  gateTower: 'stone',
  palace: 'wood',
  house: 'stone',
  pavilion: 'wood',
  watchtower: 'wood',
  tent: 'soft',
  barricade: 'wood',
  crateStack: 'wood',
  rock: 'stone',
  tree: 'wood',
  pine: 'wood',
  bamboo: 'wood',
  bridge: 'wood',
  dock: 'wood',
  ship: 'wood',
  statue: 'stone',
  banner: 'soft',
  brazier: 'metal',
  ruin: 'stone',
  farmField: 'dirt',
  stairs: 'stone',
};

/** props you can stand on (their surface counts for footsteps) */
const WALKABLE = new Set<PropType>(['bridge', 'dock', 'ship', 'pavilion', 'watchtower', 'stairs', 'wall', 'gateTower', 'palace']);

const CELL = 8;
const MARGIN = 0.6;
/** a hit point this close to the terrain counts as hitting the ground (m) */
const GROUND_BAND = 0.6;
/** regions with paved streets / courtyards (footsteps on stone) */
const PAVED_REGION = /luoyang|palace|city/i;

export class SurfaceIndex {
  private cells = new Map<number, MapProp[]>();
  private readonly half: number;
  private readonly paved: { x: number; z: number; r2: number }[] = [];

  constructor(private readonly map: MapData) {
    this.half = (Number.isFinite(map.size) ? map.size : 320) / 2;
    for (const r of Array.isArray(map.regions) ? map.regions : []) {
      if (!r?.center || !(r.radius > 0) || !PAVED_REGION.test(`${r.id} ${r.nameEn}`)) continue;
      this.paved.push({ x: r.center.x, z: r.center.z, r2: r.radius * r.radius });
    }
    const props = Array.isArray(map.props) ? map.props : [];
    for (const p of props) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const r = Math.hypot(p.sx || 1, p.sz || 1) / 2 + MARGIN;
      const x0 = this.cellCoord(p.x - r);
      const x1 = this.cellCoord(p.x + r);
      const z0 = this.cellCoord(p.z - r);
      const z1 = this.cellCoord(p.z + r);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = this.key(cx, cz);
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(p);
        }
      }
    }
  }

  private cellCoord(v: number): number {
    return Math.floor((v + this.half) / CELL);
  }

  private key(cx: number, cz: number): number {
    return cx * 4096 + cz;
  }

  ground(x: number, z: number): number {
    try {
      const h = terrainHeight(this.map, x, z);
      return Number.isFinite(h) ? h : 0;
    } catch {
      return 0;
    }
  }

  private inside(p: MapProp, pt: Vec3, yPad: number): boolean {
    const dx = pt.x - p.x;
    const dz = pt.z - p.z;
    const c = Math.cos(p.rot || 0);
    const s = Math.sin(p.rot || 0);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    if (Math.abs(lx) > (p.sx || 1) / 2 + MARGIN || Math.abs(lz) > (p.sz || 1) / 2 + MARGIN) return false;
    const y0 = (p.y || 0) - 0.5;
    const y1 = (p.y || 0) + Math.max(0.5, p.sy || 1) + yPad;
    return pt.y >= y0 && pt.y <= y1;
  }

  private propAt(pt: Vec3, filter: (p: MapProp) => boolean, yPad: number): MapProp | null {
    const list = this.cells.get(this.key(this.cellCoord(pt.x), this.cellCoord(pt.z)));
    if (!list) return null;
    let best: MapProp | null = null;
    let bestD = Infinity;
    for (const p of list) {
      if (!filter(p) || !this.inside(p, pt, yPad)) continue;
      const d = (pt.x - p.x) ** 2 + (pt.z - p.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private isWater(pt: Vec3): boolean {
    const wl = this.map.waterLevel;
    if (!Number.isFinite(wl)) return false;
    return pt.y <= wl + 0.15 && this.ground(pt.x, pt.z) < wl;
  }

  private isPaved(pt: Vec3): boolean {
    for (const r of this.paved) if ((pt.x - r.x) ** 2 + (pt.z - r.z) ** 2 <= r.r2) return true;
    return false;
  }

  /**
   * Material at a bullet impact point, or null when the point is neither on
   * the terrain nor inside a prop (a miss that ended in mid-air).
   */
  impactAt(pt: Vec3): Surface | null {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y) || !Number.isFinite(pt.z)) return null;
    if (this.isWater(pt)) return 'water';
    const prop = this.propAt(pt, () => true, 1);
    if (prop) return PROP_SURFACE[prop.type] ?? 'stone';
    if (Math.abs(pt.y - this.ground(pt.x, pt.z)) < GROUND_BAND) return this.isPaved(pt) ? 'stone' : 'dirt';
    return null;
  }

  /** Material under a standing unit (feet at pt.y). */
  floorAt(pt: Vec3): Surface {
    if (this.isWater(pt)) return 'water';
    const g = this.ground(pt.x, pt.z);
    if (pt.y - g > 0.25) {
      const prop = this.propAt(pt, (p) => WALKABLE.has(p.type), 0.6);
      if (prop) return PROP_SURFACE[prop.type] ?? 'wood';
    }
    return this.isPaved(pt) ? 'stone' : 'dirt';
  }
}

const cache = new WeakMap<MapData, SurfaceIndex>();

export function surfaceIndexFor(map: MapData | null | undefined): SurfaceIndex | null {
  if (!map || typeof map !== 'object') return null;
  let idx = cache.get(map);
  if (!idx) {
    try {
      idx = new SurfaceIndex(map);
    } catch {
      return null;
    }
    cache.set(map, idx);
  }
  return idx;
}
