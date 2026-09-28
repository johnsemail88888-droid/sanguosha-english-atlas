// 身份局 rules (GAME_SPEC §4): 濒死 / revive / death, role reveal, rewards
// and penalties, bounty targets, win conditions, MVP.
import type { Entity, EntityId, Faction, GameResult, RoleId } from '../core/types';
import { ROLE_BY_ID } from '../data';
import { clearStatuses } from './status';
import type { World } from './world';

/**
 * Bleed-out of the 1st, 2nd and every later knock in one life (s): long enough for a teammate to
 * come with a 桃 (PUBG / Apex), shorter each time so a hero cannot be knocked and picked up forever.
 */
export const BLEED_OUT_TIMES: readonly number[] = [30, 20, 12];
/** A first knock's bleed-out (s). */
export const BLEED_OUT_TIME = BLEED_OUT_TIMES[0];
/** Bleed-out of knock number `knocks` (0 = the first) in this life. */
export function bleedOutTime(knocks: number): number {
  const i = Math.max(0, Math.min(BLEED_OUT_TIMES.length - 1, Math.floor(knocks) || 0));
  return BLEED_OUT_TIMES[i];
}
/** Damage that finishes a fresh knock, however long its bleed-out: hits drain it in proportion (combat.ts). */
export const DOWNED_FINISH_DAMAGE = 150;
/** Bleed-out seconds one point of damage takes off this downed hero. */
export function downedDrain(h: { downedTotal?: number }): number {
  return (h.downedTotal ?? BLEED_OUT_TIME) / DOWNED_FINISH_DAMAGE;
}
/** 战场急救: a soldier bandages his downed commander this long (s)… */
export const SQUAD_AID_TIME = 5;
/** …and gets him up with this much HP (the soldier is spent). */
export const SQUAD_AID_HP = 60;
/** A soldier this close (m) to his downed commander starts bandaging… */
export const SQUAD_AID_REACH = 1.9;
/** …while no hero hostile to the commander stands within this distance (m) of him. */
export const SQUAD_AID_CLEAR = 12;
/** 招魂: a dead hero's 魂幡 stands at his body this long (s)… */
export const SOUL_TIME = 60;
/** …anyone holding F there this long (s) calls him back… */
export const RECALL_TIME = 5;
/** …with this much HP and no squad, once per match. */
export const RECALL_HP = 150;
/** spawn protection after a 招魂 (s) */
const RECALL_INVULN = 2;
export const REVIVE_TIME = 1.5;
export const REVIVE_HP = 100;
export const SQUAD_DISBAND_TIME = 20;
/** 15:00 hard cap: the final zone collapses */
export const HARD_CAP_TIME = 900;
/** absolute failsafe: declare a draw if nobody could be eliminated */
export const FAILSAFE_TIME = HARD_CAP_TIME + 120;
const REBEL_REWARD_ITEMS = 3;
const BOUNTY_REWARD_ITEMS = 2;

export const factionOf = (role: RoleId): Faction => ROLE_BY_ID[role]?.faction ?? 'neutral';

// ── 濒死 (downed) ────────────────────────────────────────────────────────────
export function downHero(w: World, e: Entity, creditId: EntityId | undefined, sourceId: EntityId | undefined): void {
  const h = e.hero;
  if (!h || h.dead || h.downed) return;
  // self-saves (孟获 再起 …)
  if (w.hooks.onDowned(e)) {
    if (e.hp <= 0) e.hp = 1;
    return;
  }
  const rt = w.heroRt(e.id);
  // every knock in one life bleeds out faster (30 → 20 → 12 s)
  const total = bleedOutTime(rt?.knocks ?? 0);
  if (rt) rt.knocks = (rt.knocks ?? 0) + 1;
  h.downed = true;
  h.downedTotal = total;
  h.downedUntil = w.time + total;
  e.hp = 0;
  e.shield = 0;
  h.ads = false;
  h.sprinting = false;
  h.reloadUntil = 0;
  h.burst = 0;
  e.forced = undefined;
  w.cancelChannel(e.id);
  w.removeStatus(e.id, 'shield');
  if (rt) {
    rt.downedBy = creditId;
    rt.downedBySource = sourceId;
    const by = creditId !== undefined ? w.get(creditId) : undefined;
    rt.downedDirect = by?.hero ? w.isDirectSource(sourceId, by) : true;
  }
  w.emit({ t: 'downed', target: e.id, src: creditId });
  w.hooks.onOtherDowned(e);
}

