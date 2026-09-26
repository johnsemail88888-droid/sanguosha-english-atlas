// Identity-aware hostility (GAME_SPEC §8). Troops, turrets, NPCs and bot AI
// only fight units they have a *reason* to fight, which preserves the hidden
// role tension:
//  (a) anyone who damaged the commander or the unit itself in the last 10 s
//      (or whose commander did),
//  (b) whatever the commander is shooting at / has marked / ordered to attack,
//  (c) NPCs that are aggroed on the commander's side,
//  (d) heroes whose *known* role is hostile to the commander's role.
// Neutral NPCs (黄巾 camps) attack heroes/troops in range; summoned NPCs attack
// everything that is not on their summoner's side (except npcImmune heroes).
import type { Entity, RoleId } from '../core/types';
import { findStatus, hasStatusFrom } from './status';
import type { World } from './world';

const FOCUS_MEMORY = 4;
/**
 * Damage a commander must have dealt a hero on his side (the public lord, a 忠-claimer…) by his
 * own hand lately (World.heroHarm, 3 s half-life) before his soldiers join in: ~4 carbine hits.
 */
export const SUSTAINED_HARM = 90;
/**
 * The opening (s): heroes are still spreading out and looting. Soldiers only join a fight with
 * another hero's side when one of the two heroes has actually hit the other by hand (World.heroHarm:
 * not a burning field he walked into, not a burn, not soldiers trading shots, not a miss) — a camp
 * napalm's burning ground used to start squad wars that ended in a hero death inside the first
 * minute (C3-5).
 */
export const OPENING_CALM = 60;
const OPENING_PROVOKE = 0.5;
const LORD_SIDE: ReadonlySet<RoleId> = new Set<RoleId>(['lord', 'loyalist', 'double']);

/** Role of `target` as `viewer` knows it (undefined viewer = public knowledge). */
export function knownRoleFor(w: World, viewer: Entity | undefined, target: Entity): RoleId | undefined {
  const h = target.hero;
  if (!h) return undefined;
  if (viewer && viewer.id === target.id) return h.role;
  if (h.roleRevealed || h.dead) return h.role;
  if (h.role === 'lord') return 'lord';
  if (h.role === 'double') return viewer?.hero?.role === 'lord' ? 'double' : 'lord';
  void w;
  return undefined;
}

/** Does `mine` (a commander role) consider the known role `theirs` an enemy? */
export function rolesHostile(mine: RoleId, theirs: RoleId): boolean {
  switch (mine) {
    case 'lord':
    case 'loyalist':
    case 'double':
      return theirs === 'rebel' || theirs === 'traitor';
    case 'rebel':
      return theirs === 'lord' || theirs === 'loyalist' || theirs === 'double';
    default:
      return false; // traitor / neutrals pick fights through (a)/(b) only
  }
}

function npcImmune(w: World, npc: Entity, target: Entity): boolean {
  const cmd = w.commanderOf(target);
  const type = npc.npc?.npcType;
  if (!cmd || !type) return false;
  return w.modifiers(cmd.id).npcImmune.includes(type);
}

/** Is hero `x` charmed (离间 / 反间) onto `y` or onto one of `y`'s units right now? */
function charmedOnto(w: World, x: Entity, y: Entity): boolean {
  if (x.statuses.length === 0) return false;
  const t = findStatus(x, 'charm', w.time)?.params?.targetId;
  return t !== undefined && (t === y.id || w.creditOf(t) === y.id);
}

/**
 * Are commanders `x` and `y` locked in a charm duel right now — one forced onto the other (or
 * onto one of the other's units) by 离间 / 反间? Neither the hits nor the aim of that fight are
 * anyone's intent, so their troops and turrets sit it out (C3-1: both squads used to join and
 * double-kill human victims, and kept fighting after the charm).
 */
export function charmBound(w: World, x: Entity, y: Entity): boolean {
  return charmedOnto(w, x, y) || charmedOnto(w, y, x);
}

/**
 * Is hero `b` on commander `ca`'s side as far as `ca` can tell: 'lord' = the public lord (for
 * anyone but a rebel), 'ally' = a revealed or 忠-claiming lord-side hero for a lord-side
 * commander, a revealed or 反-claiming rebel for a rebel; null = not. One stray hit between them
 * is no war (C3-3): their soldiers only join on sustained fire (SUSTAINED_HARM), a mark or an
 * order — else a human loyalist's squad turned on the bot lord after a single pistol shot and
 * got him executed.
 */
