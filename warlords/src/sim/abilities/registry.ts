// Ability implementation registry. Kingdom files (shu.ts, wei.ts, wu.ts,
// qun.ts) call registerAbility() at import time; abilities/index.ts imports
// them all. The world looks implementations up by AbilityDef.id.
import type { AbilityImplEx } from '../ext';

export type { AbilityImplEx, HeroModifiers } from '../ext';

const REGISTRY = new Map<string, AbilityImplEx>();

/** Register (or replace, e.g. hot reload / wave-2 override) an ability implementation. */
export function registerAbility(impl: AbilityImplEx): void {
  REGISTRY.set(impl.id, impl);
}

export function getAbility(id: string): AbilityImplEx | undefined {
  return REGISTRY.get(id);
}

export function hasAbility(id: string): boolean {
  return REGISTRY.has(id);
}

export function registeredAbilityIds(): string[] {
  return [...REGISTRY.keys()];
}
