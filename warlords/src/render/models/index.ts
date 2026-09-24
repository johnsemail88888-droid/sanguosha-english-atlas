// Public model factories (used by the gallery / hero select / renderer).
// Unknown ids never throw: they fall back to a kingdom-coloured generic.
import type * as THREE from 'three';
import type { Kingdom } from '../../core/types';
import { HERO_BY_ID, MOUNT_BY_ID, TROOP_BY_ID } from '../../data';
import type { HeroVisual, TroopTypeDef } from '../../data/types';
import { kingdomColor } from '../palette';
import { hashString } from '../core/noise';
import { CharacterRig } from './character';
import { specFromHeroVisual, type CharacterSpec } from './humanoid';
import { buildWeapon } from './weapons';
import type { MountKind } from './mounts';

export { CharacterRig } from './character';
export type { RigUpdate } from './character';
export type { CharacterSpec } from './humanoid';
export { buildWeapon, weaponSpecOf, isAkimbo, weaponMaterial } from './weapons';
export type { HoldStyle, WeaponModel, WeaponModelInfo } from './weapons';
export { MountRig, MOUNT_SCALE, SADDLE_HIP } from './mounts';
export { registerHeroGlb, resolveHeroGlbUrl, GLB_HERO_HEIGHT } from './glb';
export type { MountKind } from './mounts';

const FALLBACK_VISUAL: HeroVisual = {
  skin: '#d9a877',
  hair: '#1a1612',
  primary: '#5a4a3a',
  secondary: '#6a6a6a',
  accent: '#c9a04a',
  headgear: 'helmet',
  beard: 'short',
  body: 'normal',
  extras: ['cape'],
  artPromptEn: '',
};

/**
 * Heroes always use the simulation's 1.8 m hit capsule (sim/physics CHAR_HEIGHT,
 * head sphere centred at 1.58 m), so a 'huge' hero is drawn bulky but not
 * taller than the box: its head must stay where the head shot lands.
 */
const HUGE_HERO_SCALE = 0.93;

/** Character spec for a hero id (kingdom fallback used when the id is unknown). */
export function heroSpec(heroId: string, kingdom?: Kingdom): CharacterSpec {
  const def = HERO_BY_ID[heroId];
  if (def) {
    const spec = specFromHeroVisual(def.visual, kingdomColor(def.kingdom), def.gender === 'female');
    if (def.visual.body === 'huge') spec.scale = HUGE_HERO_SCALE;
    return spec;
  }
  const k = kingdom ?? 'qun';
  const kc = kingdomColor(k);
  return {
    ...specFromHeroVisual({ ...FALLBACK_VISUAL, primary: kc }, kc, false),
    seed: hashString(heroId),
  };
}

export interface TroopLook {
  spec: CharacterSpec;
  mount: MountKind | null;
  /**
   * Uniform scale of the whole rig. Huge foot units (黄巾力士) are 3.2 m tall in
   * the simulation (sim/troops.ts unitSize, head sphere at 2.81 m), so they are
   * drawn as giants whose head sits in that sphere.
   */
  rootScale: number;
}

/** Rig scale that puts a 'huge' humanoid's head (1.645 x 1.1 m unscaled) at the sim's 2.81 m head sphere. */
export const HUGE_UNIT_SCALE = 1.55;

/** Character spec (+ mount) for a troop / NPC type id. */
export function troopLook(troopType: string, kingdom?: Kingdom | 'neutral'): TroopLook {
  const def: TroopTypeDef | undefined = TROOP_BY_ID[troopType];
  const seed = hashString(troopType);
  const skins = ['#d9a877', '#c98f5f', '#e0b48a', '#b9814f'];
  if (def) {
    const kc = kingdomColor(def.kingdom === 'neutral' ? undefined : def.kingdom);
    const vis = def.visual;
    return {
      spec: {
        skin: skins[seed % skins.length],
        face: skins[seed % skins.length],
        hair: '#1a1612',
        primary: vis.primary,
        secondary: vis.secondary,
        accent: def.kingdom === 'neutral' ? '#8a6d3a' : kc,
        kingdom: kc,
        headgear: vis.headgear,
        beard: seed % 3 === 0 ? 'short' : 'none',
        body: vis.body,
        extras: [],
        female: false,
        shield: !!vis.shield,
        scale: vis.body === 'huge' ? 1 : 0.97,
        seed,
      },
      mount: vis.mountedOn ?? null,
      rootScale: vis.body === 'huge' && !vis.mountedOn ? HUGE_UNIT_SCALE : 1,
    };
  }
  // Unknown type: the sim spawns it as a generic 0.4 x 1.8 m rifleman (sim/defs
  // troopDef), so it is drawn on foot at normal size (hit box == silhouette).
  const k = kingdom && kingdom !== 'neutral' ? kingdom : undefined;
  const kc = kingdomColor(k);
  const id = troopType.toLowerCase();
  return {
    spec: {
      skin: skins[seed % skins.length],
      face: skins[seed % skins.length],
      hair: '#1a1612',
      primary: k ? kc : id.includes('turban') ? '#c9a227' : '#7a5a3a',
      secondary: '#5a5550',
      accent: '#8a6d3a',
      kingdom: kc,
      headgear: id.includes('turban') ? 'turban' : id.includes('barbarian') || id.includes('nanman') ? 'featherCrown' : 'helmet',
      beard: 'none',
      body: id.includes('brute') || id.includes('lishi') ? 'heavy' : 'normal',
      extras: id.includes('barbarian') || id.includes('nanman') ? ['bareChest'] : [],
      female: false,
      scale: 0.97,
      seed,
    },
    mount: null,
    rootScale: 1,
  };
}

