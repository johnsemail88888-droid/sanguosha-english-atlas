import type { EntityId, PrivateHeroView, PublicPlayerView, ViewEntity, ZoneView } from '../../core/types';

/** Everything a HUD widget needs for one animation frame (read once from the ViewSource). */
export interface HudFrame {
  /** performance.now() in seconds */
  now: number;
  dt: number;
  /** match clock (ViewSource.elapsed) */
  elapsed: number;
  me: PrivateHeroView | null;
  myEnt: ViewEntity | undefined;
  /** entity the camera follows: you, or the spectate target when dead */
  focus: ViewEntity | undefined;
  spectateId: EntityId | null;
  ents: readonly ViewEntity[];
  zone: ZoneView;
  players: readonly PublicPlayerView[];
  lang: 'zh' | 'en';
  touch: boolean;
}
