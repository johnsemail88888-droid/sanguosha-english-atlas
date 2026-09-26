// Registry of every one-shot sound: recipe, mixing bus, default priority,
// spatial profile, throttle group and level. Also resolves free-form names
// from `{ t: 'sfx', name }` sim events.
import { GUN_SOUNDS, ITEM_SOUNDS } from './classify';
import type { SpatialProfileId } from './spatial';
import type { Recipe } from './recipes/types';
import { casing, dryFire, flyby, gun, reload, RELOAD_PARTS } from './recipes/weapons';
import {
  abilityCast,
  airdropThud,
  arc,
  bigCymbal,
  clang,
  claim,
  command,
  COMMAND_VARIANTS,
  crateOpen,
  deathGong,
  dodge,
  downed,
  drum,
  explosion,
  EXPLOSION_VARIANTS,
  footstep,
  FOOTSTEP_VARIANTS,
  gongHit,
  heal,
  heartbeat,
  hurt,
  impact,
  IMPACT_VARIANTS,
  itemUse,
  killConfirm,
  KINGDOM_VARIANTS,
  lightning,
  pickup,
  PICKUP_VARIANTS,
  plane,
  revive,
  reward,
  rimHit,
  shieldDown,
  shieldUp,
  splash,
  status,
  STATUS_VARIANTS,
  tinnitus,
  unitDeath,
  zoneHorn,
  zoneTick,
} from './recipes/world';
import { announce, chat, headshot, hitmarker, ui, UI_SOUNDS } from './recipes/ui';

export type Bus = 'world' | 'ui';

export interface SfxDef {
  recipe: Recipe;
  bus: Bus;
  /** voice-stealing priority (higher survives) */
  priority: number;
  /** distance behaviour when played with a position */
  profile: SpatialProfileId;
  /** base level */
  gain: number;
  /** throttle group; `${group}:${variant}` when `groupByVariant` */
  group: string;
  groupByVariant?: boolean;
  /** random pitch spread (± fraction) */
  pitchJitter: number;
  /** variants shown on the dev page */
  variants?: readonly string[];
}

const def = (d: Partial<SfxDef> & Pick<SfxDef, 'recipe'>): SfxDef => ({
  bus: 'world',
  priority: 2,
  profile: 'medium',
  gain: 1,
  group: 'misc',
  pitchJitter: 0.03,
  ...d,
});