/** Default warhorse coat (bay). */
export const WARHORSE_COAT = '#6b4a2e';
/** 马超's 西凉 charger (HeroVisual.mount 'horse'): a pale grey. */
export const XILIANG_COAT = '#d8d0c2';
/** 赤兔 (HeroVisual.mount 'redHare'); the chitu mount item's colour when the data has it. */
export const RED_HARE_COAT = '#b3261e';

/** Coat colour for a mount item id (MountDef.color) or a default bay. */
export function mountCoat(mountId: string | undefined): string {
  if (!mountId) return WARHORSE_COAT;
  return MOUNT_BY_ID[mountId]?.color ?? WARHORSE_COAT;
}

/**
 * Coat of the horse a hero is drawn on, or null when on foot. A hero rides
 * when the sim flags it mounted (a mount item is equipped, VF_MOUNTED) or when
 * its HeroVisual.mount says it is always mounted (马超 马术, 吕布 赤兔).
 * Coat: the equipped mount item's colour, else 赤兔 red / 西凉 grey for the
 * innate mounts, else a bay warhorse. Heroes only ever ride horses.
 */
export function heroMountCoat(heroId: string, mountItem: string | undefined, flaggedMounted: boolean): string | null {
  const innate = HERO_BY_ID[heroId]?.visual.mount;
  if (!flaggedMounted && !innate) return null;
  const item = mountItem ? MOUNT_BY_ID[mountItem] : undefined;
  if (item) return item.color;
  if (innate === 'redHare') return MOUNT_BY_ID.chitu?.color ?? RED_HARE_COAT;
  if (innate === 'horse') return XILIANG_COAT;
  return WARHORSE_COAT;
}

/** Procedural hero model (skinned body + signature weapon, riding if the hero is always mounted). `userData.rig` holds the CharacterRig. */
export function createHeroModel(heroId: string): THREE.Object3D {
  const rig = new CharacterRig(heroSpec(heroId));
  const def = HERO_BY_ID[heroId];
  rig.setWeapon(def?.signatureWeapon ?? 'carbine');
  const coat = heroMountCoat(heroId, undefined, false);
  if (coat) rig.setMount('horse', coat, rig.spec.kingdom, '#d8ac4c');
  rig.tryGlbOverride(heroId);
  rig.update(0, 0, { speed: 0, moveX: 0, moveZ: 0, pitch: 0, flags: 0 });
  rig.root.userData.rig = rig;
  rig.root.name = `hero_${heroId}`;
  return rig.root;
}

/** Procedural troop / NPC model (with its mount if any). `userData.rig` holds the CharacterRig. */
export function createTroopModel(troopType: string): THREE.Object3D {
  const look = troopLook(troopType);
  const rig = new CharacterRig(look.spec);
  const def = TROOP_BY_ID[troopType];
  rig.setWeapon(def?.weapon ?? (def?.melee ? 'troop_melee' : 'troop_rifle'));
  rig.root.scale.setScalar(look.rootScale);
  if (look.mount) rig.setMount(look.mount, troopMountCoat(look.mount), look.spec.kingdom, '#d8ac4c');
  rig.update(0, 0, { speed: 0, moveX: 0, moveZ: 0, pitch: 0, flags: 0 });
  rig.root.userData.rig = rig;
  rig.root.name = `troop_${troopType}`;
  return rig.root;
}

/** Coat of a troop / NPC mount. */
export function troopMountCoat(kind: MountKind): string {
  return kind === 'elephant' ? '#8a8580' : '#5a3f2a';
}

/** Procedural weapon mesh (origin at the grip, barrel along −Z). */
export function createWeaponModel(weaponId: string): THREE.Object3D {
  const w = buildWeapon(weaponId);
  w.mesh.userData.weaponInfo = w.info;
  return w.mesh;
}

/** Dispose a model returned by createHeroModel / createTroopModel. */
export function disposeModel(obj: THREE.Object3D): void {
  const rig = obj.userData.rig as CharacterRig | undefined;
  if (rig) rig.dispose();
  else obj.removeFromParent();
}
