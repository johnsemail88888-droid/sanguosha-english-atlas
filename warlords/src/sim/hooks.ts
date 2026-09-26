// Dispatch of AbilityImpl(Ex) hooks for a hero's abilities. Lord-slot
// abilities are only present on the real lord (filtered at spawn). Every call
// is isolated: a throwing hook is warned about once and treated as a no-op, so
// a buggy ability can never take the host down.
import type { Entity, EntityId, StatusId } from '../core/types';
import type { AbilityDef } from '../data/types';
import type { AbilityCtx, DamageHookCtx, DamageRequest } from './api';
import { warnOnce } from './defs';
import type { AbilityImplEx, ResolvedModifiers } from './ext';
import { defaultModifiers, foldModifiers } from './ext';
import type { World } from './world';

export interface AbilityEntry {
  def: AbilityDef;
  impl: AbilityImplEx | undefined;
}

/**
 * Dispatches AbilityImpl(Ex) hooks for a hero's abilities (lord-slot
 * abilities only when the hero is the real lord), isolating exceptions.
 */
export class HookDispatcher {
  constructor(private readonly w: World) {}

  private entries(e: Entity): AbilityEntry[] {
    return this.w.heroRt(e.id)?.abilities ?? [];
  }

  private ctx(e: Entity, entry: AbilityEntry): AbilityCtx {
    return this.w.abilityCtx(e, entry.def);
  }

  /**
   * Run one hook of `self`'s ability: exceptions are isolated, and `self` is
   * the acting hero meanwhile (source of source-less effects such as
   * knockback / takeRandomItem for nullify and vetoes).
   */
  private safe<T>(self: Entity, entry: AbilityEntry, hook: string, fn: () => T, fallback: T): T {
    const w = this.w;
    const prev = w.actorId;
    w.actorId = self.id;
    try {
      return fn();
    } catch (err) {
      warnOnce(`hook:${entry.def.id}:${hook}`, `ability '${entry.def.id}' ${hook} threw: ${String(err)}`);
      return fallback;
    } finally {
      w.actorId = prev;
    }
  }

  tick(e: Entity, dt: number): void {
    for (const en of this.entries(e)) {
      const f = en.impl?.tick;
      if (f) this.safe(e, en, 'tick', () => f.call(en.impl, this.ctx(e, en), dt), undefined);
    }
  }

  modifiers(e: Entity): ResolvedModifiers {
    const acc = defaultModifiers();
    for (const en of this.entries(e)) {
      const f = en.impl?.modifiers;
      if (f) foldModifiers(acc, this.safe(e, en, 'modifiers', () => f.call(en.impl, this.ctx(e, en)), undefined));
    }
    return acc;
  }

  speedMul(e: Entity): number {
    let m = 1;
    for (const en of this.entries(e)) {
      const f = en.impl?.speedMul;
      if (f) {
        const v = this.safe(e, en, 'speedMul', () => f.call(en.impl, this.ctx(e, en)), 1);
        if (Number.isFinite(v) && v >= 0) m *= v;
      }
    }
    return m;
  }

  private dmgCtx(e: Entity, en: AbilityEntry, req: DamageRequest, other: Entity | undefined): DamageHookCtx {
    return { ...this.ctx(e, en), req, other };
  }

  beforeDamageDealt(src: Entity, target: Entity, req: DamageRequest): void {
    for (const en of this.entries(src)) {
      const f = en.impl?.beforeDamageDealt;
      if (f) this.safe(src, en, 'beforeDamageDealt', () => f.call(en.impl, this.dmgCtx(src, en, req, target)), undefined);
    }
  }

  modifyOutgoing(src: Entity, target: Entity, req: DamageRequest, amount: number): number {
    let a = amount;
    for (const en of this.entries(src)) {
      const f = en.impl?.modifyOutgoing;
      if (f) {
        const v = this.safe(src, en, 'modifyOutgoing', () => f.call(en.impl, this.dmgCtx(src, en, req, target), a), a);
        if (Number.isFinite(v)) a = Math.max(0, v);
      }
    }
    return a;
  }

  modifyIncoming(target: Entity, src: Entity | undefined, req: DamageRequest, amount: number): number {
    let a = amount;
    for (const en of this.entries(target)) {
      const f = en.impl?.modifyIncoming;
      if (f) {
        const v = this.safe(target, en, 'modifyIncoming', () => f.call(en.impl, this.dmgCtx(target, en, req, src), a), a);
        if (Number.isFinite(v)) a = Math.max(0, v);
      }
    }
    return a;
  }

  onDamageTaken(target: Entity, src: Entity | undefined, req: DamageRequest, dealt: number): void {
    for (const en of this.entries(target)) {
      const f = en.impl?.onDamageTaken;
      if (f) this.safe(target, en, 'onDamageTaken', () => f.call(en.impl, this.dmgCtx(target, en, req, src), dealt), undefined);
    }
  }

