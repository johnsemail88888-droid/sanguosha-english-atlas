// Walkability nav grid + A* for AI pathfinding (GAME_SPEC §9).
//
// Grid: cellSize (default 2 m) cells over the whole map. Cell (col, row) has
// its centre at x = -size/2 + (col + 0.5) * cellSize (same for z/row), i.e. at
// odd integer coordinates for 2 m cells — the generator aligns narrow walkways
// (wall tops, stairs, bridges, gangplanks) with those lines.
//
// Layers: a cell can hold up to NAV_LAYERS stacked walkable surfaces ("nodes"),
// e.g. the road through a gate passage AND the wall-top walkway on the gate's
// lintel above it. Each node stores its own feet height. Surfaces are the
// terrain and the tops of box colliders (decks, bridges, stairs steps, wall tops,
// tower platforms). A node is valid if an agent (radius NAV_AGENT_RADIUS,
// height NAV_AGENT_HEIGHT) fits there without touching colliders above
// feet + NAV_MAX_STEP, and terrain nodes are not steeper than NAV_MAX_SLOPE.
//
// Links: node -> neighbour cell (8-connected) is traversable if an agent can
// walk the straight segment between the two cell centres in 0.4 m samples:
// each sample follows the highest surface no higher than current + MAX_STEP,
// rises <= NAV_MAX_STEP (box steps) / slope <= walk slope (terrain), drops
// <= NAV_MAX_DROP, and has clearance. The segment's end height selects which
// layer of the neighbour it arrives at. Links are directed (dropping off a
// crate is fine, climbing it is not).
//
// Water (terrain below map.waterLevel) is walkable but costs NAV_WATER_COST×.
import type { MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import type { Vec3 } from '../../core/math';
import { COLLIDER_BOX, COLLIDER_CYL, ColliderIndex, CONTAIN_EPS } from './colliders';

export const NAV_AGENT_RADIUS = 0.45;
export const NAV_AGENT_HEIGHT = 1.7;
/** Max climb per step (box/stair step). Physics must allow stepping up this much. */
export const NAV_MAX_STEP = 0.45;
/** Max voluntary drop (e.g. hopping off a crate). */
export const NAV_MAX_DROP = 1.2;
/** tan(max slope) for a terrain node (40°). */
export const NAV_MAX_SLOPE = 0.84;
/** tan(max slope) between walk samples on terrain (42°). */
const WALK_SLOPE = 0.9;
const SAMPLE = 0.4;
export const NAV_LAYERS = 3;
/** Box tops higher than this above the terrain are never walkable (e.g. invisible boundary walls). */
export const NAV_MAX_DECK = 20;
export const NAV_WATER_COST = 4;

export const NAV_WATER = 1;
/** node is in the lord spawn's strongly-connected component (reachable and can return) */
export const NAV_MAIN = 2;

const DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
const DZ = [0, 1, 1, 1, 0, -1, -1, -1] as const;

interface SearchScratch {
  g: Float32Array;
  f: Float32Array;
  parent: Int32Array;
  seen: Uint32Array; // generation stamp: g/parent valid
  closed: Uint32Array;
  heap: Int32Array;
  heapPos: Int32Array;
  gen: number;
}

export interface NavGrid {
  readonly map: MapData;
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  /** world x/z of the grid's min corner */
  readonly origin: number;
  readonly layers: number;
  /** feet height per node; NaN = empty slot. node = (row * cols + col) * layers + layer */
  readonly height: Float32Array;
  /** NAV_WATER | NAV_MAIN */
  readonly flags: Uint8Array;
  /** 2 bits per direction (dir d at bits 2d..2d+1): 0 = no link, k = neighbour layer k-1 */
  readonly links: Uint16Array;
  /** static collider index (shared helper for AI/validation queries) */
  readonly colliders: ColliderIndex;
  /** A* scratch buffers (internal) */
  readonly scratch: SearchScratch;
}

const cache = new WeakMap<MapData, Map<number, NavGrid>>();

/** Build (or fetch the cached) nav grid for a map. MapData is treated as immutable. */
export function buildNavGrid(map: MapData, cellSize = 2): NavGrid {
  let perMap = cache.get(map);
  const hit = perMap?.get(cellSize);
  if (hit) return hit;
  const nav = buildNavGridUncached(map, cellSize, ColliderIndex.fromMap(map));
  if (!perMap) {
    perMap = new Map();
    cache.set(map, perMap);
  }
  perMap.set(cellSize, nav);
  return nav;
}

/** Store a nav grid built elsewhere (the generator builds one to validate spots) in the cache. */
export function primeNavCache(map: MapData, nav: NavGrid): void {
  let perMap = cache.get(map);
  if (!perMap) {
    perMap = new Map();
    cache.set(map, perMap);
  }
  perMap.set(nav.cellSize, nav);
}

/** Builds a nav grid with a caller-supplied collider index (generator internals). */
export function buildNavGridUncached(map: MapData, cellSize: number, index: ColliderIndex): NavGrid {
  const cols = Math.ceil(map.size / cellSize);
  const rows = cols;
  const L = NAV_LAYERS;
  const origin = -map.size / 2;
  const nNodes = cols * rows * L;
  const height = new Float32Array(nNodes).fill(NaN);
  const flags = new Uint8Array(nNodes);
  const links = new Uint16Array(nNodes);
  const tops: number[] = [];
  const cand: number[] = [];

  // 1) nodes
  for (let row = 0; row < rows; row++) {
    const z = origin + (row + 0.5) * cellSize;
    for (let col = 0; col < cols; col++) {
      const x = origin + (col + 0.5) * cellSize;
      const ground = terrainHeight(map, x, z);
      index.topsAt(x, z, ground, tops);
      cand.length = 0;
      for (const t of tops) if (t - ground <= NAV_MAX_DECK && standable(index, x, z, t)) cand.push(t);
      cand.sort((a, b) => b - a);
      const groundOk = standable(index, x, z, ground) && terrainSlope(map, x, z) <= NAV_MAX_SLOPE;
      const base = (row * cols + col) * L;
      let k = 0;
      const maxBoxes = groundOk ? L - 1 : L;
      for (let i = 0; i < cand.length && k < maxBoxes; i++) {
        if (k > 0 && height[base + k - 1] - cand[i] < 0.05) continue; // duplicate level
        height[base + k++] = cand[i];
      }
      if (groundOk) {
        height[base + k] = ground;
        if (ground < map.waterLevel - 0.05) flags[base + k] |= NAV_WATER;
        k++;
      }
    }
  }

  // 2) links
  const nav: NavGrid = {
    map,
    cellSize,
    cols,
    rows,
    origin,
    layers: L,
    height,
    flags,
    links,
    colliders: index,
    scratch: {
      g: new Float32Array(nNodes),
      f: new Float32Array(nNodes),
      parent: new Int32Array(nNodes),
      seen: new Uint32Array(nNodes),
      closed: new Uint32Array(nNodes),
      heap: new Int32Array(nNodes),
      heapPos: new Int32Array(nNodes),
      gen: 0,
    },
  };
  const walker = new Walker(nav);
  const near = colliderMask(index, cols, rows, origin, cellSize);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col;
      const base = cell * L;
      if (Number.isNaN(height[base])) continue;
      const x = origin + (col + 0.5) * cellSize;
      const z = origin + (row + 0.5) * cellSize;
      for (let l = 0; l < L; l++) {
        const h = height[base + l];
        if (Number.isNaN(h)) break;
        let bits = 0;
        for (let d = 0; d < 8; d++) {
          const nc = col + DX[d];
          const nr = row + DZ[d];
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const ncell = nr * cols + nc;
          const nb = ncell * L;
          if (Number.isNaN(height[nb])) continue;
          const bx = x + DX[d] * cellSize;
          const bz = z + DZ[d] * cellSize;
          if (near[cell] === 0 && near[ncell] === 0) {
            // terrain only on both sides (single terrain node each): symmetric,
            // so evaluate each pair once (d < 4) and set both directions
            if (d >= 4) continue;
            if (!Number.isNaN(terrainOnlyWalk(map, x, z, h, bx, bz, d & 1 ? 4 : 2))) {
              bits |= 1 << (2 * d);
              links[nb] |= 1 << (2 * ((d + 4) & 7));
            }
            continue;
          }
          const hEnd = walker.linkWalk(x, z, h, bx, bz, d & 1 ? 4 : 2);
          if (Number.isNaN(hEnd)) continue;
          for (let m = 0; m < L; m++) {
            const hm = height[nb + m];
            if (Number.isNaN(hm)) break;
            if (Math.abs(hm - hEnd) < 0.3) {
              bits |= (m + 1) << (2 * d);
              break;
            }
          }
        }
        links[base + l] |= bits;
      }
    }
  }

  // 3) main component (strongly connected with the lord spawn)
  markMain(nav);
  return nav;
}

