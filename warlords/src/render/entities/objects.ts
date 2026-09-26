// Non-character entity visuals: projectiles, loot, crates, airdrops, turrets.
import * as THREE from 'three';
import type { ViewEntity } from '../../core/types';
import { VF_OPENED } from '../../core/types';
import { ARMOR_BY_ID, ITEM_BY_ID, MOUNT_BY_ID, WEAPON_BY_ID } from '../../data';
import type { Rarity } from '../../data/types';
import { GeoBuilder, PRIM, col, mixCol, shade, trs } from '../core/geo';
import { glowMaterial, worldMaterial, worldMaterialDouble } from '../core/materials';
import { PT, cardTexture } from '../core/textures';
import { RARITY_COLORS, kingdomColor } from '../palette';
import { buildWeapon, hasWeaponArt, weaponArtEpoch } from '../models/weapons';
import { requestWeaponArt } from '../models/weaponGlb';
import type { EntityCtx } from './context';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
const geoCache = new Map<string, THREE.BufferGeometry>();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const ROCKET_SMOKE = new THREE.Color(0.55, 0.53, 0.5);
const SIGNAL_SMOKE = new THREE.Color(0.85, 0.12, 0.08);
const SIGNAL_SMOKE1 = new THREE.Color(0.7, 0.45, 0.4);
const FLARE = new THREE.Color(3, 0.6, 0.3);
/** Dispose and forget the cached loot / crate / projectile geometries (end of a match). */
export function releaseObjectGeometryCache(): void {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
}

function cachedGeo(key: string, build: (b: GeoBuilder) => void): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    const b = new GeoBuilder();
    build(b);
    g = b.build();
    geoCache.set(key, g);
  }
  return g;
}

export interface EntityView {
  readonly root: THREE.Object3D;
  update(e: ViewEntity, ctx: EntityCtx): void;
  onShot?(): void;
  dispose(): void;
}

// ── projectiles ─────────────────────────────────────────────────────────────
type ProjStyle = 'rocket' | 'grenade' | 'arrow' | 'fireball' | 'bolt' | 'ice' | 'fireship' | 'dart' | 'orb';

function projStyle(kind: string): ProjStyle {
  const k = kind.toLowerCase();
  if (k.includes('rocket') || k.includes('missile')) return 'rocket';
  if (k.includes('grenade') || k.includes('bomb') || k.includes('gas')) return 'grenade';
  if (k.includes('ship') || k.includes('boat')) return 'fireship';
  if (k.includes('arrow') || k.includes('bolt_arrow')) return 'arrow';
  if (k.includes('dart') || k.includes('needle')) return 'dart';
  if (k.includes('fire') || k.includes('flame') || k.includes('napalm')) return 'fireball';
  if (k.includes('ice') || k.includes('frost')) return 'ice';
  if (k.includes('bolt') || k.includes('thunder') || k.includes('lightning') || k.includes('tesla')) return 'bolt';
  return 'orb';
}

function projGeometry(style: ProjStyle): { geo: THREE.BufferGeometry; glow: boolean } {
  switch (style) {
    case 'rocket':
      return {
        geo: cachedGeo('p_rocket', (b) => {
          b.add(PRIM.cyl(8), trs(0, 0, 0, Math.PI / 2, 0, 0, 0.07, 0.6, 0.07), '#3a3d3a');
          b.add(PRIM.cone(8), trs(0, 0, -0.38, -Math.PI / 2, 0, 0, 0.07, 0.18, 0.07), '#b8322a');
          for (let i = 0; i < 4; i++) b.add(PRIM.box(), trs(0, 0, 0.26, 0, 0, (i * Math.PI) / 2, 0.02, 0.22, 0.14), '#2a2a2a');
        }),
        glow: false,
      };
    case 'grenade':
      return { geo: cachedGeo('p_grenade', (b) => b.add(PRIM.sphere(8, 6), trs(0, 0, 0, 0, 0, 0, 0.09, 0.1, 0.09), '#3a4a2a')), glow: false };
    case 'arrow':
    case 'dart':
      return {
        geo: cachedGeo(`p_${style}`, (b) => {
          const L = style === 'dart' ? 0.25 : 0.85;
          b.add(PRIM.cyl(5), trs(0, 0, 0, Math.PI / 2, 0, 0, 0.012, L, 0.012), '#8a6a44');
          b.add(PRIM.cone(4), trs(0, 0, -L / 2 - 0.05, -Math.PI / 2, 0, 0, 0.03, 0.1, 0.03), '#cfd4d8');
          if (style === 'arrow') for (const r of [0, Math.PI / 2]) b.add(PRIM.box(), trs(0, 0, L / 2 - 0.06, 0, 0, r, 0.002, 0.08, 0.12), '#e8e0cc');
        }),
        glow: false,
      };
    case 'fireship':
      return {
        geo: cachedGeo('p_fireship', (b) => {
          b.add(PRIM.sphere(8, 5), trs(0, 0, 0, 0, 0, 0, 0.5, 0.3, 1.2), '#4e3726');
          b.add(PRIM.cyl(6), trs(0, 0.3, 0, 0, 0, Math.PI / 2, 0.25, 0.8, 0.25), '#c8a050');
        }),
        glow: false,
      };
    default: {
      const colr = style === 'fireball' ? '#ff9a3a' : style === 'ice' ? '#b8e8ff' : style === 'bolt' ? '#9ad0ff' : '#ffe6a0';
      return { geo: cachedGeo(`p_${style}`, (b) => b.add(PRIM.ico(1), trs(0, 0, 0, 0, 0, 0, 0.18, 0.18, 0.18), colr)), glow: true };
    }
  }
}