export function reviveHero(w: World, e: Entity, hp: number, byId: EntityId | undefined, squad = false): boolean {
  const h = e.hero;
  if (!h || h.dead || !h.downed) return false;
  h.downed = false;
  h.downedUntil = 0;
  h.downedTotal = undefined;
  h.rescue = undefined;
  e.hp = Math.max(1, Math.min(e.maxHp, hp));
  w.emit(squad ? { t: 'revived', target: e.id, by: byId, squad: true } : { t: 'revived', target: e.id, by: byId });
  if (byId !== undefined && byId !== e.id) {
    const by = w.get(byId);
    if (by?.hero) by.hero.stats.rescues++;
  }
  return true;
}

/**
 * The downed hero `e` is reviving right now: a hold-F revive (channel 'revive'), a 桃 used on
 * someone (an item channel started on a downed hero) or on himself while downed (C3-6).
 */
export function reviveTargetOf(w: World, e: Entity): EntityId | undefined {
  const h = e.hero;
  const ch = h?.channel;
  if (!h || h.dead || !ch) return undefined;
  if (ch.kind === 'revive') return ch.targetId;
  if (ch.kind !== 'item') return undefined;
  const ci = w.heroRt(e.id)?.channelItem;
  if (ci?.selfRevive) return e.id;
  return ci?.revive ? ch.targetId : undefined;
}

/**
 * Bleed-out timers. While someone else is reviving a downed hero his bleed-out is paused
 * (PUBG / Apex): `rescue` names the reviver for his HUD and VF_REVIVING. Damage still shortens
 * it (finishing a downed hero, combat.ts) — a revive under fire can be lost. His own 桃 does not
 * pause it: a hero already out of time is not saved by his own card (C3-6). With nobody hostile
 * near him, one of his own soldiers bandages him (战场急救, tickSquadAid) — paused as well.
 */
export function tickDowned(w: World, heroes: readonly Entity[], dt: number): void {
  for (const e of heroes) {
    const h = e.hero!;
    if (h.dead || !h.downed) {
      if (h.rescue) h.rescue = undefined;
      if (h.soul) tickSoul(w, e, heroes);
      continue;
    }
    let by: Entity | undefined;
    for (const r of heroes) {
      if (r !== e && reviveTargetOf(w, r) === e.id) {
        by = r;
        break;
      }
    }
    const ch = by?.hero?.channel;
    if (by && ch) {
      h.downedUntil += dt;
      if (h.rescue && !h.rescue.squad) {
        h.rescue.by = by.id;
        h.rescue.start = ch.start;
        h.rescue.until = ch.until;
      } else {
        h.rescue = { by: by.id, start: ch.start, until: ch.until };
      }
    } else {
      if (h.rescue && !h.rescue.squad) h.rescue = undefined;
      const aid = tickSquadAid(w, e, heroes);
      if (aid === 'done') continue;
      if (aid === 'aid') h.downedUntil += dt;
    }
    if (w.time >= h.downedUntil) {
      const rt = w.heroRt(e.id);
      w.killHero(e, rt?.downedBy, rt?.downedBySource);
    }
  }
}

/** A dead hero's 魂幡: who is channelling the 招魂 now; it falls when time is up (a 招魂 under way still finishes). */
function tickSoul(w: World, e: Entity, heroes: readonly Entity[]): void {
  const h = e.hero!;
  const soul = h.soul;
  if (!soul) return;
  if (!h.dead) {
    h.soul = undefined;
    return;
  }
  let by: EntityId | undefined;
  for (const r of heroes) {
    if (r !== e && reviveTargetOf(w, r) === e.id) {
      by = r.id;
      break;
    }
  }
  soul.by = by;
  if (by === undefined && w.time >= soul.until) h.soul = undefined;
}