/**
 * An agent can stand with its feet at height h at (x, z): the point itself is not
 * buried in another collider (e.g. a lower stair step under the next one) and the
 * agent's body above step height is free.
 */
function standable(index: ColliderIndex, x: number, z: number, h: number): boolean {
  return (
    !index.blocked(x, z, h + 0.02, h + NAV_AGENT_HEIGHT, 0.001) &&
    !index.blocked(x, z, h + NAV_MAX_STEP, h + NAV_AGENT_HEIGHT, NAV_AGENT_RADIUS)
  );
}

/**
 * 1 for nav cells touched by any collider's footprint AABB inflated by the
 * index pad (>= agent radius): links between two untouched cells can only
 * interact with terrain, so they take the cheap terrain-only test.
 */
function colliderMask(index: ColliderIndex, cols: number, rows: number, origin: number, cs: number): Uint8Array {
  const mask = new Uint8Array(cols * rows);
  const pad = index.pad;
  for (let i = 0; i < index.count; i++) {
    let ex: number;
    let ez: number;
    if (index.kind[i] === COLLIDER_CYL) {
      ex = ez = index.hx[i];
    } else {
      const c = index.cs[i];
      const sn = index.sn[i];
      ex = Math.abs(index.hx[i] * c) + Math.abs(index.hz[i] * sn);
      ez = Math.abs(index.hx[i] * sn) + Math.abs(index.hz[i] * c);
    }
    const c0 = Math.max(0, Math.floor((index.cx[i] - ex - pad - origin) / cs));
    const c1 = Math.min(cols - 1, Math.floor((index.cx[i] + ex + pad - origin) / cs));
    const r0 = Math.max(0, Math.floor((index.cz[i] - ez - pad - origin) / cs));
    const r1 = Math.min(rows - 1, Math.floor((index.cz[i] + ez + pad - origin) / cs));
    // exact-ish: cell centre within (pad + half cell diagonal) of the footprint
    const reach = pad + cs * 0.7072;
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        if (mask[r * cols + c]) continue;
        if (index.footprintDist(i, origin + (c + 0.5) * cs, origin + (r + 0.5) * cs) < reach) mask[r * cols + c] = 1;
      }
  }
  return mask;
}

