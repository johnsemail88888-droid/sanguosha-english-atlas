// What a kill was made with (kill feed glyph): the weapon, the ability or the card.
// Death / downed events only name the killer, so the HUD remembers, per victim and
// attacker, what the attacker was doing when its damage landed — read from the
// same event stream (shot / ability / itemUse / melee next to each hit). Pure
// logic (no DOM): unit-tested in tests/unit/ui.
import type { EntityId, GameEvent } from '../../core/types';
import { ABILITY_BY_ID, ITEM_BY_ID, WEAPON_BY_ID } from '../../data';

export interface KillCause {
  kind: 'weapon' | 'ability' | 'item';
  id: string;
}

export interface KillCauseLookup {
  /** the weapon an entity is holding (ViewEntity.weapon) */
  heldWeapon(id: EntityId): string | undefined;
  /** the entity's owner (a troop / turret → its hero) */
  ownerOf(id: EntityId): EntityId | undefined;
}

/** Seconds a landed hit stays the answer (a downed hero bleeds out for 12 s). */
export const CAUSE_MEMORY = 20;
/** Seconds an attacker's last action explains damage that lands later (projectiles, burns). */
export const RECENT_ACTION = 3;

type Stamped = { cause: KillCause; at: number };

/** A 'shot' names a weapon, an ability (ability hitscans) or just 'ability'. */
function shotCause(weapon: string, recentAbility: KillCause | null): KillCause | null {
  if (WEAPON_BY_ID[weapon]) return { kind: 'weapon', id: weapon };
  if (ABILITY_BY_ID[weapon]) return { kind: 'ability', id: weapon };
  return recentAbility;
}

interface Acts {
  shots: { src: EntityId; weapon: string; hit?: EntityId }[];
  casts: { src: EntityId; ability: string; target?: EntityId; proc: boolean }[];
  uses: { src: EntityId; item: string; target?: EntityId }[];
  melee: Set<EntityId>;
}

export class KillCauses {
  private readonly last = new Map<EntityId, Map<EntityId, Stamped>>();
  private readonly recent = new Map<EntityId, Stamped>();
  private readonly recentAbility = new Map<EntityId, Stamped>();
  private lastPrune = 0;

  constructor(private readonly lookup: KillCauseLookup) {}

  /** Read one batch of events (host order). Ask causeOf() for its deaths / downs afterwards. */
  ingest(evs: readonly GameEvent[], now: number): void {
    const acts: Acts = { shots: [], casts: [], uses: [], melee: new Set() };
    for (const ev of evs) {
      switch (ev.t) {
        case 'shot':
          acts.shots.push({ src: ev.src, weapon: ev.weapon, hit: ev.hit });
          break;
        case 'ability':
          if (ABILITY_BY_ID[ev.ability]) acts.casts.push({ src: ev.src, ability: ev.ability, target: ev.target, proc: !!ev.proc });
          break;
        case 'itemUse':
          if (ITEM_BY_ID[ev.item]) acts.uses.push({ src: ev.who, item: ev.item, target: ev.target });
          break;
        case 'melee':
          acts.melee.add(ev.src);
          break;
        default:
          break;
      }
    }
    for (const c of acts.casts) {
      if (c.proc) continue;
      const s = { cause: { kind: 'ability' as const, id: c.ability }, at: now };
      this.recent.set(c.src, s);
      this.recentAbility.set(c.src, s);
    }
    for (const u of acts.uses) this.recent.set(u.src, { cause: { kind: 'item', id: u.item }, at: now });
    for (const sh of acts.shots) {
      const c = shotCause(sh.weapon, this.recentAbilityOf(sh.src, now));
      if (c) this.recent.set(sh.src, { cause: c, at: now });
    }
    for (const ev of evs) {
      if (ev.t !== 'hit' || ev.src === undefined || ev.src === ev.target || ev.amount <= 0) continue;
      const cause = this.attribute(ev.target, ev.src, acts, now);
      if (!cause) continue;
      let byVictim = this.last.get(ev.target);
      if (!byVictim) this.last.set(ev.target, (byVictim = new Map()));
      byVictim.set(ev.src, { cause, at: now });
    }
    if (now - this.lastPrune > 5) this.prune(now);
  }

  /** How `killer` got `victim` (null: unknown, or nothing with art to show). */
  causeOf(victim: EntityId, killer: EntityId | undefined, now: number): KillCause | null {
    if (killer === undefined) return null;
    const hit = this.last.get(victim)?.get(killer);
    if (hit && now - hit.at <= CAUSE_MEMORY) return hit.cause;
    const held = this.lookup.heldWeapon(killer);
    return held && WEAPON_BY_ID[held] ? { kind: 'weapon', id: held } : null;
  }

  /** A victim died: its entries are done. */
  forget(victim: EntityId): void {
    this.last.delete(victim);
  }

  private recentAbilityOf(src: EntityId, now: number): KillCause | null {
    const r = this.recentAbility.get(src);
    return r && now - r.at <= RECENT_ACTION ? r.cause : null;
  }

  /** What `src` hit `target` with, from this batch first, then its recent actions, then its held weapon. */
  private attribute(target: EntityId, src: EntityId, acts: Acts, now: number): KillCause | null {
    const ownRecent = this.recentAbilityOf(src, now);
    // a shot of src that hit this target
    for (const s of acts.shots) {
      if (s.src !== src || s.hit !== target) continue;
      const c = shotCause(s.weapon, ownRecent);
      if (c) return c;
    }
    // a cast / card aimed at it
    for (const c of acts.casts) if (c.src === src && c.target === target) return { kind: 'ability', id: c.ability };
    for (const u of acts.uses) if (u.src === src && u.target === target) return { kind: 'item', id: u.item };
    // an area cast / card of this batch
    for (const c of acts.casts) if (c.src === src && !c.proc) return { kind: 'ability', id: c.ability };
    for (const u of acts.uses) if (u.src === src) return { kind: 'item', id: u.item };
    // src's troops / turrets: the hit is credited to the hero, the shot came from the unit
    for (const s of acts.shots) if (s.hit === target && s.src !== src && this.lookup.ownerOf(s.src) === src) return shotCause(s.weapon, null);
    for (const s of acts.shots) {
      if (s.src !== src) continue;
      const c = shotCause(s.weapon, ownRecent);
      if (c) return c;
    }
    if (acts.melee.has(src)) {
      const held = this.lookup.heldWeapon(src);
      if (held && WEAPON_BY_ID[held]) return { kind: 'weapon', id: held };
    }
    const r = this.recent.get(src);
    if (r && now - r.at <= RECENT_ACTION) return r.cause;
    const held = this.lookup.heldWeapon(src);
    return held && WEAPON_BY_ID[held] ? { kind: 'weapon', id: held } : null;
  }

  private prune(now: number): void {
    this.lastPrune = now;
    for (const [victim, byKiller] of this.last) {
      for (const [k, s] of byKiller) if (now - s.at > CAUSE_MEMORY) byKiller.delete(k);
      if (!byKiller.size) this.last.delete(victim);
    }
    for (const m of [this.recent, this.recentAbility]) for (const [k, s] of m) if (now - s.at > RECENT_ACTION) m.delete(k);
  }
}