/** A hero hostile to `e` (hit him lately, a known enemy…) stands within SQUAD_AID_CLEAR m. */
function squadAidBlocked(w: World, e: Entity, heroes: readonly Entity[]): boolean {
  for (const o of heroes) {
    if (o === e || !o.alive || o.hero!.dead || o.hero!.downed) continue;
    if (Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z) > SQUAD_AID_CLEAR) continue;
    if (w.isHostileTo(e, o)) return true;
  }
  return false;
}

/**
 * 战场急救: the downed commander's own soldier (the squad walks up to him, ai/troopBrain.ts)
 * bandages him for SQUAD_AID_TIME s while nobody hostile is near; a hit on either of them or the
 * soldier stepping away breaks it. Done: the commander is up with SQUAD_AID_HP and the soldier is
 * spent. 'aid' while it runs (the bleed-out is paused), 'done' the tick it succeeds.
 */
export function tickSquadAid(w: World, e: Entity, heroes: readonly Entity[]): 'none' | 'aid' | 'done' {
  const h = e.hero!;
  const now = w.time;
  const cur = h.rescue?.squad ? h.rescue : undefined;
  if (cur) {
    const s = w.get(cur.by);
    const ok =
      !!s &&
      s.alive &&
      s.troop?.commanderId === e.id &&
      Math.hypot(s.pos.x - e.pos.x, s.pos.z - e.pos.z) <= SQUAD_AID_REACH + 0.8 &&
      !((s.lastDamagedAt ?? -1) >= cur.start) &&
      !((e.lastDamagedAt ?? -1) >= cur.start) &&
      !s.statuses.some((st) => st.id === 'stun' && st.until > now);
    if (!ok || !s) {
      h.rescue = undefined;
      return 'none';
    }
    if (now < cur.until) return 'aid';
    if (!reviveHero(w, e, SQUAD_AID_HP, s.id, true)) return 'none';
    // the soldier gave everything he had
    w.killUnit(s, undefined);
    return 'done';
  }
  // (not while he is still being hit)
  if (h.squad.length === 0 || (e.lastDamagedAt ?? -99) >= now - 1 || squadAidBlocked(w, e, heroes)) return 'none';
  let best: Entity | undefined;
  let bd = SQUAD_AID_REACH;
  for (const id of h.squad) {
    const s = w.get(id);
    if (!s || !s.alive || !s.troop) continue;
    if (s.statuses.some((st) => st.id === 'stun' && st.until > now)) continue;
    const d = Math.hypot(s.pos.x - e.pos.x, s.pos.z - e.pos.z);
    if (d <= bd && (s.lastDamagedAt ?? -99) < now - 1) {
      bd = d;
      best = s;
    }
  }
  if (!best) return 'none';
  h.rescue = { by: best.id, start: now, until: now + SQUAD_AID_TIME, squad: true };
  return 'aid';
}

/** The dead hero whose 魂幡 `e` could raise from here (招魂), or undefined. */
export function recallTargetNear(w: World, e: Entity, range: number): Entity | undefined {
  let best: Entity | undefined;
  let bd = range;
  for (const o of w.heroList()) {
    const oh = o.hero!;
    if (o === e || !oh.dead || !oh.soul || w.time >= oh.soul.until) continue;
    // one 招魂 at a time
    if (oh.soul.by !== undefined && oh.soul.by !== e.id) continue;
    const d = Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z);
    if (d <= bd && Math.abs(o.pos.y - e.pos.y) < 2.5) {
      bd = d;
      best = o;
    }
  }
  return best;
}

/**
 * 招魂: a dead hero rises at his body — RECALL_HP, no squad, his primary weapon (his cards and gear
 * lie where he fell), a moment of protection. Once per match; his role stays public.
 */
