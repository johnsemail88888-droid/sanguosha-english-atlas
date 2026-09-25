// Pure HUD logic (no DOM): unit-tested in tests/unit/ui.
import type {
  EntityId,
  Kingdom,
  PrivateHeroView,
  PublicPlayerView,
  RoleId,
  ViewEntity,
  ZoneView,
} from '../../core/types';
import { VF_AIRBORNE, VF_DEAD, VF_DOWNED, VF_OPENED } from '../../core/types';
import type { AbilityDef, HeroDef, WeaponClass } from '../../data/types';
import { ARMOR_BY_ID, HERO_BY_ID, ITEM_BY_ID, MOUNT_BY_ID, TROOP_BY_ID, WEAPON_BY_ID, isPassiveAbility } from '../../data';
import { displayName } from '../../game/names';

// ── HP ───────────────────────────────────────────────────────────────────────

/** Number of 勾玉 ticks (one per 100 HP) for a max HP. */
export function hpTicks(maxHp: number): number {
  return Math.max(1, Math.round(maxHp / 100));
}

/** How many ticks are (at least partly) filled. */
export function filledTicks(hp: number, maxHp: number): number {
  if (hp <= 0) return 0;
  return Math.min(hpTicks(maxHp), Math.ceil(hp / 100 - 1e-6));
}

// ── zone ─────────────────────────────────────────────────────────────────────

export type ZoneState = { kind: 'wait' | 'shrink' | 'final'; secs: number };

export function zoneStatus(z: ZoneView, elapsed: number): ZoneState {
  if (elapsed < z.shrinkStart) return { kind: 'wait', secs: z.shrinkStart - elapsed };
  if (elapsed < z.shrinkEnd) return { kind: 'shrink', secs: z.shrinkEnd - elapsed };
  return { kind: 'final', secs: 0 };
}

/** Positive distance (m) outside the current circle, 0 when inside. */
export function distanceOutsideZone(x: number, z: number, zone: ZoneView): number {
  const d = Math.hypot(x - zone.center.x, z - zone.center.z);
  return Math.max(0, d - zone.radius);
}

// ── abilities ────────────────────────────────────────────────────────────────

export interface AbilitySlotView {
  def: AbilityDef;
  /** key label ('' for passives, incl. passive lord skills such as 袁绍 血裔) */
  key: string;
  /** true when the ability can be triggered (click / key); false for passives */
  active: boolean;
}

/** Abilities shown in the HUD: passive, Q, E, and the lord skill only for the real Lord. */
export function hudAbilities(hero: HeroDef | undefined, role: RoleId | undefined): AbilitySlotView[] {
  if (!hero) return [];
  const order: Record<AbilityDef['slot'], number> = { passive: 0, q: 1, e: 2, lord: 3 };
  const keys: Record<AbilityDef['slot'], string> = { passive: '', q: 'Q', e: 'E', lord: 'G' };
  return hero.abilities
    .filter((a) => a.slot !== 'lord' || role === 'lord')
    .sort((a, b) => order[a.slot] - order[b.slot])
    .map((def) => {
      const active = !isPassiveAbility(def);
      return { def, key: active ? keys[def.slot] : '', active };
    });
}

/**
 * Whether an activatable ability can be used now. Charge-based abilities
 * (刘备 Q, 赵云 Q…) stay usable while a charge is left even though
 * `cooldowns[id]` is already counting down the next recharge.
 */
export function abilityReady(def: AbilityDef, cooldownRemaining: number, charges: number | undefined): boolean {
  if (def.charges) return (charges ?? def.charges) > 0;
  return !(cooldownRemaining > 0);
}

/** Base dodge (闪) charges every hero has (GAME_SPEC §5). */
export const BASE_DODGE_CHARGES = 2;

/** Max dodge charges for a hero: the base, raised by passives with `params.maxDodges` (赵云 龙胆). */
export function maxDodgeCharges(heroId: string | undefined): number {
  let max = BASE_DODGE_CHARGES;
  const def = heroId ? HERO_BY_ID[heroId] : undefined;
  for (const a of def?.abilities ?? []) {
    const m = a.params?.maxDodges;
    if (typeof m === 'number' && m > max) max = Math.floor(m);
  }
  return max;
}

/**
 * True when the hero can currently revive without a 桃: an ability with
 * `params.freeReviveCd` (华佗 急救) whose free-revive cooldown is ready.
 */
export function canReviveFree(me: Pick<PrivateHeroView, 'heroId' | 'cooldowns'>): boolean {
  const def = HERO_BY_ID[me.heroId];
  for (const a of def?.abilities ?? []) {
    if (typeof a.params?.freeReviveCd !== 'number') continue;
    if (!((me.cooldowns[a.id] ?? 0) > 0)) return true;
  }
  return false;
}

/** 0 = ready, 1 = just used. */
export function cooldownFraction(remaining: number, total: number | undefined): number {
  if (!remaining || remaining <= 0) return 0;
  const tot = total && total > 0 ? total : remaining;
  return Math.max(0, Math.min(1, remaining / tot));
}