const TRAIL: Record<ProjStyle, { tex: number; color: THREE.Color; color1: THREE.Color; size: [number, number]; life: [number, number]; rate: number; additive: boolean; gravity: number }> = {
  rocket: { tex: PT.flame, color: new THREE.Color(2.6, 1.3, 0.4), color1: new THREE.Color(0.5, 0.45, 0.4), size: [0.25, 0.8], life: [0.25, 0.5], rate: 70, additive: true, gravity: -0.5 },
  grenade: { tex: PT.spark, color: new THREE.Color(2.2, 1.4, 0.5), color1: new THREE.Color(1, 0.3, 0.1), size: [0.05, 0.02], life: [0.15, 0.3], rate: 25, additive: true, gravity: 2 },
  arrow: { tex: PT.glow, color: new THREE.Color(0.8, 0.75, 0.6), color1: new THREE.Color(0.3, 0.3, 0.3), size: [0.05, 0.02], life: [0.1, 0.2], rate: 15, additive: true, gravity: 0 },
  dart: { tex: PT.glow, color: new THREE.Color(0.6, 1.4, 0.6), color1: new THREE.Color(0.2, 0.5, 0.2), size: [0.04, 0.01], life: [0.1, 0.2], rate: 15, additive: true, gravity: 0 },
  fireball: { tex: PT.flame, color: new THREE.Color(2.6, 1.1, 0.3), color1: new THREE.Color(0.6, 0.1, 0.02), size: [0.35, 0.8], life: [0.2, 0.45], rate: 60, additive: true, gravity: -1.5 },
  bolt: { tex: PT.spark, color: new THREE.Color(0.8, 1.2, 2.8), color1: new THREE.Color(0.4, 0.6, 2), size: [0.08, 0.02], life: [0.1, 0.25], rate: 50, additive: true, gravity: 0 },
  ice: { tex: PT.snow, color: new THREE.Color(1.4, 1.8, 2.3), color1: new THREE.Color(0.6, 0.8, 1), size: [0.12, 0.05], life: [0.3, 0.6], rate: 35, additive: true, gravity: 1 },
  fireship: { tex: PT.flame, color: new THREE.Color(2.6, 1.1, 0.3), color1: new THREE.Color(0.4, 0.3, 0.25), size: [0.6, 1.6], life: [0.4, 0.8], rate: 50, additive: true, gravity: -2 },
  orb: { tex: PT.glow, color: new THREE.Color(1.8, 1.6, 1.0), color1: new THREE.Color(0.6, 0.5, 0.3), size: [0.15, 0.04], life: [0.15, 0.3], rate: 30, additive: true, gravity: 0 },
};

export class ProjectileView implements EntityView {
  readonly root = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly style: ProjStyle;
  private readonly last = new THREE.Vector3();
  private readonly dir = new THREE.Vector3(0, 0, -1);
  private init = false;
  private acc = 0;

