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
import { hasStatusFrom } from './status';
import type { World } from './world';

const FOCUS_MEMORY = 4;

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
  // (a) damage memory
  if (
    w.attackedRecently(ca.id, b.id) ||
    w.attackedRecently(ca.id, bRoot.id) ||
    w.attackedRecently(a.id, b.id) ||
    w.attackedRecently(a.id, bRoot.id)
  ) {
    return true;
  }
  // (b) commander focus / order / mark
  const focus = w.focusOf(ca.id);
  if (focus.id !== undefined && now - focus.at <= FOCUS_MEMORY && (focus.id === b.id || (b.kind === 'hero' && focus.id === bRoot.id && bRoot === b))) return true;
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
