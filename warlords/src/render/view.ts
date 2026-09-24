// What the renderer, HUD and audio read each frame. Two implementations:
//  - host / single player: reads the local SimHost directly (net/localView.ts)
//  - remote client: interpolated snapshots + local prediction (net/clientView.ts)
import type { MapData } from '../core/map';
import type {
  EntityId,
  GameEvent,
  GameResult,
  InputFrame,
  PrivateHeroView,
  PublicPlayerView,
  ViewEntity,
  ZoneView,
} from '../core/types';

export interface ViewSource {
  readonly map: MapData;
  /** Call once per render frame before reading; dt = real seconds since last frame. */
  update(dt: number): void;
  /** Entities to draw this frame (already interpolated / predicted). */
  entities(): readonly ViewEntity[];
  get(id: EntityId): ViewEntity | undefined;
  /** The local player's hero entity id (null when spectating before spawn). */
  localId(): EntityId | null;
  /** Private HUD state for the local player. */
  local(): PrivateHeroView | null;
  zone(): ZoneView;
  players(): readonly PublicPlayerView[];
  /** Events since last call (VFX / audio / kill feed consume these). */
  drainEvents(): GameEvent[];
  /** Host tick currently being displayed (sent back as InputFrame.viewTick). */
  viewTick(): number;
  /** Seconds since match start. */
  elapsed(): number;
  result(): GameResult | null;
  /** Local player's input for this frame (the source forwards it to the host / applies prediction). */
  pushInput(frame: InputFrame): void;
}