/**
 * Link test where no collider is near: the terrain is bilinear between the
 * 2 m heightfield vertices, so a few samples capture the profile exactly
 * enough (orthogonal: the break at the vertex line midway; diagonal: quarters).
 */
function terrainOnlyWalk(map: MapData, ax: number, az: number, h0: number, bx: number, bz: number, n: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const seg = Math.sqrt(dx * dx + dz * dz) / n;
  const lim = seg * WALK_SLOPE;
  let h = h0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const s = terrainHeight(map, ax + dx * t, az + dz * t);
    if (s - h > lim || h - s > lim) return NaN;
    h = s;
  }
  return h;
}

function terrainSlope(map: MapData, x: number, z: number): number {
  const gx = (terrainHeight(map, x + 1, z) - terrainHeight(map, x - 1, z)) / 2;
  const gz = (terrainHeight(map, x, z + 1) - terrainHeight(map, x, z - 1)) / 2;
  return Math.sqrt(gx * gx + gz * gz);
}

/** Segment walker shared by link building, smoothing and validation. */
class Walker {
  private readonly isBox = new Uint8Array(1);
  touchedWater = false;

  constructor(private readonly nav: NavGrid) {}

  /** Walk from (ax, az) at feet height h0 to (bx, bz). Returns end feet height or NaN. */
  walk(ax: number, az: number, h0: number, bx: number, bz: number): number {
    const { map, colliders } = this.nav;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    const n = Math.max(1, Math.ceil(len / SAMPLE));
    const seg = len / n;
    let h = h0;
    let onTerrain = Math.abs(terrainHeight(map, ax, az) - h0) < 0.05;
    this.touchedWater = false;
    const wl = map.waterLevel - 0.05;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = ax + dx * t;
      const z = az + dz * t;
      const g = terrainHeight(map, x, z);
      const s = colliders.surfaceBelow(x, z, h + NAV_MAX_STEP, g, this.isBox);
      if (s === -Infinity) return NaN;
      const rise = s - h;
      const terrainNow = this.isBox[0] === 0;
      if (terrainNow && onTerrain) {
        if (rise > seg * WALK_SLOPE || rise < -seg * WALK_SLOPE) return NaN;
      } else if (rise > NAV_MAX_STEP || rise < -NAV_MAX_DROP) return NaN;
      if (colliders.blocked(x, z, s + NAV_MAX_STEP, s + NAV_AGENT_HEIGHT, NAV_AGENT_RADIUS)) return NaN;
      if (terrainNow && s < wl) this.touchedWater = true;
      h = s;
      onTerrain = terrainNow;
    }
    return h;
  }

  private readonly list = new Int32Array(128);

  /**
   * Exact link test between adjacent cell centres. Colliders within the agent
   * radius of the segment are gathered once; if none are boxes (only trunks,
   * rocks, poles) the terrain profile is tested with `nTerrain` samples and any
   * vertically-overlapping cylinder blocks the link.
   */
  linkWalk(ax: number, az: number, h0: number, bx: number, bz: number, nTerrain: number): number {
    const idx = this.nav.colliders;
    const list = this.list;
    const n = idx.gatherSegment(ax, az, bx, bz, NAV_AGENT_RADIUS, list);
    if (n >= list.length) return this.walk(ax, az, h0, bx, bz);
    let boxes = false;
    for (let k = 0; k < n; k++)
      if (idx.kind[list[k]] === COLLIDER_BOX) {
        boxes = true;
        break;
      }
    if (boxes) return this.walkList(ax, az, h0, bx, bz, n);
    const { map } = this.nav;
    const dx = bx - ax;
    const dz = bz - az;
    const seg = Math.sqrt(dx * dx + dz * dz) / nTerrain;
    const lim = seg * WALK_SLOPE;
    let h = h0;
    let lo = h0;
    let hi = h0;
    for (let i = 1; i <= nTerrain; i++) {
      const t = i / nTerrain;
      const s = terrainHeight(map, ax + dx * t, az + dz * t);
      if (s - h > lim || h - s > lim) return NaN;
      h = s;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    for (let k = 0; k < n; k++) {
      const c = list[k];
      if (idx.y1[c] > lo + NAV_MAX_STEP && idx.y0[c] < hi + NAV_AGENT_HEIGHT) return NaN;
    }
    return h;
  }

  /** Sampled walk against the pre-gathered collider list (short segments). */
  private walkList(ax: number, az: number, h0: number, bx: number, bz: number, n: number): number {
    const { map, colliders: idx } = this.nav;
    const list = this.list;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    const ns = Math.max(1, Math.ceil(len / SAMPLE));
    const seg = len / ns;
    let h = h0;
    let onTerrain = Math.abs(terrainHeight(map, ax, az) - h0) < 0.05;
    for (let i = 1; i <= ns; i++) {
      const t = i / ns;
      const x = ax + dx * t;
      const z = az + dz * t;
      const g = terrainHeight(map, x, z);
      const maxY = h + NAV_MAX_STEP;
      let sfc = g <= maxY ? g : -Infinity;
      let isBox = false;
      for (let k = 0; k < n; k++) {
        const c = list[k];
        if (idx.kind[c] !== COLLIDER_BOX) continue;
        const top = idx.y1[c];
        if (top > maxY || top <= sfc || top <= g + 0.02) continue;
        if (idx.footprintDist(c, x, z) <= CONTAIN_EPS) {
          sfc = top;
          isBox = true;
        }
      }
      if (sfc === -Infinity) return NaN;
      const rise = sfc - h;
      if (!isBox && onTerrain) {
        if (rise > seg * WALK_SLOPE || rise < -seg * WALK_SLOPE) return NaN;
      } else if (rise > NAV_MAX_STEP || rise < -NAV_MAX_DROP) return NaN;
      const yLo = sfc + NAV_MAX_STEP;
      const yHi = sfc + NAV_AGENT_HEIGHT;
      for (let k = 0; k < n; k++) {
        const c = list[k];
        if (idx.y1[c] <= yLo || idx.y0[c] >= yHi) continue;
        if (idx.footprintDist(c, x, z) < NAV_AGENT_RADIUS) return NaN;
      }
      h = sfc;
      onTerrain = !isBox;
    }
    return h;
  }
}

