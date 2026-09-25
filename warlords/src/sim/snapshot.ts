// Per-player snapshots (GAME_SPEC §11 hidden information):
//  - roles only when public (lord; 影武者 appears as a lord except to the real
//    lord and itself; revealed on death; your own; everything after game over)
//  - enemy stealthed entities farther than 8 m are omitted (unless revealed)
//  - private HUD state only for the receiving player's hero
import type {
  Entity,
  EntityId,
  PlayerId,
  PrivateHeroView,
  PublicPlayerView,
  RoleId,
  Snapshot,
  ViewEntity,
} from '../core/types';
import { SIM_DT } from '../core/types';
import {
  VF_ADS,
  VF_AIRBORNE,
  VF_BOOSTED,
  VF_BURNING,
  VF_CHANNELING,
  VF_CHARMED,
  VF_DANCING,
  VF_DEAD,
  VF_DODGING,
  VF_DOWNED,
  VF_FIRING,
  VF_FROZEN,
  VF_HASTE,
  VF_INVULN,
  VF_LORD,
  VF_MARKED,
  VF_MOUNTED,
  VF_OPENED,
  VF_RELOADING,
  VF_REVEALED,
  VF_ROOTED,
  VF_SHIELDED,
  VF_SLOWED,
  VF_SPRINTING,
  VF_STEALTH,
  VF_STUNNED,
} from '../core/types';
import { troopDef } from './defs';
import { revealedTo, statusRows } from './status';
import type { World } from './world';

/** Extension flag (sim-level): 'reveal' status — show on every minimap / outline through walls. */
export const VF_EXPOSED = 1 << 26;
/** Enemy stealthed units farther than this are not sent at all. */
export const STEALTH_SEND_RANGE = 8;
/** Hidden hazards (traps carrying a keep-stealth instance) are sent to enemies only this close (ITEMS-4). */
export const HIDDEN_HAZARD_SEND_RANGE = 6;
const FIRING_FLAG_TIME = 0.15;

function statusFlags(e: Entity, now: number): number {
  let f = 0;
  for (const s of e.statuses) {
    if (s.until <= now) continue;
    switch (s.id) {
      case 'stealth':
        f |= VF_STEALTH;
        break;
      case 'invuln':
        f |= VF_INVULN;
        break;
      case 'stun':
        f |= VF_STUNNED;
        break;
      case 'burn':
        f |= VF_BURNING;
        break;
      case 'freeze':
        f |= VF_FROZEN | VF_SLOWED;
        break;
      case 'dance':
        f |= VF_DANCING;
        break;
      case 'charm':
        f |= VF_CHARMED;
        break;
      case 'marked':
        f |= VF_MARKED;
        break;
      case 'haste':
        f |= VF_HASTE;
        break;
      case 'root':
        f |= VF_ROOTED;
        break;
      case 'slow':
        f |= VF_SLOWED;
        break;
      case 'dmgBoost':
        f |= VF_BOOSTED;
        break;
      case 'reveal':
        if (s.params?.viewerId === undefined) f |= VF_EXPOSED; // private reveals are added per viewer
        break;
      default:
        break;
    }
  }
  return f;
}

/** Role as seen by `viewer` (undefined = hidden). */
export function roleVisibleTo(w: World, viewer: Entity | undefined, target: Entity): RoleId | undefined {
  const h = target.hero;
  if (!h) return undefined;
  if (w.result() || h.roleRevealed || h.dead) return h.role;
  if (viewer && viewer.id === target.id) return h.role;
  if (h.role === 'lord') return 'lord';
  if (h.role === 'double') return viewer?.hero?.role === 'lord' ? 'double' : 'lord';
  return undefined;
}

function subOf(e: Entity): string {
  switch (e.kind) {
    case 'hero':
      return e.hero!.heroId;
    case 'troop':
      return e.troop!.troopType;
    case 'npc':
      return e.npc!.npcType;
    case 'projectile':
      return e.proj!.kind;
    case 'loot':
      return e.loot!.itemId ?? e.loot!.weaponId ?? '?';
    case 'crate':
      return String(e.crate!.tier);
    case 'airdrop':
      return 'airdrop';
    case 'turret':
      return e.turret!.kind;
    case 'hazard':
      return e.hazard!.kind;
    default:
      return '';
  }
}

