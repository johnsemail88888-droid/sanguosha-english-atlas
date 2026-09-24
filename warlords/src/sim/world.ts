// STUB (orchestrator) — SIM-CORE replaces this with the real World.
import type { MapData } from '../core/map';
import type { MatchInit, SimHost } from './host';

export interface CreateMatchOptions {
  /** override the generated map (tests) */
  map?: MapData;
}

export function createMatch(_init: MatchInit, _opts?: CreateMatchOptions): SimHost {
  throw new Error('createMatch: SIM-CORE not implemented yet');
}
