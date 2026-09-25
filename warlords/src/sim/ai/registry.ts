// Per-world registry of bot hero brains, so squad brains can consult their
// commander's own knowledge (a bot commander's beliefs are its own seat's
// knowledge — never anyone else's). Keyed by SimApi (WeakMap: no leaks across
// matches, deterministic).
import type { Entity, EntityId } from '../../core/types';
import type { SimApi } from '../api';

/** What a squad brain may ask its bot commander. */
export interface CommanderMind {
  /** 0..1 how much the commander treats hero `e` as a friend */
  allyScore(e: Entity): number;
  /** 0..1 how hostile the commander is toward `e` */
  hostility(e: Entity): number;
  /** would the commander open fire on `e` himself? */
  wouldEngage(e: Entity): boolean;
}

const minds = new WeakMap<SimApi, Map<EntityId, CommanderMind>>();

export function registerMind(sim: SimApi, heroId: EntityId, mind: CommanderMind): void {
  let m = minds.get(sim);
  if (!m) {
    m = new Map();
    minds.set(sim, m);
  }
  m.set(heroId, mind);
}

/** The bot mind commanding `hero`, if it is currently bot-controlled. */
export function mindOf(sim: SimApi, hero: Entity | undefined): CommanderMind | undefined {
  if (!hero?.hero?.isBot) return undefined;
  return minds.get(sim)?.get(hero.id);
}
