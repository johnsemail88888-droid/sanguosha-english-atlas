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
export { MountRig } from './mounts';
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

/** Character spec for a hero id (kingdom fallback used when the id is unknown). */
export function heroSpec(heroId: string, kingdom?: Kingdom): CharacterSpec {
  const def = HERO_BY_ID[heroId];
  if (def) return specFromHeroVisual(def.visual, kingdomColor(def.kingdom), def.gender === 'female');
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
}

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
    };
  }
  const k = kingdom && kingdom !== 'neutral' ? kingdom : undefined;
  const kc = kingdomColor(k);
  const id = troopType.toLowerCase();
  const elephant = id.includes('elephant');
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
      body: id.includes('brute') || id.includes('lishi') ? 'huge' : 'normal',
      extras: id.includes('barbarian') || id.includes('nanman') ? ['bareChest'] : [],
      female: false,
      scale: 0.97,
      seed,
    },
    mount: elephant ? 'elephant' : id.includes('cavalry') || id.includes('rider') ? 'horse' : null,
  };
}

/** Coat colour for a mount item id (MountDef.color) or a default bay. */
export function mountCoat(mountId: string | undefined): string {
  if (!mountId) return '#6b4a2e';
  const def = MOUNT_BY_ID[mountId];
  if (def) return def.color;
  return '#6b4a2e';
}

/** Procedural hero model (skinned body + signature weapon). `userData.rig` holds the CharacterRig. */
export function createHeroModel(heroId: string): THREE.Object3D {
  const rig = new CharacterRig(heroSpec(heroId));
  const def = HERO_BY_ID[heroId];
  rig.setWeapon(def?.signatureWeapon ?? 'carbine');
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
  if (look.mount) rig.setMount(look.mount, look.mount === 'elephant' ? '#8a8580' : '#5a3f2a', look.spec.kingdom, '#d8ac4c');
  rig.update(0, 0, { speed: 0, moveX: 0, moveZ: 0, pitch: 0, flags: 0 });
  rig.root.userData.rig = rig;
  rig.root.name = `troop_${troopType}`;
  return rig.root;
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
