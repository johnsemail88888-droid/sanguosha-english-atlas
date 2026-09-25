// Static world assembly: every MapProp is built procedurally and merged per
// 64 m chunk and per material (opaque / double-sided cloth / unlit glow), so the
// whole map is a few dozen draw calls. Vegetation + rocks are instanced;
// banner cloths are one waving mesh; brazier flames one instanced mesh.
import * as THREE from 'three';
import type { MapData, MapProp, PropType } from '../../core/map';
import { GeoBuilder, trs } from '../core/geo';
import { glowMaterial, worldMaterial, worldMaterialDouble } from '../core/materials';
import { buildGateTower, buildHouse, buildPalace, buildPavilion, buildWall, buildWatchtower } from './buildings';
import {
  buildBannerPole,
  buildBarricade,
  buildBrazierStand,
  buildBridge,
  buildCrateStack,
  buildDock,
  buildFarmField,
  buildRuin,
  buildShip,
  buildStairs,
  buildStatue,
  buildTent,
} from './structures';
import { buildNature, natureStyle } from './nature';
import { buildBanners } from './banners';
import type { FireSource } from './fires';
import { makePropCtx, type PropCtx } from './propkit';
import { CamOccluderSink, type BoxCollider } from '../camera/camOccluders';

const CHUNK = 64;

type Builder = (c: PropCtx) => void;
const BUILDERS: Partial<Record<PropType, Builder>> = {
  wall: buildWall,
  gateTower: buildGateTower,
  palace: buildPalace,
  house: buildHouse,
  pavilion: buildPavilion,
  watchtower: buildWatchtower,
  tent: buildTent,
  barricade: buildBarricade,
  crateStack: buildCrateStack,
  bridge: buildBridge,
  dock: buildDock,
  ship: buildShip,
  statue: buildStatue,
  ruin: buildRuin,
  farmField: buildFarmField,
  stairs: buildStairs,
  brazier: buildBrazierStand,
  banner: buildBannerPole,
};

interface Chunk {
  opaque: GeoBuilder;
  cloth: GeoBuilder;
  glow: GeoBuilder;
}

export interface WorldStats {
  props: number;
  chunks: number;
  instanced: number;
  triangles: number;
  failed: number;
}

export interface WorldBuild {
  group: THREE.Group;
  fires: FireSource[];
  stats: WorldStats;
  /** camera-only occluder boxes (roof shells, under dock decks) — see camera/camOccluders.ts */
  cameraOccluders: BoxCollider[];
  dispose(): void;
}

/** Build a single prop into fresh builders (used by the dev harness / tests). */
export function buildPropGeometry(
  p: MapProp,
  map: MapData,
  occ: CamOccluderSink | null = null,
): { opaque: THREE.BufferGeometry; cloth: THREE.BufferGeometry; glow: THREE.BufferGeometry } | null {
  const fn = BUILDERS[p.type];
  if (!fn) return null;
  const opaque = new GeoBuilder();
  const cloth = new GeoBuilder();
  const glow = new GeoBuilder();
  const m = trs(p.x, p.y, p.z, 0, p.rot, 0);
  opaque.push(m);
  cloth.push(m);
  glow.push(m);
  fn(makePropCtx(opaque, cloth, glow, p, map, occ));
  return { opaque: opaque.build(), cloth: cloth.build(), glow: glow.build() };
}

export function buildWorld(map: MapData): WorldBuild {
  const group = new THREE.Group();
  group.name = 'world';
  const chunks = new Map<string, Chunk>();
  const half = map.size / 2;
  const fires: FireSource[] = [];
  const occ = new CamOccluderSink();
  let failed = 0;
  let built = 0;
  const chunkOf = (x: number, z: number): Chunk => {
    const cx = Math.floor((x + half) / CHUNK);
    const cz = Math.floor((z + half) / CHUNK);
    const key = `${cx},${cz}`;
    let ch = chunks.get(key);
    if (!ch) {
      ch = { opaque: new GeoBuilder(), cloth: new GeoBuilder(), glow: new GeoBuilder() };
      chunks.set(key, ch);
    }
    return ch;
  };
  for (const p of map.props) {
    if (p.type === 'brazier') fires.push({ pos: new THREE.Vector3(p.x, p.y + p.sy + 0.05, p.z), size: Math.max(0.6, p.sx * 0.9) });
    if (natureStyle(p)) continue;
    const fn = BUILDERS[p.type];
    if (!fn) continue;
    const ch = chunkOf(p.x, p.z);
    const m = trs(p.x, p.y, p.z, 0, p.rot, 0);
    ch.opaque.push(m);
    ch.cloth.push(m);
    ch.glow.push(m);
    try {
      fn(makePropCtx(ch.opaque, ch.cloth, ch.glow, p, map, occ));
      built++;
    } catch (err) {
      failed++;
      if (failed <= 3) console.warn('[render] prop build failed', p.type, err);
    } finally {
      ch.opaque.pop();
      ch.cloth.pop();
      ch.glow.pop();
    }
  }
  let triangles = 0;
  const geos: THREE.BufferGeometry[] = [];
  for (const [key, ch] of chunks) {
    const add = (gb: GeoBuilder, mat: THREE.Material, kind: string, shadows: boolean): void => {
      if (gb.isEmpty()) return;
      const g = gb.build();
      geos.push(g);
      triangles += g.getAttribute('position').count / 3;
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = `chunk_${key}_${kind}`;
      mesh.castShadow = shadows;
      mesh.receiveShadow = kind !== 'glow';
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    };
    add(ch.opaque, worldMaterial(), 'opaque', true);
    add(ch.cloth, worldMaterialDouble(), 'cloth', true);
    add(ch.glow, glowMaterial(), 'glow', false);
  }
  // the builders' scratch buffers are copied into the geometries: drop them now
  // (dispose() below shares this scope — anything left here lives as long as it)
  const chunkCount = chunks.size;
  chunks.clear();
  const nature = buildNature(map.props);
  group.add(nature.group);
  const banners = buildBanners(map.props);
  if (banners.mesh) group.add(banners.mesh);
  return {
    group,
    fires,
    stats: { props: built, chunks: chunkCount, instanced: nature.count, triangles: Math.round(triangles), failed },
    cameraOccluders: occ.boxes,
    dispose(): void {
      for (const g of geos) g.dispose();
      // nothing of the match may stay reachable through this closure (a leaked
      // reference to the WorldBuild must not pin megabytes of vertex arrays)
      geos.length = 0;
      nature.dispose();
      banners.dispose();
      group.clear();
    },
  };
}
