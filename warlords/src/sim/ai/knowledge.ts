// The knowledge gate: the ONLY place in the AI that may look at role data.
// Bots see exactly what a human in their seat would see:
//  - their own role (and, for the 主公, which crown is the 影武者 — knownAllies),
//  - public roles: the crown bearer(s) (lord + 影武者 disguise) and the revealed
//    roles of the dead,
//  - the public role table (player count + mode are shown in the lobby; the dead
//    are revealed), from which the *number* of hidden roles still alive follows,
//  - their own bounty target (赏金猎人, PrivateHeroView.bountyTargetId).
// Everything else (who is a rebel …) is inferred by beliefs.ts from observed
// behaviour. tests/unit/ai/knowledge.test.ts scans the other AI files to make
// sure none of them reads hero.role / sim.roleOf directly.
import type { Entity, EntityId, GameMode, MatchSettings, RoleId } from '../../core/types';
import { ROLE_DISTRIBUTION } from '../../data';
import type { SimApi } from '../api';

/** Roles that can hide behind a face (never the crowns). */
export type HiddenRole = 'loyalist' | 'rebel' | 'traitor' | 'opportunist' | 'bounty';
export const HIDDEN_ROLES: readonly HiddenRole[] = ['loyalist', 'rebel', 'traitor', 'opportunist', 'bounty'];

export type RoleCounts = Record<HiddenRole, number>;

export const zeroCounts = (): RoleCounts => ({ loyalist: 0, rebel: 0, traitor: 0, opportunist: 0, bounty: 0 });

/** This bot's own role (a player always knows their own role card). */
export function ownRole(self: Entity): RoleId {
  return self.hero?.role ?? 'opportunist';
}

/** The bot's own secret bounty target (赏金猎人 only). */
export function ownBountyTarget(self: Entity): EntityId | undefined {
  return self.hero?.role === 'bounty' ? self.hero.bountyTargetId : undefined;
}

/** Role as the world shows it to everyone (crowns, revealed dead). */
export function publicRole(sim: SimApi, e: Entity): RoleId | undefined {
  if (!e.hero) return undefined;
  return sim.knownRole(e);
}

/** A hero wearing a crown (the 主公 or the 影武者 in disguise), alive or not. */
export function wearsCrown(sim: SimApi, e: Entity): boolean {
  if (!e.hero) return false;
  const r = sim.knownRole(e);
  return r === 'lord' || (r === 'double' && e.hero.dead);
}

/**
 * Role of `target` as `viewer` knows it: own role, public roles, and the 主公's
 * knowledge of his 影武者. undefined = hidden to this viewer.
 */
export function roleKnownTo(sim: SimApi, viewer: Entity, target: Entity): RoleId | undefined {
  if (!target.hero) return undefined;
  if (viewer.id === target.id) return ownRole(viewer);
  const pub = sim.knownRole(target);
  if (pub === 'lord' && !target.hero.dead && !target.hero.roleRevealed && ownRole(viewer) === 'lord') {
    // the lord knows which crown is his decoy (PrivateHeroView.knownAllies)
    return sim.roleOf(target) === 'double' ? 'double' : 'lord';
  }
  return pub;
}

/** Alive crown bearers other than `viewer`. */
export function aliveCrowns(sim: SimApi, viewer?: Entity): Entity[] {
  const out: Entity[] = [];
  for (const e of sim.heroes()) {
    if (e === viewer || !e.hero || e.hero.dead) continue;
    if (sim.knownRole(e) === 'lord') out.push(e);
  }
  return out;
}

/**
 * The crown this viewer is sure is the real 主公: the lord himself, the
 * 影武者 (the other crown), or anyone when only one crown is left.
 * undefined when two crowns are alive and the viewer cannot tell them apart.
 */
export function realLordFor(sim: SimApi, viewer: Entity): Entity | undefined {
  const mine = ownRole(viewer);
  if (mine === 'lord') return viewer;
  const crowns = aliveCrowns(sim, viewer);
  if (mine === 'double') return crowns[0];
  if (crowns.length === 1) {
    // one crown left: if the other crown died revealed as 影武者 this is surely the lord;
    // if no 影武者 exists at all, likewise
    return crowns[0];
  }
  return undefined;
}

function settingsOf(sim: SimApi): MatchSettings | undefined {
  // lobby settings are public (player count, mode) — World exposes them read-only
  return (sim as unknown as { settings?: MatchSettings }).settings;
}

const VARIANT_CACHE = new Map<string, RoleId[][]>();

function candidateTables(mode: GameMode | undefined, n: number): RoleId[][] {
  const key = `${mode ?? '*'}:${n}`;
  const hit = VARIANT_CACHE.get(key);
  if (hit) return hit;
  const out: RoleId[][] = [];
  const modes: GameMode[] = mode ? [mode] : ['standard', 'chaos'];
  for (const m of modes) {
    const byN = ROLE_DISTRIBUTION[m] as Record<number, RoleId[][]>;
    const list = byN[n];
    if (list) for (const v of list) out.push(v);
  }
  VARIANT_CACHE.set(key, out);
  return out;
}