const walkers = new WeakMap<NavGrid, Walker>();
function walkerOf(nav: NavGrid): Walker {
  let w = walkers.get(nav);
  if (!w) {
    w = new Walker(nav);
    walkers.set(nav, w);
  }
  return w;
}

function markMain(nav: NavGrid): void {
  const root = locateNode(nav, nav.map.lordSpawn, 3);
  if (root < 0) return;
  const N = nav.height.length;
  const fwd = new Uint8Array(N);
  const stack: number[] = [root];
  fwd[root] = 1;
  while (stack.length) {
    const a = stack.pop()!;
    const bits = nav.links[a];
    if (!bits) continue;
    for (let d = 0; d < 8; d++) {
      const m = (bits >> (2 * d)) & 3;
      if (!m) continue;
      const b = neighbourNode(nav, a, d, m - 1);
      if (!fwd[b]) {
        fwd[b] = 1;
        stack.push(b);
      }
    }
  }
  // backward reachability: predecessors of b sit in the 8 neighbouring cells
  // with a link pointing back at b's cell and layer
  const bwd = new Uint8Array(N);
  bwd[root] = 1;
  stack.push(root);
  const L = nav.layers;
  const cols = nav.cols;
  while (stack.length) {
    const b = stack.pop()!;
    const cell = Math.floor(b / L);
    const lb = b - cell * L + 1;
    const col = cell % cols;
    const row = (cell - col) / cols;
    for (let d = 0; d < 8; d++) {
      // a is at cell - D[d], linking in direction d
      const ac = col - DX[d];
      const ar = row - DZ[d];
      if (ac < 0 || ar < 0 || ac >= cols || ar >= nav.rows) continue;
      const abase = (ar * cols + ac) * L;
      for (let la = 0; la < L; la++) {
        const a = abase + la;
        if (Number.isNaN(nav.height[a])) break;
        if (!bwd[a] && ((nav.links[a] >> (2 * d)) & 3) === lb) {
          bwd[a] = 1;
          stack.push(a);
        }
      }
    }
  }
  for (let i = 0; i < N; i++) if (fwd[i] && bwd[i]) nav.flags[i] |= NAV_MAIN;
}

