// Picks spawn points, loot spots and crate spots from candidate points of
// interest, validating every one against the nav grid (reachable from the lord
// spawn and back, dry, roomy, clear of colliders).
import type { MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import type { Vec3 } from '../../core/math';
import { dcos, dsin, PI } from './noise';
import { locateNode, NAV_AGENT_HEIGHT, NAV_MAIN, NAV_WATER, type NavGrid, navNodePos, nearestNode } from './nav';

export interface Poi {
  x: number;
  z: number;
  /** surface height for elevated spots (tower platforms, wall tops, decks); ground if omitted */
  y?: number;
  kind: 'loot' | 'crate1' | 'crate2';
  tag: string;
}

export const SPAWN_COUNT = 10;
export const SPAWN_RADIUS = { min: 100, max: 120, ideal: 110 };
/** Minimum horizontal clearance (m) between a spawn point and any collider. */
export const SPAWN_CLEARANCE = 1.5;
const SPOT_CLEARANCE = 0.7;

function linkCount(nav: NavGrid, node: number): number {
  let bits = nav.links[node];
  let n = 0;
  while (bits) {
    if (bits & 3) n++;
    bits >>= 2;
  }
  return n;
}

/**
 * Validate a candidate and snap it to its nav node. Crates are solid entities,
 * so they need a roomy node (>= 5 of 8 links, 0.7 m clearance) to never plug a
 * corridor ("roomy"); loot is a walk-over pickup and only needs to be on the
 * walkable network with a little clearance.
 */
function snapSpot(nav: NavGrid, p: Poi): { pos: Vec3; roomy: boolean } | null {
  const node =
    p.y !== undefined
      ? locateNode(nav, { x: p.x, y: p.y, z: p.z }, 0.6)
      : nearestNode(nav, { x: p.x, y: NaN, z: p.z }, 4, true);
  if (node < 0) return null;
  const f = nav.flags[node];
  if (!(f & NAV_MAIN) || f & NAV_WATER) return null;
  const links = linkCount(nav, node);
  if (links < 2) return null;
  const pos = navNodePos(nav, node);
  const clear = nav.colliders.clearance(pos.x, pos.z, pos.y + 0.1, pos.y + NAV_AGENT_HEIGHT, 2);
  if (clear < 0.5) return null;
  return { pos, roomy: links >= 5 && clear >= SPOT_CLEARANCE };
}

/** Greedy farthest-point selection (deterministic): keeps `count` well-spread points. */
function spreadPick(cands: Vec3[], count: number, taken: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  const minD = new Float64Array(cands.length).fill(Infinity);
  const upd = (p: Vec3): void => {
    for (let i = 0; i < cands.length; i++) {
      const dx = cands[i].x - p.x;
      const dy = cands[i].y - p.y;
      const dz = cands[i].z - p.z;
      const d = dx * dx + dy * dy * 4 + dz * dz;
      if (d < minD[i]) minD[i] = d;
    }
  };
  for (const t of taken) upd(t);
  const used = new Uint8Array(cands.length);
  while (out.length < count) {
    let best = -1;
    let bestD = -1;
    for (let i = 0; i < cands.length; i++) if (!used[i] && minD[i] > bestD) {
      bestD = minD[i];
      best = i;
    }
    if (best < 0 || bestD < 16) break; // nothing left that is >= 4 m from the rest
    used[best] = 1;
    out.push(cands[best]);
    upd(cands[best]);
  }
  return out;
}

export interface SpotResult {
  lootSpots: Vec3[];
  crateSpots: { pos: Vec3; tier: 1 | 2 | 3 }[];
}

export function chooseSpots(nav: NavGrid, pois: Poi[], targets = { crate2: 12, crate1: 40, loot: 60 }): SpotResult {
  const byKind = { crate2: [] as Vec3[], crate1: [] as Vec3[], loot: [] as Vec3[] };
  const roomyLoot: Vec3[] = [];
  for (const p of pois) {
    const s = snapSpot(nav, p);
    if (!s) continue;
    if (p.kind === 'loot') {
      byKind.loot.push(s.pos);
      if (s.roomy) roomyLoot.push(s.pos);
    } else if (s.roomy) byKind[p.kind].push(s.pos);
    else byKind.loot.push(s.pos); // too cramped for a crate: offer it as loot
  }
  const taken: Vec3[] = [];
  const c2 = spreadPick(byKind.crate2, targets.crate2, taken);
  taken.push(...c2);
  // leftover tier-2 candidates become tier-1 candidates
  let c1 = spreadPick([...byKind.crate1, ...byKind.crate2.filter((p) => !c2.includes(p))], targets.crate1, taken);
  if (c1.length < targets.crate1) {
    // top up from roomy loot candidates
    c1 = c1.concat(spreadPick(roomyLoot, targets.crate1 - c1.length, [...taken, ...c1]));
  }
  taken.push(...c1);
  const loot = spreadPick(
    [...byKind.loot.filter((p) => !c1.includes(p)), ...byKind.crate1.filter((p) => !c1.includes(p))],
    targets.loot,
    taken,
  );
  return {
    lootSpots: loot,
    crateSpots: [...c2.map((pos) => ({ pos, tier: 2 as const })), ...c1.map((pos) => ({ pos, tier: 1 as const }))],
  };
}

/**
 * Hero spawns on a ring ~110 m from the centre, one per angular sector. Each is
 * on dry terrain (not a deck), in the main nav component, with generous collider
 * clearance and away from NPC camps.
 */
export function chooseSpawns(map: MapData, nav: NavGrid, avoid: { pos: Vec3; r: number }[], angleOffset: number): Vec3[] {
  const out: Vec3[] = [];
  const offsets = [0, 0.07, -0.07, 0.14, -0.14, 0.21, -0.21, 0.28, -0.28, 0.35, -0.35];
  const radii = [SPAWN_RADIUS.ideal, 105, 115, 100, 120];
  for (let k = 0; k < SPAWN_COUNT; k++) {
    const base = angleOffset + (k * 2 * PI) / SPAWN_COUNT;
    let found: Vec3 | null = null;
    for (const da of offsets) {
      for (const r of radii) {
        const a = base + da;
        // compass angle: 0 = north (-Z), clockwise
        const x = r * dsin(a);
        const z = -r * dcos(a);
        const node = locateNode(nav, { x, y: NaN, z });
        if (node < 0) continue;
        const f = nav.flags[node];
        if (!(f & NAV_MAIN) || f & NAV_WATER || linkCount(nav, node) < 8) continue;
        const pos = navNodePos(nav, node);
        const ground = terrainHeight(map, pos.x, pos.z);
        if (Math.abs(pos.y - ground) > 0.01 || ground < map.waterLevel + 0.3) continue;
        if (nav.colliders.clearance(pos.x, pos.z, ground - 0.5, ground + 2, 3) < SPAWN_CLEARANCE) continue;
        const dc = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
        if (dc < SPAWN_RADIUS.min || dc > SPAWN_RADIUS.max) continue;
        if (avoid.some((c) => (c.pos.x - pos.x) * (c.pos.x - pos.x) + (c.pos.z - pos.z) * (c.pos.z - pos.z) < c.r * c.r)) continue;
        if (out.some((s) => (s.x - pos.x) * (s.x - pos.x) + (s.z - pos.z) * (s.z - pos.z) < 36 * 36)) continue;
        found = { x: pos.x, y: ground, z: pos.z };
        break;
      }
      if (found) break;
    }
    if (found) out.push(found);
  }
  return out;
}