export const SFX = {
  gun: def({ recipe: gun, profile: 'gun', gain: 0.95, group: 'gun', groupByVariant: true, pitchJitter: 0.04, variants: GUN_SOUNDS }),
  reload: def({ recipe: reload, profile: 'quiet', gain: 0.7, group: 'reload', variants: RELOAD_PARTS }),
  dryFire: def({ recipe: dryFire, profile: 'quiet', gain: 0.9, group: 'dry' }),
  casing: def({ recipe: casing, profile: 'quiet', gain: 0.35, group: 'casing', priority: 0, pitchJitter: 0.08 }),
  flyby: def({ recipe: flyby, profile: 'quiet', gain: 0.55, group: 'flyby', priority: 2, pitchJitter: 0.1 }),
  impact: def({ recipe: impact, profile: 'impact', gain: 0.6, group: 'impact', priority: 1, pitchJitter: 0.08, variants: IMPACT_VARIANTS }),
  explosion: def({ recipe: explosion, profile: 'loud', gain: 1, group: 'explosion', priority: 3, pitchJitter: 0.05, variants: EXPLOSION_VARIANTS }),
  lightning: def({ recipe: lightning, profile: 'loud', gain: 0.95, group: 'lightning', priority: 3 }),
  arc: def({ recipe: arc, profile: 'medium', gain: 0.8, group: 'zap', priority: 2, pitchJitter: 0.08 }),
  heal: def({ recipe: heal, profile: 'medium', gain: 0.55, group: 'heal', pitchJitter: 0 }),
  revive: def({ recipe: revive, profile: 'medium', gain: 0.6, group: 'heal', priority: 3, pitchJitter: 0 }),
  shieldUp: def({ recipe: shieldUp, profile: 'medium', gain: 0.55, group: 'status' }),
  shieldDown: def({ recipe: shieldDown, profile: 'medium', gain: 0.5, group: 'status' }),
  dodge: def({ recipe: dodge, profile: 'quiet', gain: 0.5, group: 'status' }),
  footstep: def({ recipe: footstep, profile: 'steps', gain: 0.9, group: 'footstep', priority: 0, pitchJitter: 0.07, variants: FOOTSTEP_VARIANTS }),
  crateOpen: def({ recipe: crateOpen, profile: 'medium', gain: 0.55, group: 'misc', variants: ['1', '2', '3'] }),
  pickup: def({ recipe: pickup, profile: 'quiet', gain: 0.9, group: 'misc', variants: PICKUP_VARIANTS }),
  itemUse: def({ recipe: itemUse, profile: 'medium', gain: 0.8, group: 'misc', variants: ITEM_SOUNDS }),
  abilityCast: def({ recipe: abilityCast, profile: 'medium', gain: 0.6, group: 'ability', priority: 3, pitchJitter: 0, variants: KINGDOM_VARIANTS }),
  downed: def({ recipe: downed, profile: 'medium', gain: 0.6, group: 'big', priority: 3, pitchJitter: 0 }),
  deathGong: def({ recipe: deathGong, bus: 'ui', gain: 0.55, group: 'big', priority: 4, pitchJitter: 0 }),
  unitDeath: def({ recipe: unitDeath, profile: 'medium', gain: 0.45, group: 'misc', priority: 1, pitchJitter: 0.1 }),
  killConfirm: def({ recipe: killConfirm, bus: 'ui', gain: 1, group: 'headshot', priority: 4, pitchJitter: 0 }),
  zoneHorn: def({ recipe: zoneHorn, bus: 'ui', gain: 0.55, group: 'big', priority: 4, pitchJitter: 0 }),
  plane: def({ recipe: plane, profile: 'aircraft', gain: 0.33, group: 'big', priority: 3, pitchJitter: 0 }),
  airdropThud: def({ recipe: airdropThud, profile: 'loud', gain: 0.8, group: 'big', priority: 3 }),
  status: def({ recipe: status, profile: 'medium', gain: 0.5, group: 'status', variants: STATUS_VARIANTS }),
  reward: def({ recipe: reward, bus: 'ui', gain: 0.55, group: 'big', priority: 4, pitchJitter: 0, variants: ['reward', 'penalty'] }),
  claim: def({ recipe: claim, bus: 'ui', gain: 0.6, group: 'ui', priority: 3, pitchJitter: 0.04 }),
  hurt: def({ recipe: hurt, gain: 0.6, group: 'hurt', priority: 4, pitchJitter: 0.06 }),
  heartbeat: def({ recipe: heartbeat, bus: 'ui', gain: 0.55, group: 'ui', priority: 5, pitchJitter: 0 }),
  tinnitus: def({ recipe: tinnitus, bus: 'ui', gain: 1, group: 'ui', priority: 4, pitchJitter: 0 }),
  zoneTick: def({ recipe: zoneTick, gain: 0.4, group: 'hurt', priority: 3 }),
  splash: def({ recipe: splash, profile: 'impact', gain: 0.5, group: 'impact' }),
  clang: def({ recipe: clang, profile: 'impact', gain: 0.5, group: 'impact' }),
  drum: def({ recipe: drum, profile: 'loud', gain: 1, group: 'misc' }),
  gong: def({ recipe: gongHit, profile: 'loud', gain: 0.6, group: 'big', pitchJitter: 0 }),
  cymbal: def({ recipe: bigCymbal, profile: 'medium', gain: 0.5, group: 'misc' }),
  rim: def({ recipe: rimHit, profile: 'medium', gain: 0.5, group: 'misc' }),
  command: def({ recipe: command, bus: 'ui', gain: 0.7, group: 'ui', priority: 4, pitchJitter: 0, variants: COMMAND_VARIANTS }),
  ui: def({ recipe: ui, bus: 'ui', gain: 1, group: 'ui', groupByVariant: true, priority: 5, pitchJitter: 0.01, variants: UI_SOUNDS }),
  headshot: def({ recipe: headshot, bus: 'ui', gain: 0.9, group: 'headshot', priority: 4, pitchJitter: 0.02 }),
  hitmarker: def({ recipe: hitmarker, bus: 'ui', gain: 0.8, group: 'hitmarker', priority: 4, pitchJitter: 0.05 }),
  chat: def({ recipe: chat, bus: 'ui', gain: 0.8, group: 'ui', priority: 3, pitchJitter: 0 }),
  announce: def({ recipe: announce, bus: 'ui', gain: 0.45, group: 'big', priority: 4, pitchJitter: 0, variants: ['big', 'warn'] }),
} satisfies Record<string, SfxDef>;