function neighbourNode(nav: NavGrid, node: number, d: number, layer: number): number {
  const cell = Math.floor(node / nav.layers);
  const col = cell % nav.cols;
  const row = (cell - col) / nav.cols;
  return ((row + DZ[d]) * nav.cols + (col + DX[d])) * nav.layers + layer;
}

// ── queries ─────────────────────────────────────────────────────────────────

/** Cell index containing world (x, z), or -1 outside the grid. */
export function navCellAt(nav: NavGrid, x: number, z: number): number {
  if (!(Number.isFinite(x) && Number.isFinite(z))) return -1;
  const col = Math.floor((x - nav.origin) / nav.cellSize);
  const row = Math.floor((z - nav.origin) / nav.cellSize);
  if (col < 0 || row < 0 || col >= nav.cols || row >= nav.rows) return -1;
  return row * nav.cols + col;
}

/** World position (cell centre, node feet height) of a node. */
export function navNodePos(nav: NavGrid, node: number): Vec3 {
  const cell = Math.floor(node / nav.layers);
  const col = cell % nav.cols;
  const row = (cell - col) / nav.cols;
  return {
    x: nav.origin + (col + 0.5) * nav.cellSize,
    y: nav.height[node],
    z: nav.origin + (row + 0.5) * nav.cellSize,
  };
}

/**
 * Node in p's cell whose feet height best matches p.y (within `tol` metres).
 * A NaN p.y means "any level": the lowest main-component node (else the lowest
 * node) is returned. -1 if none.
 */