export function recallHero(w: World, e: Entity, byId: EntityId | undefined): boolean {
  const h = e.hero;
  const rt = w.heroRt(e.id);
  if (!h || !h.dead || !h.soul || !rt || rt.recalled) return false;
  rt.recalled = true;
  rt.knocks = 0;
  rt.deathAt = undefined;
  rt.downedBy = undefined;
  rt.downedBySource = undefined;
  h.dead = false;
  h.soul = undefined;
  h.killerId = undefined;
  h.downed = false;
  h.downedUntil = 0;
  h.downedTotal = undefined;
  h.rescue = undefined;
  h.channel = null;
  h.order = { kind: 'follow' };
  e.alive = true;
  e.hp = Math.min(e.maxHp, RECALL_HP);
  e.shield = 0;
  const wi = h.weapons[h.activeSlot] ?? h.weapons.find((x) => x);
  if (wi) h.activeSlot = h.weapons.indexOf(wi);
  w.refillAmmo(e.id, 0.5);
  w.applyStatus(e.id, 'invuln', RECALL_INVULN, { sourceId: e.id });
  w.markKindsDirty();
  w.emit({ t: 'revived', target: e.id, by: byId, recall: true });
  if (byId !== undefined && byId !== e.id) {
    const by = w.get(byId);
    if (by?.hero) by.hero.stats.rescues++;
  }
  w.announce(`${h.name} 被招魂归来！`, `${h.name} has been called back from the dead!`, 'info');
  w.requestWinCheck();
  return true;
}

// ── Death ───────────────────────────────────────────────────────────────────
export function killHero(w: World, e: Entity, creditId: EntityId | undefined, sourceId: EntityId | undefined): void {
  const h = e.hero;
  if (!h || h.dead) return;
  const rt = w.heroRt(e.id);
  const killerId = creditId ?? rt?.downedBy;
  const killerSource = creditId !== undefined ? sourceId : rt?.downedBySource;
  h.dead = true;
  h.downed = false;
  h.downedUntil = 0;
  h.rescue = undefined;
  h.roleRevealed = true;
  h.killerId = killerId !== e.id ? killerId : undefined;
  h.channel = null;
  h.ads = false;
  h.sprinting = false;
  h.reloadUntil = 0;
  e.alive = false;
  e.hp = 0;
  e.vel.x = 0;
  e.vel.z = 0;
  e.forced = undefined;
  clearStatuses(e);
  if (rt) rt.deathAt = w.time;
  w.emit({ t: 'death', target: e.id, killer: h.killerId, kind: 'hero', role: h.role, heroId: h.heroId, name: h.name });

  const killer = killerId !== undefined && killerId !== e.id ? w.get(killerId) : undefined;
  // "by his own hand" (not via troops / summons); if the source already despawned, trust the record from when it downed us
  let direct = true;
  if (killer?.hero) {
    const srcEnt = killerSource !== undefined ? w.get(killerSource) : undefined;
    if (srcEnt || killerSource === undefined) direct = w.isDirectSource(killerSource, killer);
    else if (killerSource === rt?.downedBySource) direct = rt?.downedDirect ?? true;
    // …or he downed the victim by his own hand and his soldier / summon only finished him: the kill
    // the feed credits to him is his (C3-3: 误杀 skipped when a guard landed the last shot)
    if (!direct && rt?.downedBy === killer.id && rt.downedDirect) direct = true;
  }
  if (killer?.hero) {
    killer.hero.stats.kills++;
    if (direct) w.hooks.onKill(killer, e);
    applyRewards(w, killer, e, direct);
  }
  processBounties(w, e, killer, direct);
  // PUBG death box: his cards, armor, mount and sidearm lie at the body for anyone to take
  w.dropEverything(e);
  // 招魂: his 魂幡 stands at the body for a while (once per match)
  if (rt && !rt.recalled) h.soul = { until: w.time + SOUL_TIME };
  disbandSquad(w, e);
  w.requestWinCheck();
}

