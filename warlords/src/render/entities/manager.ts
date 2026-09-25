// Keeps one visual per ViewEntity, creating / updating / disposing as entities
// come and go. Troops & NPCs that die are removed from the view by the sim;
// their visuals linger briefly as corpses playing the death fall.
import * as THREE from 'three';
import type { EntityId, ViewEntity } from '../../core/types';
import { VF_DEAD } from '../../core/types';
import { CharacterView } from './characterView';
import { AirdropView, CrateView, LootView, ProjectileView, TurretView, type EntityView } from './objects';
import { HazardView } from './hazards';
import type { EntityCtx } from './context';
import { TroopBadgeLayer } from './nameplate';

type AnyView = CharacterView | EntityView;
const MAX_CORPSES = 24;
const CORPSE_TIME = 6;

const isCharacterKind = (k: ViewEntity['kind']): boolean => k === 'hero' || k === 'troop' || k === 'npc';

export class EntityManager {
  readonly group = new THREE.Group();
  /** one instanced draw call for every troop / NPC pennant + HP bar */
  readonly badges = new TroopBadgeLayer();
  private readonly views = new Map<EntityId, AnyView>();
  /** kind / sub each view was built for (an id reused for something else is rebuilt) */
  private readonly kinds = new Map<EntityId, ViewEntity['kind']>();
  private readonly subs = new Map<EntityId, string>();
  private corpses: CharacterView[] = [];
  private readonly died = new Map<EntityId, number>();
  private readonly seen = new Set<EntityId>();

  constructor() {
    this.group.name = 'entities';
    this.group.add(this.badges.mesh);
  }

  get size(): number {
    return this.views.size;
  }

  character(id: EntityId | undefined | null): CharacterView | undefined {
    if (id === undefined || id === null) return undefined;
    const v = this.views.get(id);
    return v instanceof CharacterView ? v : undefined;
  }

  view(id: EntityId): AnyView | undefined {
    return this.views.get(id);
  }

  /** A death event was seen for this entity: keep its visual as a corpse when it leaves the view. */
  noteDeath(id: EntityId, time: number): void {
    this.died.set(id, time);
  }

  private create(e: ViewEntity): AnyView | null {
    switch (e.kind) {
      case 'hero':
      case 'troop':
      case 'npc':
        return new CharacterView(e);
      case 'projectile':
        return new ProjectileView(e);
      case 'loot':
        return new LootView(e);
      case 'crate':
        return new CrateView(e);
      case 'airdrop':
        return new AirdropView(e);
      case 'turret':
        return new TurretView(e);
      case 'hazard':
        return new HazardView(e);
      default:
        return null;
    }
  }

  /** `ctx.badges` must be this manager's `badges` layer. */
  sync(entities: readonly ViewEntity[], ctx: EntityCtx): void {
    const seen = this.seen;
    seen.clear();
    this.badges.begin();
    for (const e of entities) {
      seen.add(e.id);
      let v = this.views.get(e.id);
      if (v && (this.kinds.get(e.id) !== e.kind || this.subs.get(e.id) !== e.sub)) {
        // id reused for a different thing (or a hero changed model) → rebuild
        v.dispose();
        this.views.delete(e.id);
        v = undefined;
      }
      if (!v) {
        const nv = this.create(e);
        if (!nv) continue;
        v = nv;
        this.views.set(e.id, v);
        this.kinds.set(e.id, e.kind);
        this.subs.set(e.id, e.sub);
        this.group.add(v.root);
      }
      try {
        v.update(e, ctx);
      } catch (err) {
        // never let one bad entity break the frame
        if (!(v as { _warned?: boolean })._warned) {
          (v as { _warned?: boolean })._warned = true;
          console.warn('[render] entity update failed', e.kind, e.sub, err);
        }
      }
    }
    // removals
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.views.delete(id);
      this.kinds.delete(id);
      this.subs.delete(id);
      if (v instanceof CharacterView && isCharacterKind(v.kind)) {
        const wasDead = (v.last.flags & VF_DEAD) !== 0 || v.last.hp <= 0 || this.died.has(id);
        if (wasDead && this.corpses.length < MAX_CORPSES) {
          v.corpse = true;
          v.corpseTime = 0;
          this.corpses.push(v);
          continue;
        }
      }
      v.dispose();
    }
    // corpses: finish the fall, then sink and vanish
    if (this.corpses.length) {
      const keep: CharacterView[] = [];
      for (const c of this.corpses) {
        c.corpseTime += ctx.dt;
        // the corpse keeps its own copy of the last snapshot (the sim may reuse ViewEntity objects)
        if (!c.corpseEnt) c.corpseEnt = { ...c.last, flags: c.last.flags | VF_DEAD, speed: 0 };
        const ce = c.corpseEnt;
        const sink = Math.max(0, c.corpseTime - (CORPSE_TIME - 1.5)) * 0.5;
        const baseY = c.corpseBaseY ?? (c.corpseBaseY = ce.y);
        ce.y = baseY - sink;
        c.update(ce, ctx);
        if (c.corpseTime < CORPSE_TIME) keep.push(c);
        else c.dispose();
      }
      this.corpses = keep;
    }
    this.badges.end();
    // forget old death notes
    if (this.died.size > 64) {
      for (const [id, t] of this.died) if (ctx.time - t > 10) this.died.delete(id);
    }
  }

  forEachCharacter(fn: (v: CharacterView) => void): void {
    for (const v of this.views.values()) if (v instanceof CharacterView) fn(v);
  }

  dispose(): void {
    for (const v of this.views.values()) v.dispose();
    for (const c of this.corpses) c.dispose();
    this.views.clear();
    this.kinds.clear();
    this.subs.clear();
    this.corpses = [];
    this.died.clear();
    this.seen.clear();
    this.badges.dispose();
  }
}
