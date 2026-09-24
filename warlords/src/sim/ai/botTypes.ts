// Shared view of a bot's situation, handed from the hero brain to its helper
// modules (strategy, abilities, items). Everything in it was perceived fairly.
import type { Vec3 } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { Entity, EntityId, RoleId } from '../../core/types';
import type { WeaponDef } from '../../data/types';
import type { SimApi } from '../api';
import type { SimExt } from '../ext';
import type { Beliefs } from './beliefs';
import type { DifficultyProfile } from './difficulty';
import type { WorldObserver } from './observer';

export interface Threat {
  e: Entity;
  /** 0..1 how hostile this bot considers the unit */
  hostility: number;
  /** target priority */
  score: number;
  dist: number;
  los: boolean;
}

export type BotMode =
  | 'fight'
  | 'retreat'
  | 'heal'
  | 'revive'
  | 'loot'
  | 'zone'
  | 'escort'
  | 'guard'
  | 'hunt'
  | 'regroup'
  | 'shadow'
  | 'hide'
  | 'wander';

export interface BotView {
  readonly sim: SimApi;
  readonly x: SimExt;
  readonly self: Entity;
  readonly now: number;
  readonly prof: DifficultyProfile;
  readonly rng: Rng;
  readonly role: RoleId;
  readonly beliefs: Beliefs;
  readonly obs: WorldObserver;
  /** current combat target (may be out of LOS) */
  readonly target: Entity | undefined;
  readonly targetDist: number;
  readonly targetLos: boolean;
  /** hostile units noticed at the last scan, best first */
  readonly threats: readonly Threat[];
  /** HP fraction lost during the last 2 s */
  readonly underFire: number;
  /** sim time the bot last lost HP */
  readonly lastHurtAt: number;
  readonly weapon: WeaponDef | undefined;
  readonly mode: BotMode;
  hostility(e: Entity): number;
  /** 0..1 how much this bot treats `e` (a hero) as an ally */
  allyScore(e: Entity): number;
  /** believed allied heroes (alive, not downed unless asked) */
  allies(includeDowned?: boolean): Entity[];
  /** position this bot wants to be at for the zone (null = already fine) */
  zoneGoal(): Vec3 | null;
}

export interface AbilityPlan {
  slot: 'q' | 'e' | 'lord';
  abilityId: string;
  yaw?: number;
  pitch?: number;
  aimPoint?: Vec3;
  aimTargetId?: EntityId;
}

export interface ItemPlan {
  slot: number;
  itemId: string;
  aimPoint?: Vec3;
  aimTargetId?: EntityId;
  yaw?: number;
  pitch?: number;
}