export function locateNode(nav: NavGrid, p: Vec3, tol = 1.2): number {
  const cell = navCellAt(nav, p.x, p.z);
  if (cell < 0) return -1;
  const base = cell * nav.layers;
  if (Number.isNaN(p.y)) {
    let any = -1;
    for (let l = 0; l < nav.layers; l++) {
      if (Number.isNaN(nav.height[base + l])) break;
      any = base + l; // layers are stored highest first
      if (nav.flags[base + l] & NAV_MAIN) return lowestMain(nav, base);
    }
    return any;
  }
  let best = -1;
  let bestD = Infinity;
  for (let l = 0; l < nav.layers; l++) {
    const h = nav.height[base + l];
    if (Number.isNaN(h)) break;
    // prefer surfaces at or slightly below the point (feet), penalise surfaces above
    const d = h > p.y ? (h - p.y) * 1.5 : p.y - h;
    if (d < bestD && d <= tol) {
      bestD = d;
      best = base + l;
    }
  }
  return best;
}

function lowestMain(nav: NavGrid, base: number): number {
  let out = -1;
  for (let l = 0; l < nav.layers; l++) {
    if (Number.isNaN(nav.height[base + l])) break;
    if (nav.flags[base + l] & NAV_MAIN) out = base + l;
  }
  return out;
}

/** True when the nav cell under p has a walkable surface within 1.2 m of p.y (feet height). */
export function isWalkable(nav: NavGrid, p: Vec3): boolean {
  return locateNode(nav, p) >= 0;
}

/** Nearest node to p within maxDist metres (prefers the main component). */
export function nearestNode(nav: NavGrid, p: Vec3, maxDist = 16, mainOnly = true): number {
  if (!(Number.isFinite(p.x) && Number.isFinite(p.z))) return -1;
  const here = locateNode(nav, p);
  if (here >= 0 && (!mainOnly || nav.flags[here] & NAV_MAIN)) return here;
  const cs = nav.cellSize;
  const c0 = Math.floor((p.x - nav.origin) / cs);
  const r0 = Math.floor((p.z - nav.origin) / cs);
  const R = Math.ceil(maxDist / cs);
  let best = -1;
  let bestD = maxDist * maxDist;
  const py = Number.isNaN(p.y) ? 0 : p.y;
  for (let ring = 0; ring <= R; ring++) {
    // once a candidate is found, rings further out than its distance can't beat it
    if (best >= 0 && (ring - 1) * cs * ((ring - 1) * cs) > bestD) break;
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const col = c0 + dc;
        const row = r0 + dr;
        if (col < 0 || row < 0 || col >= nav.cols || row >= nav.rows) continue;
        const base = (row * nav.cols + col) * nav.layers;
        for (let l = 0; l < nav.layers; l++) {
          const h = nav.height[base + l];
          if (Number.isNaN(h)) break;
          if (mainOnly && !(nav.flags[base + l] & NAV_MAIN)) continue;
          const x = nav.origin + (col + 0.5) * cs;
          const z = nav.origin + (row + 0.5) * cs;
          const dy = Number.isNaN(p.y) ? 0 : (h - py) * 0.7;
          const d = (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z) + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = base + l;
          }
        }
      }
    }
  }
  return best;
}

/** Closest walkable point to p (on the main component), or null if none within 16 m. */
export function nearestWalkable(nav: NavGrid, p: Vec3): Vec3 | null {
  const node = nearestNode(nav, p);
  if (node < 0) return null;
  const c = navNodePos(nav, node);
  // keep p itself when it lies on that node's surface and the agent fits there
  if (navCellAt(nav, p.x, p.z) === Math.floor(node / nav.layers)) {
    const w = walkerOf(nav);
    const h = w.walk(c.x, c.z, c.y, p.x, p.z);
    if (!Number.isNaN(h) && Math.abs(h - c.y) < NAV_MAX_STEP + 0.01) return { x: p.x, y: h, z: p.z };
  }
  return c;
}

/**
 * Walkable straight segment test (agent-sized, surface-following). Returns the
 * feet height at `b` or NaN. Useful for AI steering / LOS-to-move checks.
 */
export function navWalkSegment(nav: NavGrid, a: Vec3, b: Vec3): number {
  return walkerOf(nav).walk(a.x, a.z, a.y, b.x, b.z);
}