/** Public (viewer-independent) view of one entity. */
export function viewEntity(w: World, e: Entity): ViewEntity {
  const now = w.time;
  let flags = statusFlags(e, now);
  if (!e.alive) flags |= VF_DEAD;
  if (e.shield > 0) flags |= VF_SHIELDED;
  if (!e.onGround && (e.kind === 'hero' || e.kind === 'troop' || e.kind === 'npc' || e.kind === 'airdrop')) flags |= VF_AIRBORNE;
  if (e.forced?.invuln && now < e.forced.until) flags |= VF_INVULN;
  const v: ViewEntity = {
    id: e.id,
    kind: e.kind,
    sub: subOf(e),
    x: round3(e.pos.x),
    y: round3(e.pos.y),
    z: round3(e.pos.z),
    yaw: round3(e.yaw),
    pitch: round3(e.pitch),
    speed: round3(Math.hypot(e.vel.x, e.vel.z)),
    hp: Math.ceil(e.hp),
    maxHp: e.maxHp,
    shield: Math.ceil(e.shield),
    flags,
  };
  if (e.kingdom) v.kingdom = e.kingdom;
  const owner = e.troop?.commanderId ?? e.ownerId;
  if (owner !== undefined) v.owner = owner;
  const h = e.hero;
  if (h) {
    if (h.dead) v.flags |= VF_DEAD;
    if (h.downed) v.flags |= VF_DOWNED;
    if (h.ads) v.flags |= VF_ADS;
    if (h.sprinting) v.flags |= VF_SPRINTING;
    if (h.reloadUntil > now) v.flags |= VF_RELOADING;
    if (h.dodgingUntil > now) v.flags |= VF_DODGING;
    if (h.channel) v.flags |= VF_CHANNELING;
    if (h.mount) v.flags |= VF_MOUNTED;
    if (h.role === 'lord' || h.role === 'double') v.flags |= VF_LORD | VF_REVEALED;
    if (h.roleRevealed || h.dead) v.flags |= VF_REVEALED;
    const rt = w.heroRt(e.id);
    if (rt && now - rt.lastFireAt <= FIRING_FLAG_TIME) v.flags |= VF_FIRING;
    const wi = h.weapons[h.activeSlot];
    if (wi) v.weapon = wi.id;
    if (h.armor) v.armor = h.armor;
    if (h.mount) v.mount = h.mount;
    if (h.claim) v.claim = h.claim;
    v.name = h.name;
    const pub = h.dead || h.roleRevealed ? h.role : h.role === 'lord' || h.role === 'double' ? 'lord' : undefined;
    if (pub) v.role = pub;
  } else if (e.troop) {
    v.weapon = troopDef(e.troop.troopType).weapon;
    if (e.troop.reloadUntil > now) v.flags |= VF_RELOADING;
    if (now - (e.troop.ai.lastShot ?? -9) <= FIRING_FLAG_TIME) v.flags |= VF_FIRING;
  } else if (e.npc) {
    v.weapon = troopDef(e.npc.npcType).weapon;
    if (now - (e.npc.ai.lastShot ?? -9) <= FIRING_FLAG_TIME) v.flags |= VF_FIRING;
  } else if (e.turret) {
    v.weapon = e.turret.weaponId;
  } else if (e.crate) {
    if (e.crate.opened) v.flags |= VF_OPENED;
  } else if (e.hazard) {
    v.radius = e.hazard.radius;
  } else if (e.proj) {
    if (e.proj.explodeRadius > 0) v.radius = e.proj.explodeRadius;
  }
  return v;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** True if `e` must be hidden from `viewer` (enemy stealth beyond range, not revealed). */
export function hiddenFrom(w: World, viewer: Entity | undefined, e: Entity): boolean {
  if (!viewer || viewer === e) return false;
  const now = w.time;
  let stealth = false;
  for (const s of e.statuses) {
    if (s.until > now && s.id === 'stealth') {
      stealth = true;
      break;
    }
  }
  if (!stealth || revealedTo(e, viewer.id, now)) return false;
  if (w.isOwnSide(viewer, e)) return false;
  const d = Math.hypot(e.pos.x - viewer.pos.x, e.pos.y - viewer.pos.y, e.pos.z - viewer.pos.z);
  return d > (e.kind === 'hazard' ? HIDDEN_HAZARD_SEND_RANGE : STEALTH_SEND_RANGE);
}

/**
 * Forced movement of the receiving hero as the client replays it (net/clientView):
 * `remaining` covers exactly the ticks AFTER this snapshot's tick that still move
 * under `forced` ((n − ½) ticks, robust to the wire's rounding), and 0 means "no
 * forced tick left, but the end-of-forced brake (SHU-1) happens next tick".
 * Undefined when nothing is pending.
 */
export function forcedForClient(e: Entity, tick: number): { vel: Entity['vel']; remaining: number } | undefined {
  const f = e.forced;
  if (!f) return undefined;
  let n = 0;
  while (n < 600 && (tick + n + 1) * SIM_DT < f.until) n++;
  return { vel: { x: f.vel.x, y: f.vel.y, z: f.vel.z }, remaining: n > 0 ? Math.round((n - 0.5) * SIM_DT * 1000) / 1000 : 0 };
}

export function privateView(w: World, e: Entity): PrivateHeroView {
  const h = e.hero!;
  const now = w.time;
  const rt = w.heroRt(e.id);
  const cooldowns: Record<string, number> = {};
  for (const a of rt?.abilities ?? []) {
    if (a.def.slot === 'passive') continue;
    cooldowns[a.def.id] = Math.max(0, Math.round(((h.cooldowns[a.def.id] ?? 0) - now) * 10) / 10);
  }
  const knownAllies: EntityId[] = [];
  if (h.role === 'lord') {
    for (const o of w.heroList()) if (o.hero!.role === 'double') knownAllies.push(o.id);
  } else if (h.role === 'double') {
    for (const o of w.heroList()) if (o.hero!.role === 'lord') knownAllies.push(o.id);
  }
  const squad = h.squad
    .map((id) => w.get(id))
    .filter((t): t is Entity => !!t && t.alive)
    .map((t) => ({ id: t.id, hp: Math.ceil(t.hp), maxHp: t.maxHp }));
  const view: PrivateHeroView = {
    entityId: e.id,
    heroId: h.heroId,
    role: h.role,
    hp: Math.ceil(e.hp),
    maxHp: e.maxHp,
    shield: Math.ceil(e.shield),
    weapons: h.weapons.map((wi) => (wi ? { id: wi.id, mag: wi.mag, reserve: wi.reserve } : null)),
    activeSlot: h.activeSlot,
    items: h.items.map((it) => (it ? { id: it.id, count: it.count } : null)),
    armor: h.armor,
    mount: h.mount,
    cooldowns,
    charges: { ...h.charges },
    abilityState: { ...h.abilityState },
    dodgeCharges: h.dodgeCharges,
    reloading: h.reloadUntil > now ? Math.round((h.reloadUntil - now) * 100) / 100 : 0,
    channel: h.channel
      ? {
          kind: h.channel.kind,
          progress: Math.max(0, Math.min(1, (now - h.channel.start) / Math.max(1e-3, h.channel.until - h.channel.start))),
        }
      : null,
    downed: h.downed,
    downedRemaining: h.downed ? Math.max(0, Math.round((h.downedUntil - now) * 10) / 10) : 0,
    dead: h.dead,
    statuses: statusRows(e, now, e.id),
    squad,
    order: { ...h.order },
    stats: { ...h.stats },
    vel: { x: e.vel.x, y: e.vel.y, z: e.vel.z },
    onGround: e.onGround,
  };
  const forced = forcedForClient(e, w.tick);
  if (forced) view.forced = forced;
  if (h.role === 'bounty' && h.bountyTargetId !== undefined) view.bountyTargetId = h.bountyTargetId;
  if (knownAllies.length) view.knownAllies = knownAllies;
  if (rt?.lastMoveMods) view.moveMods = { ...rt.lastMoveMods };
  return view;
}

export function publicPlayers(w: World, viewer: Entity | undefined): PublicPlayerView[] {
  const out: PublicPlayerView[] = [];
  for (const slot of w.slots) {
    const e = w.get(slot.entityId);
    if (!e?.hero) continue;
    const h = e.hero;
    const v: PublicPlayerView = {
      playerId: slot.playerId,
      name: h.name,
      isBot: slot.isBot,
      seat: slot.seat,
      entityId: e.id,
      heroId: h.heroId,
      kingdom: e.kingdom ?? 'qun',
      alive: !h.dead,
      downed: h.downed,
      kills: h.stats.kills,
    };
    const role = roleVisibleTo(w, viewer, e);
    if (role) v.role = role;
    if (h.claim) v.claim = h.claim;
    out.push(v);
  }
  return out;
}

function hasPrivateRevealFor(e: Entity, viewerId: EntityId, now: number): boolean {
  for (const s of e.statuses) if (s.id === 'reveal' && s.until > now && s.params?.viewerId === viewerId) return true;
  return false;
}

/** Cached per-tick public entity list. */
export class ViewCache {
  private tick = -1;
  private list: ViewEntity[] = [];

  get(w: World): ViewEntity[] {
    if (this.tick !== w.tick || w.viewDirty) {
      this.tick = w.tick;
      w.viewDirty = false;
      this.list = [];
      for (const e of w.ents.values()) this.list.push(viewEntity(w, e));
    }
    return this.list;
  }
}

export function buildSnapshot(w: World, playerId: PlayerId, cache: ViewCache): Snapshot {
  const slot = w.slotOf(playerId);
  const viewer = slot ? w.get(slot.entityId) : undefined;
  const base = cache.get(w);
  const ents: ViewEntity[] = [];
  for (const v of base) {
    const e = w.ents.get(v.id);
    if (!e) continue;
    if (hiddenFrom(w, viewer, e)) continue;
    // private reveals (观星 / 狼顾) outline the target only for their viewer
    if (viewer && (v.flags & VF_EXPOSED) === 0 && e.statuses.length > 0 && hasPrivateRevealFor(e, viewer.id, w.time)) {
      const copy = { ...v, flags: v.flags | VF_EXPOSED };
      const role = e.hero ? roleVisibleTo(w, viewer, e) : undefined;
      if (e.hero) {
        if (role) copy.role = role;
        else delete copy.role;
      }
      ents.push(copy);
      continue;
    }
    if (e.hero) {
      const role = roleVisibleTo(w, viewer, e);
      if (role !== v.role) {
        const copy = { ...v };
        if (role) copy.role = role;
        else delete copy.role;
        ents.push(copy);
        continue;
      }
    }
    ents.push(v);
  }
  return {
    tick: w.tick,
    time: w.time,
    ackSeq: slot?.ackSeq ?? 0,
    ents,
    zone: w.zone.view(),
    you: viewer?.hero ? privateView(w, viewer) : null,
    players: publicPlayers(w, viewer),
    elapsed: w.time,
  };
}

