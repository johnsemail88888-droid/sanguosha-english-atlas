// Pure pre-match flow rules (GAME_SPEC §3–4): role dealing, hero options and
// bot hero choice. No I/O — hostSession.ts drives these.
import type { Rng } from '../core/rng';
import type { GameMode, RoleDealView, RoleId } from '../core/types';
import { ROLE_DISTRIBUTION } from '../data/roles';
import type { HeroDef } from '../data/types';

export type PlayerCount = 5 | 6 | 7 | 8;

export interface RoleDeal {
  /** role per seat index (seats are 0..count-1) */
  roles: RoleId[];
  lordSeat: number;
  /** 影武者 seat (chaos mode), if dealt */
  doubleSeat: number | null;
  /** bounty hunter seat → secret target seat */
  bountyTargets: Record<number, number>;
}

export const clampPlayerCount = (n: number): PlayerCount => Math.min(8, Math.max(5, Math.round(n))) as PlayerCount;

/**
 * Deal roles for `count` seats: a random variant of ROLE_DISTRIBUTION[mode][count]
 * shuffled over the seats (so the lord seat is random). A bounty hunter gets a
 * random target that is neither itself nor a crown bearer.
 */
export function dealRoles(mode: GameMode, count: number, rng: Rng): RoleDeal {
  const n = clampPlayerCount(count);
  const variants = ROLE_DISTRIBUTION[mode]?.[n] ?? ROLE_DISTRIBUTION.standard[n];
  const roles = rng.shuffle([...rng.pick(variants)]);
  const lordSeat = roles.indexOf('lord');
  const doubleIdx = roles.indexOf('double');
  const bountyTargets: Record<number, number> = {};
  roles.forEach((r, seat) => {
    if (r !== 'bounty') return;
    const candidates = roles.map((_, i) => i).filter((i) => i !== seat && roles[i] !== 'lord' && roles[i] !== 'double');
    if (candidates.length > 0) bountyTargets[seat] = rng.pick(candidates);
  });
  return { roles, lordSeat, doubleSeat: doubleIdx >= 0 ? doubleIdx : null, bountyTargets };
}

/** Seats that wear a crown publicly (lord + 影武者). Sorted ascending. */
export const crownSeats = (deal: RoleDeal): number[] =>
  deal.doubleSeat === null ? [deal.lordSeat] : [deal.lordSeat, deal.doubleSeat].sort((a, b) => a - b);

/**
 * What seat `seat` may know about roles. Everyone sees the crowns as 'lord';
 * only the real lord learns which crown is the double.
 */
export function roleDealViewFor(deal: RoleDeal, seat: number): RoleDealView {
  const yourRole = deal.roles[seat];
  const publicRoles: Record<number, RoleId> = { [deal.lordSeat]: 'lord' };
  if (deal.doubleSeat !== null) publicRoles[deal.doubleSeat] = yourRole === 'lord' ? 'double' : 'lord';
  const view: RoleDealView = { yourRole, publicRoles };
  const target = deal.bountyTargets[seat];
  if (target !== undefined) view.bountySeat = target;
  return view;
}

/** `lordSeat` as shown to `seat`: crown bearers see the truth, others the lowest crown seat. */
export function visibleLordSeat(deal: RoleDeal, seat: number): number {
  if (seat === deal.lordSeat || seat === deal.doubleSeat) return deal.lordSeat;
  return crownSeats(deal)[0];
}

// ── hero options ────────────────────────────────────────────────────────────
export type HeroPool = readonly Pick<HeroDef, 'id' | 'lordCandidate'>[];

function takeRandom(pool: string[], n: number, rng: Rng): string[] {
  const copy = rng.shuffle([...pool]);
  return copy.slice(0, Math.max(0, n));
}

/**
 * Options for the crown bearers in the lord phase: every lord candidate plus
 * `extra` random non-candidates. Crown bearers never share their random extras.
 */
export function lordPhaseOptions(pool: HeroPool, seats: readonly number[], extra: number, rng: Rng): Record<number, string[]> {
  const candidates = pool.filter((h) => h.lordCandidate).map((h) => h.id);
  let others = pool.filter((h) => !h.lordCandidate).map((h) => h.id);
  const out: Record<number, string[]> = {};
  for (const seat of seats) {
    const picked = takeRandom(others, extra, rng);
    others = others.filter((id) => !picked.includes(id));
    const opts = [...candidates, ...picked];
    // tiny pools (tests / partial data): top up so the lord always has a choice
    out[seat] = opts.length > 0 ? opts : takeRandom(pool.map((h) => h.id), Math.max(1, extra), rng);
  }
  return out;
}

/**
 * Options for the general phase: `perPlayer` random heroes per seat, unique
 * across seats and excluding `taken`. If the pool is too small, seats receive
 * overlapping options (still excluding taken ones when possible).
 */
export function generalPhaseOptions(
  pool: HeroPool,
  seats: readonly number[],
  perPlayer: number,
  taken: ReadonlySet<string>,
  rng: Rng,
): Record<number, string[]> {
  const n = Math.max(1, perPlayer);
  const free = pool.map((h) => h.id).filter((id) => !taken.has(id));
  let remaining = rng.shuffle([...free]);
  const out: Record<number, string[]> = {};
  for (const seat of seats) {
    let opts = remaining.slice(0, n);
    remaining = remaining.slice(opts.length);
    if (opts.length < n) {
      // pool exhausted: re-use free heroes (duplicates across seats), then anything
      const fallback = rng.shuffle(free.filter((id) => !opts.includes(id)));
      opts = [...opts, ...fallback.slice(0, n - opts.length)];
      if (opts.length === 0) opts = takeRandom(pool.map((h) => h.id), n, rng);
    }
    out[seat] = opts;
  }
  return out;
}

// ── bot choice ──────────────────────────────────────────────────────────────
/** How well a hero suits a role (higher = better). Deterministic given the def. */
export function heroSuitability(hero: HeroDef, role: RoleId): number {
  const hints = hero.abilities.map((a) => a.aiHint);
  const count = (h: string): number => hints.filter((x) => x === h).length;
  const tanky = hero.sgsHp >= 4 ? 1 : 0;
  const easy = (3 - hero.difficulty) * 0.3;
  switch (role) {
    case 'lord':
      return (hero.lordCandidate ? 3 : 0) + tanky * 1.5 + count('defense') + count('summon') * 0.8 + count('heal') * 0.5 + easy;
    case 'double':
      return (hero.lordCandidate ? 2 : 0) + tanky + count('defense') + easy;
    case 'loyalist':
      return count('heal') * 1.5 + count('defense') + count('summon') * 0.7 + count('offense') * 0.5 + easy;
    case 'rebel':
      return count('offense') * 1.5 + count('mobility') + tanky * 0.5 + easy;
    case 'traitor':
      return tanky + count('mobility') * 1.2 + count('heal') + count('defense') * 0.8 + easy;
    case 'opportunist':
    case 'bounty':
      return count('mobility') * 1.2 + count('defense') + count('offense') * 0.8 + easy;
    default:
      return easy;
  }
}

/** Bot pick: the best-suited option with a little randomness. */
export function botPickHero(options: readonly string[], role: RoleId, heroesById: Record<string, HeroDef>, rng: Rng): string {
  if (options.length === 0) throw new Error('botPickHero: no options');
  let best = options[0];
  let bestScore = -Infinity;
  for (const id of options) {
    const def = heroesById[id];
    const score = (def ? heroSuitability(def, role) : 0) + rng.next() * 1.5;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}
