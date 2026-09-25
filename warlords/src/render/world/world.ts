// Static world assembly: every MapProp is built procedurally and merged per
// 64 m chunk and per material (opaque / double-sided cloth / unlit glow), so the
// whole map is a few dozen draw calls. Vegetation + rocks are instanced;
// banner cloths are one waving mesh; brazier flames one instanced mesh.
import * as THREE from 'three';
import type { MapData, MapProp, PropType } from '../../core/map';
import { GeoBuilder, trs } from '../core/geo';
import { glowMaterial, worldMaterial, worldMaterialDouble } from '../core/materials';
import { bindStructureSet, structureMaterial } from '../core/structureMaterial';
import { requestStructSet, withWorldArtListing, worldArtPossible } from '../core/worldArt';
import { assetListSync } from '../../game/assets';
import { buildPropModels, fullyReplacedTypes, glbPropKind, propModelPath, type GlbPropType, type PropModelSet } from './propModels';
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
  /** Resolves once the AI-art prop models (if any) have been swapped in or given up on. */
  artReady: Promise<void>;
  dispose(): void;
}

/**
 * Could this prop be replaced by a prop model? Props that may be are built into
 * per-kind "swap" meshes (hidden once the model is instanced) instead of the
 * merged chunks — only when the listing has the model, or is not known yet.
 */
function swappable(p: MapProp, files: ReadonlySet<string> | null): GlbPropType | null {
  const k = glbPropKind(p);
  if (!k || p.type === 'tree' || p.type === 'pine' || p.type === 'bamboo' || p.type === 'rock') return null; // nature: separate instanced meshes already
  if (!worldArtPossible()) return null; // single-file build, tests, user switch: plain chunks
  if (files === null) return k; // listing not loaded yet: keep the option open
  return files.has(propModelPath(k)) ? k : null;
}

/** Build a single prop into fresh builders (used by the dev harness / tests). */
export function buildPropGeometry(p: MapProp, map: MapData): { opaque: THREE.BufferGeometry; cloth: THREE.BufferGeometry; glow: THREE.BufferGeometry } | null {
  const fn = BUILDERS[p.type];
  if (!fn) return null;
  const opaque = new GeoBuilder({ extraName: 'aSurf' });
  const cloth = new GeoBuilder();
  const glow = new GeoBuilder();
  const m = trs(p.x, p.y, p.z, 0, p.rot, 0);
  opaque.push(m);
  cloth.push(m);
  glow.push(m);
  fn(makePropCtx(opaque, cloth, glow, p, map));
  return { opaque: opaque.build(), cloth: cloth.build(), glow: glow.build() };
}

export function buildWorld(map: MapData): WorldBuild {
  const group = new THREE.Group();
  group.name = 'world';
  const chunks = new Map<string, Chunk>();
  const half = map.size / 2;
  const fires: FireSource[] = [];
  let failed = 0;
  let built = 0;
  const listing = assetListSync();
  const swaps = new Map<GlbPropType, Chunk>();
  const swapOf = (k: GlbPropType): Chunk => {
    let ch = swaps.get(k);
    if (!ch) swaps.set(k, (ch = { opaque: new GeoBuilder({ extraName: 'aSurf' }), cloth: new GeoBuilder(), glow: new GeoBuilder() }));
    return ch;
  };
  const chunkOf = (x: number, z: number): Chunk => {
    const cx = Math.floor((x + half) / CHUNK);
    const cz = Math.floor((z + half) / CHUNK);
    const key = `${cx},${cz}`;
    let ch = chunks.get(key);
    if (!ch) {
      ch = { opaque: new GeoBuilder({ extraName: 'aSurf' }), cloth: new GeoBuilder(), glow: new GeoBuilder() };
      chunks.set(key, ch);
    }
    return ch;
  };
  for (const p of map.props) {
    if (p.type === 'brazier') fires.push({ pos: new THREE.Vector3(p.x, p.y + p.sy + 0.05, p.z), size: Math.max(0.6, p.sx * 0.9) });
    if (natureStyle(p)) continue;
    const fn = BUILDERS[p.type];
    if (!fn) continue;
    const sk = swappable(p, listing);
    const ch = sk ? swapOf(sk) : chunkOf(p.x, p.z);
    const m = trs(p.x, p.y, p.z, 0, p.rot, 0);
    ch.opaque.push(m);
    ch.cloth.push(m);
    ch.glow.push(m);
    ch.opaque.extra = 0; // every prop starts plain; builders pick their surfaces
    try {
      fn(makePropCtx(ch.opaque, ch.cloth, ch.glow, p, map));
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
  const opaqueMeshes: THREE.Mesh[] = [];
  const swapMeshes = new Map<GlbPropType, THREE.Mesh[]>();
  const buildChunk = (key: string, ch: Chunk, into: THREE.Mesh[] | null): void => {
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
      if (kind === 'opaque') opaqueMeshes.push(mesh);
      into?.push(mesh);
      group.add(mesh);
    };
    add(ch.opaque, worldMaterial(), 'opaque', true);
    add(ch.cloth, worldMaterialDouble(), 'cloth', true);
    add(ch.glow, glowMaterial(), 'glow', false);
  };
  for (const [key, ch] of chunks) buildChunk(key, ch, null);
  for (const [k, ch] of swaps) {
    const list: THREE.Mesh[] = [];
    buildChunk(`swap_${k}`, ch, list);
    swapMeshes.set(k, list);
  }
  const nature = buildNature(map.props);
  group.add(nature.group);
  const banners = buildBanners(map.props);
  if (banners.mesh) group.add(banners.mesh);
  // AI-art structure textures: swap the merged chunks to the textured variant
  // as soon as the listing is known (before the shader warm-up)
  let disposed = false;
  requestStructSet((set) => {
    if (disposed) return;
    bindStructureSet(set);
    const m = structureMaterial();
    for (const mesh of opaqueMeshes) mesh.material = m;
  });
  // AI-art prop models: instance them, then retire the procedural stand-ins
  const stats: WorldStats = { props: built, chunks: chunks.size, instanced: nature.count, triangles: Math.round(triangles), failed };
  let models: PropModelSet | null = null;
  let settle: () => void = () => undefined;
  const artReady = new Promise<void>((res) => (settle = res));
  const artOn = withWorldArtListing((files) => {
    void buildPropModels(map.props, map.size, files, () => disposed)
      .then((set) => {
        if (!set || disposed) {
          set?.dispose();
          return;
        }
        models = set;
        group.add(set.group);
        nature.removeTypes(fullyReplacedTypes(set.kinds));
        for (const k of set.kinds) {
          for (const mesh of swapMeshes.get(k) ?? []) {
            group.remove(mesh);
            mesh.geometry.dispose();
            const gi = geos.indexOf(mesh.geometry);
            if (gi >= 0) geos.splice(gi, 1);
            const oi = opaqueMeshes.indexOf(mesh);
            if (oi >= 0) opaqueMeshes.splice(oi, 1);
          }
          swapMeshes.delete(k);
        }
        stats.instanced = nature.count + set.instances;
      })
      .catch((err) => console.warn('[render] prop models failed', err))
      .finally(() => settle());
  });
  if (!artOn) settle();
  return {
    group,
    fires,
    stats,
    artReady,
    dispose(): void {
      disposed = true;
      for (const g of geos) g.dispose();
      nature.dispose();
      banners.dispose();
      (models as PropModelSet | null)?.dispose();
      settle();
    },
  };
}
