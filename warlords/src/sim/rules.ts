// 身份局 rules (GAME_SPEC §4): 濒死 / revive / death, role reveal, rewards
// and penalties, bounty targets, win conditions, MVP.
import type { Entity, EntityId, Faction, GameResult, RoleId } from '../core/types';
import { ROLE_BY_ID } from '../data';
import { clearStatuses } from './status';
import type { World } from './world';

export const BLEED_OUT_TIME = 12;
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
  h.downed = true;
  h.downedUntil = w.time + BLEED_OUT_TIME;
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

export function reviveHero(w: World, e: Entity, hp: number, byId: EntityId | undefined): boolean {
  const h = e.hero;
  if (!h || h.dead || !h.downed) return false;
  h.downed = false;
  h.downedUntil = 0;
  e.hp = Math.max(1, Math.min(e.maxHp, hp));
  w.emit({ t: 'revived', target: e.id, by: byId });
  if (byId !== undefined && byId !== e.id) {
    const by = w.get(byId);
    if (by?.hero) by.hero.stats.rescues++;
  }
  return true;
}

/** Bleed-out timers. */
export function tickDowned(w: World, heroes: readonly Entity[]): void {
  for (const e of heroes) {
    const h = e.hero!;
    if (h.dead || !h.downed) continue;
    if (w.time >= h.downedUntil) {
      const rt = w.heroRt(e.id);
      w.killHero(e, rt?.downedBy, rt?.downedBySource);
    }
  }
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
  }
  if (killer?.hero) {
    killer.hero.stats.kills++;
    if (direct) w.hooks.onKill(killer, e);
    applyRewards(w, killer, e, direct);
  }
  processBounties(w, e, killer, direct);
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
      w.emit({ t: 'reward', who: hunter.id, kind: 'bounty', items });
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
