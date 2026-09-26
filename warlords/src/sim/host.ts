// The contract between the network/session layer and the simulation.
// sim/world.ts implements SimHost and exports createMatch().
import type { MapData } from '../core/map';
import type {
  EntityId,
  GameEvent,
  GameResult,
  InputFrame,
  MatchSettings,
  PlayerId,
  RoleId,
  Snapshot,
} from '../core/types';

export interface MatchSeatInit {
  seat: number;
  playerId: PlayerId;
  name: string;
  isBot: boolean;
  role: RoleId;
  heroId: string;
  /** 赏金猎人: seat of the secret target */
  bountyTargetSeat?: number;
}

export interface MatchInit {
  settings: MatchSettings;
  seats: MatchSeatInit[];
  /** gameplay RNG seed (map uses settings.mapSeed) */
  seed: number;
}

export interface SimHost {
  readonly tick: number;
  readonly time: number;
  readonly map: MapData;
  /** Advance exactly one fixed tick (SIM_DT) using the latest inputs. */
  step(): void;
  /** Latest input for a human player (bots generate their own). Actions are queued, not overwritten. */
  setInput(playerId: PlayerId, frame: InputFrame): void;
  /** Per-player snapshot (includes that player's private HUD view). */
  snapshotFor(playerId: PlayerId): Snapshot;
  /** Public events produced since the last drain (host fans these out to every client). */
  drainEvents(): GameEvent[];
  result(): GameResult | null;
  entityOf(playerId: PlayerId): EntityId | null;
  /** A human disconnected: a bot brain takes over their hero. */
  convertToBot(playerId: PlayerId): void;
  /** A player reconnected/took over a bot seat. */
  convertToHuman(seat: number, playerId: PlayerId, name: string): void;
}

export type CreateMatch = (init: MatchInit) => SimHost;