export interface TableKnowledge {
  /** expected number of each hidden role among the heroes this viewer cannot see through */
  unknown: RoleCounts;
  /** living heroes whose role this viewer does not know */
  unknownIds: EntityId[];
  /** expected living rebels (incl. known ones) */
  rebelsAlive: number;
  /** expected living loyal side excluding crowns (loyalists) */
  loyalistsAlive: number;
  /** is the traitor possibly still alive? (expected count) */
  traitorAlive: number;
  /** living non-neutral heroes other than the viewer */
  nonNeutralOthersAlive: number;
}

/**
 * Public role-table arithmetic: which roles are still unaccounted for among
 * the living heroes whose role this viewer does not know. Averages over the
 * dealt variants that are consistent with everything public (乱世 modes can
 * have two variants per player count).
 */
export function tableKnowledge(sim: SimApi, viewer: Entity): TableKnowledge {
  const heroes = sim.heroes();
  const n = heroes.length;
  const mine = ownRole(viewer);
  let crownsEver = 0;
  const revealed: RoleId[] = [];
  const unknownIds: EntityId[] = [];
  let knownRebelsAlive = 0;
  let knownLoyalAlive = 0;
  let knownTraitorAlive = 0;
  for (const e of heroes) {
    if (!e.hero) continue;
    const pub = sim.knownRole(e);
    if (pub === 'lord' || pub === 'double') crownsEver++;
    if (e === viewer) continue;
    if (e.hero.dead) {
      if (pub && pub !== 'lord' && pub !== 'double') revealed.push(pub);
      continue;
    }
    const k = roleKnownTo(sim, viewer, e);
    if (k === undefined) unknownIds.push(e.id);
    else if (k === 'rebel') knownRebelsAlive++;
    else if (k === 'loyalist') knownLoyalAlive++;
    else if (k === 'traitor') knownTraitorAlive++;
  }
  const hasDouble = crownsEver >= 2;
  const settings = settingsOf(sim);
  let variants = candidateTables(settings?.mode, n).filter((v) => v.includes('double') === hasDouble && v.includes(mine));
  // revealed dead roles must fit the variant (multiset inclusion, plus our own card)
  variants = variants.filter((v) => {
    const pool = [...v];
    const take = (r: RoleId): boolean => {
      const i = pool.indexOf(r);
      if (i < 0) return false;
      pool.splice(i, 1);
      return true;
    };
    if (!take(mine)) return false;
    for (const r of revealed) if (!take(r)) return false;
    return true;
  });
  const unknown = zeroCounts();
  if (variants.length > 0) {
    for (const v of variants) {
      const pool = zeroCounts();
      for (const r of v) if ((HIDDEN_ROLES as readonly RoleId[]).includes(r)) pool[r as HiddenRole]++;
      if ((HIDDEN_ROLES as readonly RoleId[]).includes(mine)) pool[mine as HiddenRole]--;
      for (const r of revealed) if ((HIDDEN_ROLES as readonly RoleId[]).includes(r)) pool[r as HiddenRole]--;
      pool.rebel -= knownRebelsAlive;
      pool.loyalist -= knownLoyalAlive;
      pool.traitor -= knownTraitorAlive;
      for (const r of HIDDEN_ROLES) unknown[r] += Math.max(0, pool[r]) / variants.length;
    }
  } else {
    // unknown table (custom test setups): a generic split of the unknown heroes
    const u = unknownIds.length;
    unknown.rebel = u * 0.5;
    unknown.loyalist = u * 0.3;
    unknown.traitor = u * 0.2;
  }
  // make the counts sum to the number of unknown heroes (variants are exact; fallback is scaled)
  const sum = HIDDEN_ROLES.reduce((s, r) => s + unknown[r], 0);
  if (sum > 1e-6 && Math.abs(sum - unknownIds.length) > 1e-6) {
    const k = unknownIds.length / sum;
    for (const r of HIDDEN_ROLES) unknown[r] *= k;
  }
  let nonNeutral = 0;
  for (const e of heroes) {
    if (e === viewer || !e.hero || e.hero.dead) continue;
    const k = roleKnownTo(sim, viewer, e);
    if (k === 'opportunist' || k === 'bounty') continue;
    nonNeutral++;
  }
  nonNeutral -= unknown.opportunist + unknown.bounty;
  return {
    unknown,
    unknownIds,
    rebelsAlive: unknown.rebel + knownRebelsAlive + (mine === 'rebel' ? 1 : 0),
    loyalistsAlive: unknown.loyalist + knownLoyalAlive + (mine === 'loyalist' ? 1 : 0),
    traitorAlive: unknown.traitor + knownTraitorAlive + (mine === 'traitor' ? 1 : 0),
    nonNeutralOthersAlive: Math.max(0, nonNeutral),
  };
}