/** Random walkable main-component point within radius of center (for wandering/spawning). */
export function randomWalkablePoint(nav: NavGrid, rand: () => number, center: Vec3, radius: number, tries = 30): Vec3 | null {
  for (let i = 0; i < tries; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * radius;
    const node = locateNode(nav, { x: center.x + Math.cos(a) * r, y: NaN, z: center.z + Math.sin(a) * r });
    if (node >= 0 && nav.flags[node] & NAV_MAIN && !(nav.flags[node] & NAV_WATER)) return navNodePos(nav, node);
  }
  return null;
}

// ── A* ──────────────────────────────────────────────────────────────────────

/**
 * A* (8-connected, layered; water costs NAV_WATER_COST×) from `from` to `to`,
 * then string-pulled with agent-sized walk checks (grid line of sight that
 * follows surfaces, stairs and clearance). Waypoints start at `from` (y snapped
 * to the surface) and end at `to` when it is reachable; if `to` lies on a
 * surface that cannot be reached (a roof, a crate top, inside a building) the
 * path ends at the closest reachable point within 16 m. Returns null when
 * nothing is reachable.
 *
 * Budget: after `maxIter` node expansions the search stops and returns a
 * PARTIAL path to the expanded node closest (by the A* heuristic) to the goal,
 * so the caller makes progress and re-plans from there; such a path does not
 * end at `to`. On 虎牢·赤壁 a typical query expands < 2.5k nodes (< 1.5 ms)
 * and the worst cross-map queries ~7k (~4 ms), so a budget of 20000 always
 * completes while 5000 occasionally yields a partial path.
 */
export function findPath(nav: NavGrid, from: Vec3, to: Vec3, maxIter = 40000): Vec3[] | null {
  const start = startNode(nav, from);
  let goal = nearestNode(nav, to, 16, false);
  if (start < 0 || goal < 0) return null;
  // goal outside the start's (main) component: head for the closest reachable node instead
  if (nav.flags[start] & NAV_MAIN && !(nav.flags[goal] & NAV_MAIN)) goal = nearestNode(nav, to, 16, true);
  if (goal < 0) return null;
  const nodes = astar(nav, start, goal, maxIter);
  if (!nodes) return null;
  const pts: Vec3[] = nodes.map((n) => navNodePos(nav, n));
  const water: boolean[] = nodes.map((n) => (nav.flags[n] & NAV_WATER) !== 0);
  const w = walkerOf(nav);
  // replace the start node centre with the actual start if we can walk from it
  const s0 = pts[0];
  const hs = w.walk(from.x, from.z, s0.y, s0.x, s0.z);
  if (!Number.isNaN(hs) && Math.abs(hs - s0.y) < 0.3 && Math.abs(from.y - s0.y) < 1.5) pts[0] = { x: from.x, y: s0.y, z: from.z };
  // append the exact goal if it lies on the goal node's surface
  const gl = pts[pts.length - 1];
  if (nodes[nodes.length - 1] === goal && navCellAt(nav, to.x, to.z) === Math.floor(goal / nav.layers)) {
    const hg = w.walk(gl.x, gl.z, gl.y, to.x, to.z);
    if (!Number.isNaN(hg) && Math.abs(hg - gl.y) < NAV_MAX_STEP + 0.01) {
      pts.push({ x: to.x, y: hg, z: to.z });
      water.push(water[water.length - 1]);
    }
  }
  return smoothPath(nav, pts, water);
}

function startNode(nav: NavGrid, p: Vec3): number {
  const n = locateNode(nav, p, 2);
  if (n >= 0 && nav.links[n]) return n;
  return nearestNode(nav, p, 16, true);
}

function heuristic(nav: NavGrid, a: number, b: number): number {
  const ca = Math.floor(a / nav.layers);
  const cb = Math.floor(b / nav.layers);
  const dx = Math.abs((ca % nav.cols) - (cb % nav.cols));
  const dz = Math.abs(Math.floor(ca / nav.cols) - Math.floor(cb / nav.cols));
  const mn = dx < dz ? dx : dz;
  const mx = dx < dz ? dz : dx;
  return (mx - mn + mn * 1.41421356) * nav.cellSize;
}