export type SfxName = keyof typeof SFX;

export const SFX_NAMES = Object.keys(SFX) as SfxName[];

export function isSfxName(s: string): s is SfxName {
  return Object.prototype.hasOwnProperty.call(SFX, s);
}

const ALIASES: Record<string, { name: SfxName; variant?: string }> = {
  crateopen: { name: 'crateOpen' },
  open: { name: 'crateOpen' },
  chest: { name: 'crateOpen' },
  reload: { name: 'reload', variant: 'in' },
  dryfire: { name: 'dryFire' },
  empty: { name: 'dryFire' },
  thunder: { name: 'lightning' },
  lightning: { name: 'lightning' },
  bolt: { name: 'lightning' },
  horn: { name: 'zoneHorn' },
  zone: { name: 'zoneHorn' },
  gong: { name: 'gong' },
  drum: { name: 'drum' },
  splash: { name: 'splash' },
  water: { name: 'splash' },
  jump: { name: 'footstep', variant: 'jump' },
  land: { name: 'footstep', variant: 'land' },
  step: { name: 'footstep', variant: 'dirt' },
  dodge: { name: 'dodge' },
  roll: { name: 'dodge' },
  heal: { name: 'heal' },
  revive: { name: 'revive' },
  shield: { name: 'shieldUp' },
  shieldbreak: { name: 'shieldDown' },
  explosion: { name: 'explosion', variant: 'frag' },
  explode: { name: 'explosion', variant: 'frag' },
  boom: { name: 'explosion', variant: 'frag' },
  fire: { name: 'explosion', variant: 'fire' },
  ice: { name: 'explosion', variant: 'ice' },
  whoosh: { name: 'dodge' },
  swing: { name: 'gun', variant: 'melee' },
  slash: { name: 'gun', variant: 'melee' },
  bell: { name: 'ui', variant: 'confirm' },
  chime: { name: 'heal' },
  clang: { name: 'clang' },
  metal: { name: 'clang' },
  thud: { name: 'footstep', variant: 'land' },
  stomp: { name: 'footstep', variant: 'stomp' },
  trample: { name: 'footstep', variant: 'stomp' },
  trap: { name: 'itemUse', variant: 'trap' },
  summon: { name: 'itemUse', variant: 'summon' },
  recruit: { name: 'itemUse', variant: 'recruit' },
  arrows: { name: 'itemUse', variant: 'arrows' },
  cymbal: { name: 'cymbal' },
  airdrop: { name: 'airdropThud' },
  airdropland: { name: 'airdropThud' },
  landing: { name: 'airdropThud' },
  zap: { name: 'arc' },
  chainlightning: { name: 'arc' },
  pickup: { name: 'pickup', variant: 'item' },
  reward: { name: 'reward', variant: 'reward' },
  stun: { name: 'status', variant: 'stun' },
  charm: { name: 'status', variant: 'charm' },
  dance: { name: 'status', variant: 'dance' },
  // a card / ability that could not be used (no target under the crosshair…): private to the user
  itemdenied: { name: 'ui', variant: 'error' },
  abilitydenied: { name: 'ui', variant: 'error' },
  denied: { name: 'ui', variant: 'error' },
};

/**
 * Resolve a sim `sfx` event name ("crate_open", "thunder", "impact:metal",
 * "gun:shotgun", "explosion.ice", ...) to a catalog entry + variant.
 */
export function resolveSfxName(raw: string): { name: SfxName; variant: string } | null {
  if (!raw) return null;
  const [head, tail] = raw.split(/[:./]/, 2);
  if (isSfxName(head)) return { name: head, variant: tail ?? '' };
  const key = head.toLowerCase().replace(/[^a-z]/g, '');
  const al = ALIASES[key];
  if (al) return { name: al.name, variant: tail ?? al.variant ?? '' };
  // case-insensitive direct match
  const direct = SFX_NAMES.find((n) => n.toLowerCase() === key);
  if (direct) return { name: direct, variant: tail ?? '' };
  return null;
}