// ── crosshair ────────────────────────────────────────────────────────────────

export type CrosshairStyle = 'cross' | 'circle' | 'dot' | 'launcher' | 'bow' | 'flame' | 'melee';

export function crosshairStyle(cls: WeaponClass | undefined): CrosshairStyle {
  switch (cls) {
    case 'shotgun':
      return 'circle';
    case 'sniper':
      return 'dot';
    case 'launcher':
      return 'launcher';
    case 'bow':
    case 'crossbow':
      return 'bow';
    case 'flamer':
      return 'flame';
    case 'melee':
      return 'melee';
    default:
      return 'cross';
  }
}

/** Angular spread (degrees, cone half-angle) → pixels on screen for a vertical FOV. */
export function spreadToPx(spreadDeg: number, vfovDeg: number, viewportH: number): number {
  const half = (Math.max(1, vfovDeg) * Math.PI) / 360;
  const a = (Math.max(0, spreadDeg) * Math.PI) / 180;
  return (Math.tan(a) / Math.tan(half)) * (viewportH / 2);
}

// ── interaction prompt ───────────────────────────────────────────────────────

export type InteractPrompt =
  | { kind: 'revive'; targetId: EntityId; heroId: string; name: string; needPeach: boolean }
  | { kind: 'airdrop'; targetId: EntityId }
  | { kind: 'crate'; targetId: EntityId; tier: 1 | 2 | 3 }
  | { kind: 'pickup'; targetId: EntityId; itemId: string; swap: boolean }
  | { kind: 'full'; targetId: EntityId; itemId: string }
  | { kind: 'selfRevive'; slot: number };

export const REVIVE_RANGE = 3;
export const CRATE_RANGE = 3;
export const AIRDROP_RANGE = 3.5;
export const LOOT_RANGE = 2.5;

function hasFreeSlotFor(me: PrivateHeroView, itemId: string): boolean {
  const def = ITEM_BY_ID[itemId];
  for (const it of me.items) {
    if (!it) return true;
    if (it.id === itemId && (!def || it.count < def.maxStack)) return true;
  }
  return false;
}

/** Context-sensitive F prompt from nearby loot / crates / downed heroes. */
export function deriveInteract(me: PrivateHeroView | null, pos: { x: number; y: number; z: number } | undefined, ents: readonly ViewEntity[]): InteractPrompt | null {
  if (!me || me.dead) return null;
  if (me.downed) {
    const slot = me.items.findIndex((it) => it?.id === 'jiu');
    return slot >= 0 ? { kind: 'selfRevive', slot } : null;
  }
  if (me.channel || !pos) return null;
  let best: { p: InteractPrompt; prio: number; d: number } | null = null;
  const consider = (p: InteractPrompt, prio: number, d: number): void => {
    if (!best || prio > best.prio || (prio === best.prio && d < best.d)) best = { p, prio, d };
  };
  for (const e of ents) {
    if (e.id === me.entityId) continue;
    const dy = Math.abs(e.y - pos.y);
    if (dy > 2.5) continue;
    const d = Math.hypot(e.x - pos.x, e.z - pos.z);
    if (d > 4) continue;
    switch (e.kind) {
      case 'hero':
        if (d <= REVIVE_RANGE && e.flags & VF_DOWNED && !(e.flags & VF_DEAD)) {
          const needPeach = !me.items.some((it) => it?.id === 'tao') && !canReviveFree(me);
          consider({ kind: 'revive', targetId: e.id, heroId: e.sub, name: e.name ?? e.sub, needPeach }, 4, d);
        }
        break;
      case 'airdrop':
        if (d <= AIRDROP_RANGE && !(e.flags & VF_OPENED) && !(e.flags & VF_AIRBORNE)) consider({ kind: 'airdrop', targetId: e.id }, 3, d);
        break;
      case 'crate':
        if (d <= CRATE_RANGE && !(e.flags & VF_OPENED)) {
          const tier = Number(e.sub);
          consider({ kind: 'crate', targetId: e.id, tier: tier === 2 ? 2 : tier === 3 ? 3 : 1 }, 3, d);
        }
        break;
      case 'loot': {
        if (d > LOOT_RANGE) break;
        const id = e.sub;
        if (WEAPON_BY_ID[id]) {
          const cur = me.weapons[0];
          consider({ kind: 'pickup', targetId: e.id, itemId: id, swap: !!cur && cur.id !== id }, 2, d);
        } else if (ARMOR_BY_ID[id]) {
          consider({ kind: 'pickup', targetId: e.id, itemId: id, swap: !!me.armor }, 2, d);
        } else if (MOUNT_BY_ID[id]) {
          consider({ kind: 'pickup', targetId: e.id, itemId: id, swap: !!me.mount }, 2, d);
        } else if (!hasFreeSlotFor(me, id)) {
          consider({ kind: 'full', targetId: e.id, itemId: id }, 1, d);
        }
        break;
      }
      default:
        break;
    }
  }
  return (best as { p: InteractPrompt } | null)?.p ?? null;
}