export function onSideOf(w: World, ca: Entity, b: Entity): 'lord' | 'ally' | null {
  const mine = ca.hero?.role;
  const h = b.hero;
  if (!mine || !h || b === ca || h.dead) return null;
  const known = knownRoleFor(w, ca, b);
  if (known === 'lord' || (known === 'double' && mine === 'lord')) return mine === 'rebel' ? null : 'lord';
  const theirs = known ?? h.claim ?? undefined;
  if (!theirs) return null;
  return (LORD_SIDE.has(mine) && LORD_SIDE.has(theirs)) || (mine === 'rebel' && theirs === 'rebel') ? 'ally' : null;
}

/**
 * Must a unit of commander `ca` leave `bRoot` (a hero on his side, onSideOf) alone although it was
 * hit / aimed at? Yes unless `ca` himself fired at it in earnest — or, for anyone but the public
 * lord, it has been pressing `ca` hard (a claimed ally shooting us for real is no ally).
 */
function spareSide(w: World, ca: Entity, bRoot: Entity): boolean {
  const side = onSideOf(w, ca, bRoot);
  if (!side || w.heroHarm(ca.id, bRoot.id) >= SUSTAINED_HARM) return false;
  return side === 'lord' || w.heroHarm(bRoot.id, ca.id) < SUSTAINED_HARM;
}

/** Opening minute: `ca`'s soldiers leave hero `bRoot`'s side alone unless one of them attacked the other by hand. */
function openingCalm(w: World, ca: Entity, bRoot: Entity): boolean {
  if (w.time >= OPENING_CALM || !bRoot.hero || bRoot === ca) return false;
  return w.heroHarm(bRoot.id, ca.id) < OPENING_PROVOKE && w.heroHarm(ca.id, bRoot.id) < OPENING_PROVOKE;
}

export function isHostile(w: World, a: Entity, b: Entity): boolean {
  if (a === b || !b.alive || b.hero?.dead) return false;
  if (b.kind !== 'hero' && b.kind !== 'troop' && b.kind !== 'npc' && b.kind !== 'turret') return false;
  if (w.isOwnSide(a, b)) return false;
  const now = w.time;
  const ca = w.commanderOf(a);
  const cb = w.commanderOf(b);

  // ── NPC perspective ──
  if (a.kind === 'npc' && a.npc) {
    if (npcImmune(w, a, b)) return false;
    if (a.npc.summonerId !== undefined) return true; // summons attack everything not on their side
    if ((a.npc.ai.flee ?? 0) > 0) return w.attackedRecently(a.id, b.id) || (cb !== undefined && w.attackedRecently(a.id, cb.id));
    if (b.kind === 'npc') return w.attackedRecently(a.id, b.id);
    return true; // wild bandits attack any hero / troop / turret they can see
  }
  if (!ca) return w.attackedRecently(a.id, b.id);

  const bRoot = cb ?? b;
  // a unit ignores the hits and aim between its commander and `b`'s side when they are a charm duel
  // (C3-1), a graze between heroes on one side (C3-3) or an opening scuffle (C3-5) — orders, marks
  // and known roles still count
  const ignoreFight = a !== ca && (charmBound(w, ca, bRoot) || spareSide(w, ca, bRoot) || openingCalm(w, ca, bRoot));
  // (a) damage memory
  if (
    !ignoreFight &&
    (w.attackedRecently(ca.id, b.id) ||
      w.attackedRecently(ca.id, bRoot.id) ||
      w.attackedRecently(a.id, b.id) ||
      w.attackedRecently(a.id, bRoot.id))
  ) {
    return true;
  }
  // (b) commander focus / order / mark
  const focus = w.focusOf(ca.id);
  if (!ignoreFight && focus.id !== undefined && now - focus.at <= FOCUS_MEMORY && (focus.id === b.id || (b.kind === 'hero' && focus.id === bRoot.id && bRoot === b))) return true;
  const order = ca.hero?.order;
  if (order && order.kind === 'attack' && order.targetId === b.id) return true;
  if (b.statuses.length > 0 && hasStatusFrom(b, 'marked', ca.id, now)) return true;
  // (c) aggroed NPCs
  if (b.kind === 'npc' && b.npc) {
    const t = b.npc.targetId;
    if (t !== undefined && (t === a.id || t === ca.id || w.creditOf(t) === ca.id)) return true;
    if (b.npc.summonerId !== undefined && !w.isOwnSide(ca, b)) {
      // hostile summons coming at us
      if (t !== undefined && w.creditOf(t) === ca.id) return true;
    }
  }
  // (d) known roles
  if (bRoot.hero && ca.hero) {
    const theirs = knownRoleFor(w, ca, bRoot);
    if (theirs && rolesHostile(ca.hero.role, theirs)) return true;
  }
  return false;
}
