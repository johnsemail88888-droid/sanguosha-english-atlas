// Default bot hero brain factory used by the world (World.botFactory default).
// Wave 2: delegates to the role-aware HeroBot (heroBot.ts). The export names
// stay the same so the engine needs no change.
import type { BotDifficulty } from '../../core/types';
import type { BotBrain } from '../api';
import { HeroBot } from './heroBot';

export { HeroBot as BasicBot } from './heroBot';

/** Default BotBrainFactory: one role-aware HeroBot per bot seat. */
export function createBasicBot(seat: number, difficulty: BotDifficulty, seed: number): BotBrain {
  return new HeroBot(seat, difficulty, seed);
}