function astar(nav: NavGrid, start: number, goal: number, maxIter: number): number[] | null {
  const S = nav.scratch;
  const gen = ++S.gen;
  const { g, f, parent, seen, closed, heap, heapPos } = S;
  let size = 0;

  const less = (i: number, j: number): boolean => f[heap[i]] < f[heap[j]];
  const swap = (i: number, j: number): void => {
    const a = heap[i];
    heap[i] = heap[j];
    heap[j] = a;
    heapPos[heap[i]] = i;
    heapPos[heap[j]] = j;
  };
  const up = (i: number): void => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      swap(i, p);
      i = p;
    }
  };
  const down = (i: number): void => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < size && less(l, m)) m = l;
      if (r < size && less(r, m)) m = r;
      if (m === i) return;
      swap(i, m);
      i = m;
    }
  };

  g[start] = 0;
  f[start] = heuristic(nav, start, goal);
  parent[start] = -1;
  seen[start] = gen;
  heap[0] = start;
  heapPos[start] = 0;
  size = 1;
  const cs = nav.cellSize;
  const diag = cs * 1.41421356;
  const trace = (end: number): number[] => {
    const out: number[] = [];
    for (let n = end; n !== -1; n = parent[n]) out.push(n);
    return out.reverse();
  };
  // expanded node closest to the goal (heuristic), for a partial path on budget exhaustion
  let bestNode = start;
  let bestH = f[start];
  let iter = 0;
  while (size > 0) {
    if (++iter > maxIter) return bestNode === start ? null : trace(bestNode);
    const a = heap[0];
    size--;
    if (size > 0) {
      heap[0] = heap[size];
      heapPos[heap[0]] = 0;
      down(0);
    }
    if (a === goal) return trace(goal);
    closed[a] = gen;
    const ha = f[a] - g[a];
    if (ha < bestH) {
      bestH = ha;
      bestNode = a;
    }
    const bits = nav.links[a];
    if (!bits) continue;
    for (let d = 0; d < 8; d++) {
      const m = (bits >> (2 * d)) & 3;
      if (!m) continue;
      const b = neighbourNode(nav, a, d, m - 1);
      if (closed[b] === gen) continue;
      let step = d & 1 ? diag : cs;
      if (nav.flags[b] & NAV_WATER) step *= NAV_WATER_COST;
      const ng = g[a] + step;
      if (seen[b] === gen && ng >= g[b]) continue;
      g[b] = ng;
      f[b] = ng + heuristic(nav, b, goal);
      parent[b] = a;
      if (seen[b] !== gen) {
        seen[b] = gen;
        heap[size] = b;
        heapPos[b] = size;
        size++;
        up(size - 1);
      } else {
        up(heapPos[b]);
      }
    }
  }
  return null;
}

function smoothPath(nav: NavGrid, pts: Vec3[], water: boolean[]): Vec3[] {
  if (pts.length <= 2) return pts;
  const w = walkerOf(nav);
  // prefix count of water nodes for the "don't shortcut through water" rule
  const wc = new Int32Array(pts.length + 1);
  for (let i = 0; i < pts.length; i++) wc[i + 1] = wc[i] + (water[i] ? 1 : 0);
  const visible = (i: number, j: number): boolean => {
    const a = pts[i];
    const b = pts[j];
    const h = w.walk(a.x, a.z, a.y, b.x, b.z);
    if (Number.isNaN(h) || Math.abs(h - b.y) > 0.3) return false;
    if (w.touchedWater && wc[j + 1] - wc[i] === 0) return false;
    return true;
  };
  const last = pts.length - 1;
  const out: Vec3[] = [pts[0]];
  let anchor = 0;
  while (anchor < last) {
    let good = anchor + 1;
    let bad = -1;
    let step = 2;
    for (;;) {
      const j = Math.min(anchor + step, last);
      if (j <= good) break;
      if (visible(anchor, j)) {
        good = j;
        if (j === last) break;
        step *= 2;
      } else {
        bad = j;
        break;
      }
    }
    if (bad > 0) {
      let lo = good;
      let hi = bad;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (visible(anchor, mid)) lo = mid;
        else hi = mid;
      }
      good = lo;
    }
    out.push(pts[good]);
    anchor = good;
  }
  return out;
}