function applyRewards(w: World, killer: Entity, victim: Entity, direct: boolean): void {
  const kh = killer.hero!;
  const vRole = victim.hero!.role;
  // 杀反贼 → 摸三张牌
  if (vRole === 'rebel' && !kh.dead) {
    const items = w.rollRewardItems(REBEL_REWARD_ITEMS);
    for (const id of items) w.giveOrDrop(killer, id);
    w.emit({ t: 'reward', who: killer.id, kind: 'rebelKill', items });
  }
  // 主公杀忠臣 → 弃置所有牌 — only the lord's own hand: kills by his troops or
  // summoned NPCs (黄天 黄巾力士) don't count; his projectiles / hazards / turrets do
  if (kh.role === 'lord' && (vRole === 'loyalist' || vRole === 'double')) {
    if (direct) {
      const dropped = w.dropEverything(killer);
      w.emit({ t: 'reward', who: killer.id, kind: 'lordPenalty', items: dropped });
      w.announce(
        `主公误杀${vRole === 'double' ? '影武者' : '忠臣'}，弃置所有锦囊与装备！`,
        `The Lord killed a ${vRole === 'double' ? 'Body Double' : 'Loyalist'} and drops every item and all gear!`,
        'warn',
      );
    }
  }
}

/** 赏金猎人: paid only for a target it killed personally (not by its troops / summons); a new target either way. */
function processBounties(w: World, victim: Entity, killer: Entity | undefined, direct: boolean): void {
  for (const hunter of w.heroList()) {
    const hh = hunter.hero!;
    if (hh.role !== 'bounty' || hh.bountyTargetId !== victim.id) continue;
    if (killer === hunter && !hh.dead && direct) {
      const rt = w.heroRt(hunter.id);
      if (rt) rt.bountyKills++;
      const items = w.rollRewardItems(BOUNTY_REWARD_ITEMS, 'rare');
      for (const id of items) w.giveOrDrop(hunter, id);
      // private: only the 赏金猎人 can complete a bounty, so the event would reveal who it is
      w.emit({ t: 'reward', who: hunter.id, kind: 'bounty', items, privateTo: hunter.id });
    }
    hh.bountyTargetId = pickBountyTarget(w, hunter, victim.id);
  }
}

/** Random living non-lord hero other than the hunter (and `exclude`). */
export function pickBountyTarget(w: World, hunter: Entity, exclude?: EntityId): EntityId | undefined {
  const cands = w
    .heroList()
    .filter((e) => e !== hunter && e.id !== exclude && !e.hero!.dead && e.hero!.role !== 'lord');
  if (cands.length === 0) return undefined;
  return w.rng.pick(cands).id;
}

/** Commander died: troops become neutral NPCs that flee/fight for 20 s, then vanish. Turrets collapse. */
export function disbandSquad(w: World, commander: Entity): void {
  const h = commander.hero;
  if (!h) return;
  for (const id of h.squad) {
    const t = w.get(id);
    if (!t || !t.alive || !t.troop) continue;
    const tr = t.troop;
    t.kind = 'npc';
    t.ownerId = undefined;
    t.npc = {
      npcType: tr.troopType,
      home: { x: t.pos.x, y: t.pos.y, z: t.pos.z },
      leash: 1000,
      nextFireAt: tr.nextFireAt,
      expiresAt: w.time + SQUAD_DISBAND_TIME,
      ai: { flee: 1, mag: tr.mag },
    };
    t.troop = undefined;
    w.markKindsDirty();
  }
  h.squad = [];
  for (const e of w.kindList('turret')) {
    if (e.ownerId === commander.id && e.alive) w.killUnit(e, undefined);
  }
}

// ── Win conditions ──────────────────────────────────────────────────────────
export interface WinCheckInput {
  role: RoleId;
  dead: boolean;
  id: EntityId;
  bountyKills: number;
}