// ── names ────────────────────────────────────────────────────────────────────

export interface EntityLabel {
  /** display name (player name for heroes) */
  name: string;
  heroId?: string;
  kingdom?: Kingdom;
  role?: RoleId;
  kind: ViewEntity['kind'] | 'unknown';
}

export interface NameLookup {
  get(id: EntityId): ViewEntity | undefined;
  players(): readonly PublicPlayerView[];
}

/** Resolve who an entity is (heroes, troops → commander, turrets/projectiles → owner). */
export function entityLabel(view: NameLookup, id: EntityId | undefined, lang: 'zh' | 'en', depth = 0): EntityLabel | null {
  if (id === undefined || id === null) return null;
  const p = view.players().find((x) => x.entityId === id);
  const e = view.get(id);
  if (p) return { name: displayName(p.name, lang), heroId: p.heroId, kingdom: p.kingdom, role: p.role ?? e?.role, kind: 'hero' };
  if (!e) return null;
  const pick = (zh: string, en: string): string => (lang === 'en' ? en : zh);
  switch (e.kind) {
    case 'hero':
      return { name: e.name ? displayName(e.name, lang) : e.sub, heroId: e.sub, kingdom: e.kingdom, role: e.role, kind: 'hero' };
    case 'troop':
    case 'npc': {
      const def = TROOP_BY_ID[e.sub];
      const troopName = def ? pick(def.nameZh, def.nameEn) : e.sub;
      if (e.kind === 'troop' && e.owner !== undefined && depth < 2) {
        const owner = entityLabel(view, e.owner, lang, depth + 1);
        if (owner) return { ...owner, name: `${owner.name}·${troopName}`, kind: 'troop' };
      }
      return { name: troopName, kingdom: e.kingdom, kind: e.kind };
    }
    default: {
      if (e.owner !== undefined && depth < 2) {
        const owner = entityLabel(view, e.owner, lang, depth + 1);
        if (owner) return owner;
      }
      return { name: e.sub, kind: e.kind };
    }
  }
}

/** Hero display name by hero id with language. */
export function heroDisplayName(heroId: string | undefined, lang: 'zh' | 'en'): string {
  if (!heroId) return '';
  const d = HERO_BY_ID[heroId];
  return d ? (lang === 'en' ? d.nameEn : d.nameZh) : heroId;
}

// ── spectate ─────────────────────────────────────────────────────────────────

/** Next alive hero to spectate (dir = +1 / −1), skipping `self`. */
export function cycleSpectate(players: readonly PublicPlayerView[], current: EntityId | null, dir: 1 | -1, self: EntityId | null): EntityId | null {
  const alive = players.filter((p) => p.alive && p.entityId !== self).sort((a, b) => a.seat - b.seat);
  if (!alive.length) return null;
  const idx = alive.findIndex((p) => p.entityId === current);
  if (idx < 0) return alive[dir > 0 ? 0 : alive.length - 1].entityId;
  return alive[(idx + dir + alive.length) % alive.length].entityId;
}

// ── misc ─────────────────────────────────────────────────────────────────────

/** Angle (radians, 0 = straight ahead, + = to the right) from a viewer to a point. */
export function relativeBearing(viewerX: number, viewerZ: number, viewerYaw: number, x: number, z: number): number {
  const dx = x - viewerX;
  const dz = z - viewerZ;
  // forward = (-sin yaw, -cos yaw); right = (cos yaw, -sin yaw)
  const fwd = -Math.sin(viewerYaw) * dx - Math.cos(viewerYaw) * dz;
  const right = Math.cos(viewerYaw) * dx - Math.sin(viewerYaw) * dz;
  return Math.atan2(right, fwd);
}

export function aliveCount(players: readonly PublicPlayerView[]): number {
  let n = 0;
  for (const p of players) if (p.alive) n++;
  return n;
}

// ── UI key de-duplication ────────────────────────────────────────────────────

/**
 * UI keys can arrive twice for one physical press: from the input controller
 * (GameHandle.input.onUiKey) and from the HUD's own document listener (which
 * keeps overlays usable while gameplay input is disabled). A press reported by
 * one source is paired with the matching report from the *other* source within
 * `windowMs`; repeated presses from the same source are never swallowed.
 */
export class UiKeyDeduper {
  private readonly pending = new Map<string, { src: 'doc' | 'ctl'; t: number }[]>();

  constructor(private readonly windowMs = 150) {}

  /** true → handle this report, false → it duplicates one already handled */
  accept(key: string, src: 'doc' | 'ctl', t: number): boolean {
    const list = (this.pending.get(key) ?? []).filter((e) => t - e.t < this.windowMs);
    const twin = list.findIndex((e) => e.src !== src);
    if (twin >= 0) {
      list.splice(twin, 1);
      this.pending.set(key, list);
      return false;
    }
    list.push({ src, t });
    this.pending.set(key, list);
    return true;
  }
}