  constructor(e: ViewEntity) {
    this.style = projStyle(e.sub);
    const { geo, glow } = projGeometry(this.style);
    this.mesh = new THREE.Mesh(geo, glow ? glowMaterial() : worldMaterial());
    this.mesh.castShadow = !glow;
    this.root.add(this.mesh);
    this.root.name = `proj_${e.id}`;
  }

  update(e: ViewEntity, ctx: EntityCtx): void {
    const p = _p.set(e.x, e.y, e.z);
    if (this.init) {
      const d = _d.subVectors(p, this.last);
      if (d.lengthSq() > 1e-6) this.dir.lerp(d.normalize(), 0.6).normalize();
    } else {
      this.dir.set(-Math.sin(e.yaw) * Math.cos(e.pitch), Math.sin(e.pitch), -Math.cos(e.yaw) * Math.cos(e.pitch));
      this.init = true;
    }
    this.last.copy(p);
    this.root.position.copy(p);
    this.root.lookAt(p.x - this.dir.x, p.y - this.dir.y, p.z - this.dir.z);
    if (this.style === 'grenade') this.mesh.rotation.x += ctx.dt * 12;
    // trail
    const t = TRAIL[this.style];
    this.acc += ctx.dt * t.rate;
    const n = Math.floor(this.acc);
    this.acc -= n;
    if (n > 0 && ctx.camPos.distanceTo(p) < 150) {
      ctx.fx.burst(p, {
        count: n,
        tex: t.tex as never,
        color: t.color,
        color1: t.color1,
        speed: [0.1, 0.6],
        life: t.life,
        size: t.size,
        gravity: t.gravity,
        additive: t.additive,
        radius: 0.05,
      });
      if (this.style === 'rocket')
        ctx.fx.burst(p, { count: 1, tex: PT.smoke, color: ROCKET_SMOKE, speed: [0.2, 0.6], life: [0.8, 1.4], size: [0.3, 1.2], additive: false, alpha: 0.45, gravity: -0.3, drag: 1 });
    }
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}

// ── loot ────────────────────────────────────────────────────────────────────
/**
 * Loot light-beams fade by each fragment's distance to the camera: gone closer
 * than LOOT_BEAM_HIDE, full from LOOT_BEAM_FULL. A beam 1–2 m from the lens
 * (walking past loot, standing on it) would otherwise draw as a big additive
 * slab across the screen and over the HUD; per fragment, so the far part of a
 * beam you stand next to still glows.
 */
export const LOOT_BEAM_HIDE = 1.6;
export const LOOT_BEAM_FULL = 5;

/** CPU twin of the beam shader's near-camera factor (0..1). */
export function lootBeamNearFade(dist: number): number {
  const t = Math.min(1, Math.max(0, (dist - LOOT_BEAM_HIDE) / (LOOT_BEAM_FULL - LOOT_BEAM_HIDE)));
  return t * t * (3 - 2 * t);
}

function nearFadeBeam(m: THREE.MeshBasicMaterial): void {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBeamView;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvBeamView = mvPosition.xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBeamView;')
      .replace('#include <opaque_fragment>', `diffuseColor.a *= smoothstep(${LOOT_BEAM_HIDE.toFixed(2)}, ${LOOT_BEAM_FULL.toFixed(2)}, length(vBeamView));\n#include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'lootBeamNearFade';
}

const pillarMats = new Map<string, THREE.MeshBasicMaterial>();
let pillarGeo: THREE.CylinderGeometry | null = null;
function lootPillar(rarity: Rarity): THREE.Mesh {
  if (!pillarGeo) {
    pillarGeo = new THREE.CylinderGeometry(0.06, 0.22, 3.2, 10, 1, true);
    pillarGeo.translate(0, 1.6, 0);
    const colors = new Float32Array(pillarGeo.getAttribute('position').count * 3);
    const pos = pillarGeo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const a = 1 - (pos.getY(i) / 3.2);
      colors.set([a, a, a], i * 3);
    }
    pillarGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  let m = pillarMats.get(rarity);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(RARITY_COLORS[rarity]).multiplyScalar(rarity === 'common' ? 0.6 : 1.4),
      vertexColors: true,
      transparent: true,
      opacity: rarity === 'common' ? 0.25 : 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    nearFadeBeam(m);
    pillarMats.set(rarity, m);
  }
  const mesh = new THREE.Mesh(pillarGeo, m);
  mesh.renderOrder = 17;
  return mesh;
}

function lootInfo(id: string): { rarity: Rarity; glyph: string; color: string; weapon: boolean } {
  const w = WEAPON_BY_ID[id];
  if (w) return { rarity: w.rarity, glyph: w.nameZh.slice(0, 1), color: w.model.accentColor, weapon: true };
  const it = ITEM_BY_ID[id];
  if (it) return { rarity: it.rarity, glyph: it.icon || it.nameZh.slice(0, 1), color: it.color, weapon: false };
  const ar = ARMOR_BY_ID[id];
  if (ar) return { rarity: ar.rarity, glyph: ar.nameZh.slice(0, 1), color: ar.color, weapon: false };
  const mt = MOUNT_BY_ID[id];
  if (mt) return { rarity: mt.rarity, glyph: '马', color: mt.color, weapon: false };
  return { rarity: 'common', glyph: '锦', color: '#c9a04a', weapon: false };
}

let cardGeo: THREE.PlaneGeometry | null = null;
const cardMats = new Map<string, THREE.MeshStandardMaterial>();

/** Loot / crates cast shadows only this close to the camera (draw-call budget). */
const PROP_SHADOW_DIST = 18;

/** Tilt of a weapon pickup (rolled onto its side, a little nose-down). */
const LOOT_WEAPON_ROLL = Math.PI / 2 - 0.3;
const _c = new THREE.Vector3();

/** A weapon pickup's mesh in its spinning holder, centred on the holder so long weapons spin in place. */
function lootWeapon(id: string, holder: THREE.Object3D): THREE.Mesh {
  const w = buildWeapon(id);
  const m = w.mesh;
  m.rotation.set(0, 0, LOOT_WEAPON_ROLL);
  const g = m.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  g.boundingBox!.getCenter(_c).applyEuler(m.rotation);
  m.position.copy(_c).negate();
  holder.add(m);
  return m;
}

export class LootView implements EntityView {
  readonly root = new THREE.Group();
  private readonly item: THREE.Object3D;
  private shadowCaster: THREE.Object3D;
  private readonly phase: number;
  /** weapon pickup whose AI-art model is still loading: weaponArtEpoch() when checked last (-1 = none) */
  private artWait = -1;
  private readonly sub: string;

  constructor(e: ViewEntity) {
    const info = lootInfo(e.sub);
    this.sub = e.sub;
    this.phase = (e.id * 1.7) % 6.28;
    if (info.weapon) {
      const holder = new THREE.Group();
      this.shadowCaster = lootWeapon(e.sub, holder);
      this.item = holder;
      if (requestWeaponArt(e.sub)) this.artWait = weaponArtEpoch();
    } else {
      if (!cardGeo) cardGeo = new THREE.PlaneGeometry(0.42, 0.56);
      const key = `${info.glyph}|${info.color}|${info.rarity}`;
      let m = cardMats.get(key);
      if (!m) {
        m = new THREE.MeshStandardMaterial({
          map: cardTexture(info.glyph, info.color, RARITY_COLORS[info.rarity]),
          side: THREE.DoubleSide,
          emissive: new THREE.Color(RARITY_COLORS[info.rarity]),
          emissiveIntensity: 0.25,
          roughness: 0.6,
        });
        cardMats.set(key, m);
      }
      this.item = new THREE.Mesh(cardGeo, m);
      this.shadowCaster = this.item;
    }
    this.root.add(this.item);
    if (info.rarity !== 'common' || info.weapon) this.root.add(lootPillar(info.rarity));
    this.root.name = `loot_${e.id}`;
  }

  update(e: ViewEntity, ctx: EntityCtx): void {
    if (this.artWait >= 0 && this.artWait !== weaponArtEpoch()) {
      this.artWait = weaponArtEpoch();
      if (hasWeaponArt(this.sub)) {
        // the AI-art model arrived: swap it in
        this.shadowCaster.removeFromParent();
        this.shadowCaster = lootWeapon(this.sub, this.item);
        this.artWait = -1;
      }
    }
    this.root.position.set(e.x, e.y, e.z);
    this.item.position.y = 0.55 + Math.sin(ctx.time * 2 + this.phase) * 0.06;
    this.item.rotation.y = ctx.time * 1.2 + this.phase;
    const dist = ctx.camPos.distanceTo(this.root.position);
    this.root.visible = dist < 120;
    this.shadowCaster.castShadow = ctx.shadows && dist < PROP_SHADOW_DIST;
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}

// ── crates (锦囊) ────────────────────────────────────────────────────────────
const CRATE_STYLE: Record<number, { body: string; trim: string; band: string; glow: string }> = {
  1: { body: '#7a5230', trim: '#c9a04a', band: '#b8322a', glow: '#f0e0a0' },
  2: { body: '#4f7a62', trim: '#d8ac4c', band: '#2e5f8a', glow: '#7fb8ff' },
  3: { body: '#b8322a', trim: '#f0c040', band: '#f0c040', glow: '#ffd060' },
};

function crateGeos(tier: number): { body: THREE.BufferGeometry; lid: THREE.BufferGeometry } {
  const s = CRATE_STYLE[tier] ?? CRATE_STYLE[1];
  const body = cachedGeo(`crate_body_${tier}`, (b) => {
    b.boxAt(0, 0.28, 0, 0.9, 0.56, 0.62, s.body);
    b.boxAt(0, 0.04, 0, 0.94, 0.08, 0.66, shade(s.body, 0.6));
    for (const x of [-0.45, 0.45]) for (const z of [-0.31, 0.31]) b.boxAt(x, 0.28, z, 0.07, 0.58, 0.07, s.trim);
    b.boxAt(0, 0.3, -0.315, 0.2, 0.56, 0.02, s.band);
    b.boxAt(0, 0.3, 0.315, 0.2, 0.56, 0.02, s.band);
    b.add(PRIM.cyl(12), trs(0, 0.36, -0.33, Math.PI / 2, 0, 0, 0.09, 0.02, 0.09), s.trim);
    b.add(PRIM.box(), trs(0, 0.36, -0.345, 0, 0, Math.PI / 4, 0.08, 0.08, 0.01), shade(s.band, 0.7));
  });
  const lid = cachedGeo(`crate_lid_${tier}`, (b) => {
    // pivot at the back top edge (z = +0.31)
    b.boxAt(0, 0.06, -0.31, 0.94, 0.12, 0.66, shade(s.body, 1.1));
    b.boxAt(0, 0.13, -0.31, 0.2, 0.02, 0.66, s.band);
    for (const x of [-0.45, 0.45]) b.boxAt(x, 0.06, -0.31, 0.07, 0.13, 0.68, s.trim);
    if (tier === 3) b.add(PRIM.sphere(6, 4), trs(0, 0.16, -0.31, 0, 0, 0, 0.08, 0.05, 0.08), s.trim);
  });
  return { body, lid };
}

export class CrateView implements EntityView {
  readonly root = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly lid: THREE.Mesh;
  private readonly glow: THREE.Mesh;
  private openT = 0;
  private wasOpen = false;
  private readonly tier: number;

  constructor(e: ViewEntity) {
    this.tier = Math.max(1, Math.min(3, parseInt(e.sub, 10) || 1));
    const { body, lid } = crateGeos(this.tier);
    const bm = new THREE.Mesh(body, worldMaterial());
    bm.castShadow = true;
    bm.receiveShadow = true;
    this.body = bm;
    this.lid = new THREE.Mesh(lid, worldMaterial());
    this.lid.position.set(0, 0.56, 0.31);
    this.lid.castShadow = true;
    const glowGeo = cachedGeo('crate_glow', (b) => b.add(PRIM.cyl(20, 1, true), trs(0, 0.02, 0, 0, 0, 0, 0.8, 0.04, 0.8), '#ffffff'));
    this.glow = new THREE.Mesh(
      glowGeo,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(CRATE_STYLE[this.tier].glow).multiplyScalar(1.5), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.root.add(bm, this.lid, this.glow);
    this.root.name = `crate_${e.id}`;
    this.wasOpen = (e.flags & VF_OPENED) !== 0;
    this.openT = this.wasOpen ? 1 : 0;
  }

  update(e: ViewEntity, ctx: EntityCtx): void {
    this.root.position.set(e.x, e.y, e.z);
    this.root.rotation.y = e.yaw;
    const open = (e.flags & VF_OPENED) !== 0;
    if (open && !this.wasOpen) {
      ctx.fx.sparkle(new THREE.Vector3(e.x, e.y + 0.8, e.z), new THREE.Color(CRATE_STYLE[this.tier].glow).multiplyScalar(2), 18);
      ctx.fx.fx.pillar(new THREE.Vector3(e.x, e.y, e.z), new THREE.Color(CRATE_STYLE[this.tier].glow).multiplyScalar(1.5), 0.5, 4, 0.8, 0.8);
    }
    this.wasOpen = open;
    this.openT += ((open ? 1 : 0) - this.openT) * (1 - Math.exp(-ctx.dt * 8));
    this.lid.rotation.x = -1.9 * this.openT;
    this.glow.visible = this.openT < 0.5;
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.25 * Math.sin(ctx.time * 3 + e.id);
    const dist = ctx.camPos.distanceTo(this.root.position);
    this.root.visible = dist < 160;
    const shadow = ctx.shadows && dist < PROP_SHADOW_DIST * 2;
    this.body.castShadow = shadow;
    // a closed lid's shadow falls inside the body's
    this.lid.castShadow = shadow && this.openT > 0.05;
  }

  dispose(): void {
    this.root.removeFromParent();
    (this.glow.material as THREE.Material).dispose();
  }
}

// ── airdrop (天降锦囊) ────────────────────────────────────────────────────────
export class AirdropView implements EntityView {
  readonly root = new THREE.Group();
  private readonly crate: CrateView;
  private readonly chute: THREE.Group;
  private chuteK = 1;
  private smokeAcc = 0;

  constructor(e: ViewEntity) {
    this.crate = new CrateView({ ...e, sub: '3' });
    this.root.add(this.crate.root);
    this.chute = new THREE.Group();
    const canopy = cachedGeo('chute', (b) => {
      const segs = 12;
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const colr = i % 2 ? '#e8e0cc' : '#c0392b';
        for (let r = 0; r < 3; r++) {
          const t0 = r / 3;
          const t1 = (r + 1) / 3;
          const ring = (t: number): [number, number] => [Math.sin(t * Math.PI * 0.45) * 2.4, 5.2 + Math.cos(t * Math.PI * 0.45) * 1.1];
          const [ra, ya] = ring(t0);
          const [rb, yb] = ring(t1);
          b.quad(V(Math.cos(a0) * ra, ya, Math.sin(a0) * ra), V(Math.cos(a1) * ra, ya, Math.sin(a1) * ra), V(Math.cos(a1) * rb, yb, Math.sin(a1) * rb), V(Math.cos(a0) * rb, yb, Math.sin(a0) * rb), colr, true);
        }
        b.rod(V(Math.cos(a0) * 2.4, 5.2 + Math.cos(Math.PI * 0.45) * 1.1, Math.sin(a0) * 2.4), V(0, 0.7, 0), 0.01, '#3a3a3a', 3);
      }
    });
    const cm = new THREE.Mesh(canopy, worldMaterialDouble());
    cm.castShadow = true;
    this.chute.add(cm);
    this.root.add(this.chute);
    this.root.name = `airdrop_${e.id}`;
  }

  update(e: ViewEntity, ctx: EntityCtx): void {
    this.crate.update(e, ctx);
    this.root.position.set(0, 0, 0);
    const ground = ctx.groundY(e.x, e.z);
    const airborne = e.y > ground + 0.4;
    this.chuteK += ((airborne ? 1 : 0) - this.chuteK) * (1 - Math.exp(-ctx.dt * (airborne ? 6 : 1.5)));
    this.chute.visible = this.chuteK > 0.02;
    this.chute.position.set(e.x, e.y, e.z);
    this.chute.scale.set(1 + (1 - this.chuteK) * 0.3, Math.max(0.02, this.chuteK), 1 + (1 - this.chuteK) * 0.3);
    this.chute.rotation.z = Math.sin(ctx.time * 1.3) * 0.06 * this.chuteK;
    // red signal smoke (dense while falling, a lasting column after landing)
    this.smokeAcc += ctx.dt * (airborne ? 14 : 8);
    const n = Math.floor(this.smokeAcc);
    this.smokeAcc -= n;
    if (n > 0 && (e.flags & VF_OPENED) === 0 && ctx.camPos.distanceTo(_p.set(e.x, e.y, e.z)) < 260) {
      ctx.fx.burst(_p.set(e.x, e.y + 0.6, e.z), {
        count: n,
        tex: PT.smoke,
        color: SIGNAL_SMOKE,
        color1: SIGNAL_SMOKE1,
        speed: [0.4, 1.2],
        up: 1,
        life: [2.5, 4.5],
        size: [0.6, 3.2],
        additive: false,
        alpha: 0.65,
        gravity: -1.6,
        drag: 0.6,
      });
      if (airborne) ctx.fx.burst(_p.set(e.x, e.y + 0.3, e.z), { count: 1, tex: PT.glow, color: FLARE, speed: [0, 0.2], life: [0.3, 0.5], size: [0.5, 0.2] });
    }
  }

  dispose(): void {
    this.crate.dispose();
    this.root.removeFromParent();
  }
}

// ── turret (木牛流马) ─────────────────────────────────────────────────────────
export class TurretView implements EntityView {
  readonly root = new THREE.Group();
  private readonly swivel = new THREE.Group();
  private readonly gun: THREE.Object3D;
  private recoil = 0;
  private legPhase = 0;
  private readonly legs: THREE.Mesh[] = [];

  constructor(e: ViewEntity) {
    const kc = kingdomColor(e.kingdom);
    const body = cachedGeo(`turret_body_${kc}`, (b) => {
      b.boxAt(0, 0.62, 0, 0.7, 0.45, 1.1, '#8a6238');
      b.boxAt(0, 0.88, 0.05, 0.6, 0.1, 0.8, shade('#8a6238', 1.15));
      b.boxAt(0, 0.75, -0.62, 0.36, 0.34, 0.34, '#7a5430'); // ox head
      for (const s of [-1, 1]) b.add(PRIM.cone(5), trs(s * 0.16, 0.98, -0.66, 0, 0, s * -0.6, 0.04, 0.2, 0.04), '#e8dcc0');
      b.boxAt(0, 0.62, -0.63, 0.72, 0.1, 0.02, kc);
      b.boxAt(0, 0.62, 0.56, 0.4, 0.3, 0.02, kc);
      b.add(PRIM.torus(0.2, 4, 10), trs(-0.38, 0.35, 0.3, 0, Math.PI / 2, 0, 0.22), '#5a3f28');
      b.add(PRIM.torus(0.2, 4, 10), trs(0.38, 0.35, 0.3, 0, Math.PI / 2, 0, 0.22), '#5a3f28');
      b.rod(V(0.2, 0.9, 0.4), V(0.2, 1.9, 0.4), 0.02, '#3a2a1a', 4);
    });
    const bm = new THREE.Mesh(body, worldMaterial());
    bm.castShadow = true;
    this.root.add(bm);
    const legGeo = cachedGeo('turret_leg', (b) => b.boxAt(0, -0.2, 0, 0.1, 0.42, 0.1, '#5a3f28'));
    for (const [x, z] of [
      [-0.25, -0.4],
      [0.25, -0.4],
    ]) {
      const leg = new THREE.Mesh(legGeo, worldMaterial());
      leg.position.set(x, 0.42, z);
      this.legs.push(leg);
      this.root.add(leg);
    }
    const flagGeo = cachedGeo(`turret_flag_${kc}`, (b) => b.quad(V(0.2, 1.9, 0.4), V(0.2, 1.5, 0.4), V(0.75, 1.62, 0.4), V(0.75, 1.9, 0.4), kc, true));
    this.root.add(new THREE.Mesh(flagGeo, worldMaterialDouble()));
    this.gun = buildWeapon(e.weapon ?? 'turret_smg').mesh;
    this.gun.scale.setScalar(1.3);
    this.swivel.position.set(0, 1.0, 0);
    this.swivel.add(this.gun);
    this.root.add(this.swivel);
    this.root.name = `turret_${e.id}`;
  }

  onShot(): void {
    this.recoil = 1;
  }

  update(e: ViewEntity, ctx: EntityCtx): void {
    this.root.position.set(e.x, e.y, e.z);
    this.swivel.rotation.set(0, 0, 0);
    this.swivel.rotation.y = e.yaw - this.root.rotation.y;
    this.gun.rotation.x = e.pitch;
    this.recoil = Math.max(0, this.recoil - ctx.dt * 12);
    this.gun.position.z = 0.08 * this.recoil;
    this.legPhase += ctx.dt * e.speed * 3;
    this.legs.forEach((l, i) => (l.rotation.x = Math.sin(this.legPhase + i * Math.PI) * 0.5 * Math.min(1, e.speed)));
    this.root.visible = ctx.camPos.distanceTo(this.root.position) < 160;
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}

export { mixCol, col };