/**
 * Pure win evaluation over the heroes' roles/alive state. Returns null while
 * the game goes on.
 */
export function evaluateWin(heroes: readonly WinCheckInput[]): Omit<GameResult, 'roles' | 'mvp' | 'durationSec'> | null {
  if (heroes.length === 0) return null;
  const alive = heroes.filter((h) => !h.dead);
  if (alive.length === 0) {
    return { winner: 'draw', winners: [], reasonZh: '同归于尽，平局。', reasonEn: 'Everyone fell together — it is a draw.' };
  }
  const lords = heroes.filter((h) => h.role === 'lord');
  let winner: Faction | null = null;
  let winners: EntityId[] = [];
  let reasonZh = '';
  let reasonEn = '';
  const lordDead = lords.length > 0 && lords.every((l) => l.dead);
  if (lordDead) {
    const nonNeutralAlive = alive.filter((h) => factionOf(h.role) !== 'neutral');
    if (nonNeutralAlive.length > 0 && nonNeutralAlive.every((h) => h.role === 'traitor')) {
      winner = 'traitor';
      winners = nonNeutralAlive.map((h) => h.id);
      reasonZh = '主公阵亡，内奸笑到了最后，独自获胜！';
      reasonEn = 'The Lord has fallen and the Traitor is the last one standing — the Traitor wins!';
    } else {
      winner = 'rebel';
      winners = heroes.filter((h) => h.role === 'rebel').map((h) => h.id);
      reasonZh = '主公阵亡，反贼获胜！';
      reasonEn = 'The Lord has fallen — the Rebels win!';
    }
  } else {
    const enemiesAlive = alive.some((h) => h.role === 'rebel' || h.role === 'traitor');
    if (!enemiesAlive) {
      winner = 'lord';
      winners = heroes.filter((h) => factionOf(h.role) === 'lord').map((h) => h.id);
      reasonZh = '反贼与内奸尽数伏诛，主公与忠臣获胜！';
      reasonEn = 'Every Rebel and the Traitor is dead — the Lord and the Loyalists win!';
    }
  }
  if (!winner) return null;
  // neutral extra winners (墙头草 alive; 赏金猎人 alive with ≥ 1 bounty)
  for (const h of heroes) {
    if (h.dead) continue;
    if (h.role === 'opportunist' || (h.role === 'bounty' && h.bountyKills > 0)) {
      if (!winners.includes(h.id)) winners.push(h.id);
    }
  }
  return { winner, winners, reasonZh, reasonEn };
}

export function mvpScore(stats: { kills: number; damage: number; healing: number; rescues: number }): number {
  return stats.kills * 100 + stats.damage + stats.healing * 0.5 + stats.rescues * 150;
}

export function buildResult(w: World, partial: Omit<GameResult, 'roles' | 'mvp' | 'durationSec'>): GameResult {
  const roles: Record<EntityId, RoleId> = {};
  for (const e of w.heroList()) roles[e.id] = e.hero!.role;
  let mvp: EntityId | undefined;
  let best = -Infinity;
  for (const id of partial.winners) {
    const e = w.get(id);
    if (!e?.hero) continue;
    const s = mvpScore(e.hero.stats);
    if (s > best) {
      best = s;
      mvp = id;
    }
  }
  return { ...partial, roles, mvp, durationSec: Math.round(w.time * 10) / 10 };
}

export function checkWin(w: World): GameResult | null {
  const heroes = w.heroList();
  const partial = evaluateWin(
    heroes.map((e) => ({
      id: e.id,
      role: e.hero!.role,
      dead: e.hero!.dead,
      bountyKills: w.heroRt(e.id)?.bountyKills ?? 0,
    })),
  );
  if (partial) return buildResult(w, partial);
  if (w.time >= FAILSAFE_TIME) {
    return buildResult(w, {
      winner: 'draw',
      winners: [],
      reasonZh: '烽火燃尽，无人胜出，平局。',
      reasonEn: 'The beacon fires burned out with no victor — draw.',
    });
  }
  return null;
}