  onDamageDealt(src: Entity, target: Entity, req: DamageRequest, dealt: number): void {
    for (const en of this.entries(src)) {
      const f = en.impl?.onDamageDealt;
      if (f) this.safe(src, en, 'onDamageDealt', () => f.call(en.impl, this.dmgCtx(src, en, req, target), dealt), undefined);
    }
  }

  onKill(killer: Entity, victim: Entity): void {
    for (const en of this.entries(killer)) {
      const f = en.impl?.onKill;
      if (f) this.safe(killer, en, 'onKill', () => f.call(en.impl, this.ctx(killer, en), victim), undefined);
    }
  }

  onFire(e: Entity, weaponId: string): void {
    for (const en of this.entries(e)) {
      const f = en.impl?.onFire;
      if (f) this.safe(e, en, 'onFire', () => f.call(en.impl, this.ctx(e, en), weaponId), undefined);
    }
  }

  onMagEmpty(e: Entity, weaponId: string): void {
    for (const en of this.entries(e)) {
      const f = en.impl?.onMagEmpty;
      if (f) this.safe(e, en, 'onMagEmpty', () => f.call(en.impl, this.ctx(e, en), weaponId), undefined);
    }
  }

  onItemUsed(e: Entity, itemId: string): void {
    for (const en of this.entries(e)) {
      const f = en.impl?.onItemUsed;
      if (f) this.safe(e, en, 'onItemUsed', () => f.call(en.impl, this.ctx(e, en), itemId), undefined);
    }
  }

  /** true = a hook prevented the downed state */
  onDowned(e: Entity): boolean {
    for (const en of this.entries(e)) {
      const f = en.impl?.onDowned;
      if (f && this.safe(e, en, 'onDowned', () => f.call(en.impl, this.ctx(e, en)) === true, false)) return true;
    }
    return false;
  }

  onOtherDowned(victim: Entity): void {
    for (const e of this.w.heroList()) {
      if (e === victim || e.hero!.dead) continue;
      for (const en of this.entries(e)) {
        const f = en.impl?.onOtherDowned;
        if (f) this.safe(e, en, 'onOtherDowned', () => f.call(en.impl, this.ctx(e, en), victim), undefined);
      }
    }
  }

  canBeAffected(target: Entity, status: StatusId | 'steal', sourceId?: EntityId): boolean {
    if (!target.hero) return true;
    for (const en of this.entries(target)) {
      const f = en.impl?.canBeAffected;
      if (f && this.safe(target, en, 'canBeAffected', () => f.call(en.impl, this.ctx(target, en), status, sourceId) === false, false)) return false;
    }
    return true;
  }

  onDodge(e: Entity): void {
    for (const en of this.entries(e)) {
      const f = en.impl?.onDodge;
      if (f) this.safe(e, en, 'onDodge', () => f.call(en.impl, this.ctx(e, en)), undefined);
    }
  }

  onHealGiven(healer: Entity, target: Entity, amount: number): void {
    for (const en of this.entries(healer)) {
      const f = en.impl?.onHealGiven;
      if (f) this.safe(healer, en, 'onHealGiven', () => f.call(en.impl, this.ctx(healer, en), target, amount), undefined);
    }
  }

  modifyHealTaken(e: Entity, amount: number, sourceId?: EntityId): number {
    let a = amount;
    for (const en of this.entries(e)) {
      const f = en.impl?.modifyHealTaken;
      if (f) {
        const v = this.safe(e, en, 'modifyHealTaken', () => f.call(en.impl, this.ctx(e, en), a, sourceId), a);
        if (Number.isFinite(v)) a = Math.max(0, v);
      }
    }
    return a;
  }

  canReviveFree(e: Entity): boolean {
    for (const en of this.entries(e)) {
      const f = en.impl?.canReviveFree;
      if (f && this.safe(e, en, 'canReviveFree', () => f.call(en.impl, this.ctx(e, en)) === true, false)) return true;
    }
    return false;
  }

  onRevive(e: Entity, target: Entity, free: boolean): void {
    for (const en of this.entries(e)) {
      const f = en.impl?.onRevive;
      if (f) this.safe(e, en, 'onRevive', () => f.call(en.impl, this.ctx(e, en), target, free), undefined);
    }
  }

  /** combined victim-side bullet evasion chance from bulletEvadeChance hooks (1 − Π(1 − p)) */
  bulletEvadeChance(target: Entity, src: Entity | undefined, req: DamageRequest): number {
    let keep = 1;
    for (const en of this.entries(target)) {
      const f = en.impl?.bulletEvadeChance;
      if (!f) continue;
      const v = this.safe(target, en, 'bulletEvadeChance', () => f.call(en.impl, this.dmgCtx(target, en, req, src)), 0);
      if (Number.isFinite(v) && v > 0) keep *= 1 - Math.min(1, v);
    }
    return 1 - keep;
  }

  onEquipmentLost(e: Entity, what: 'armor' | 'mount', id: string): void {
    for (const en of this.entries(e)) {
      const f = en.impl?.onEquipmentLost;
      if (f) this.safe(e, en, 'onEquipmentLost', () => f.call(en.impl, this.ctx(e, en), what, id), undefined);
    }
  }
}
