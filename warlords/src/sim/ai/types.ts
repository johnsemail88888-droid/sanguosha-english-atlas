// Small brain interfaces so wave 2 can swap in smarter AI without touching the
// world. Brains only read the world through SimApi (plus SimExt helpers) and
// return an intent; the world validates and executes it (movement, facing,
// range/LOS/cooldown checks for firing).
import type { EntityId } from '../../core/types';
import type { Entity } from '../../core/types';
import type { BotBrain, SimApi } from '../api';

export type { BotBrain } from '../api';

export interface UnitIntent {
  /** world-space desired move direction (normalised, or 0,0 to stand) */
  moveX: number;
  moveZ: number;
  /** multiplier on the unit's base speed (1 = walk, ~1.35 = catch up) */
  speedMul: number;
  /** yaw to face; NaN = face the target / movement direction */
  faceYaw: number;
  /** entity to shoot / strike when possible */
  targetId?: EntityId;
  jump: boolean;
}

export const newIntent = (): UnitIntent => ({ moveX: 0, moveZ: 0, speedMul: 1, faceYaw: NaN, targetId: undefined, jump: false });

export function resetIntent(i: UnitIntent): UnitIntent {
  i.moveX = 0;
  i.moveZ = 0;
  i.speedMul = 1;
  i.faceYaw = NaN;
  i.targetId = undefined;
  i.jump = false;
  return i;
}

/** Brain for commanded soldiers (带兵). */
export interface TroopBrain {
  think(sim: SimApi, self: Entity, dt: number, out: UnitIntent): UnitIntent;
}

/** Brain for neutral / summoned NPCs (黄巾, 南蛮, disbanded troops…). */
export interface NpcBrain {
  think(sim: SimApi, self: Entity, dt: number, out: UnitIntent): UnitIntent;
}

/** Factory for bot hero brains (one instance per bot seat). */
export type BotBrainFactory = (seat: number, difficulty: 'easy' | 'normal' | 'hard', seed: number) => BotBrain;
