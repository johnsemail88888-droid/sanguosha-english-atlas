// Item implementation registry (三国杀 cards as consumables). Item files call
// registerItem() at import time; items/index.ts imports them all.
import type { ItemImplEx } from '../ext';

export type { ItemImplEx } from '../ext';

const REGISTRY = new Map<string, ItemImplEx>();

export function registerItem(impl: ItemImplEx): void {
  REGISTRY.set(impl.id, impl);
}

export function getItem(id: string): ItemImplEx | undefined {
  return REGISTRY.get(id);
}

export function hasItem(id: string): boolean {
  return REGISTRY.has(id);
}

export function registeredItemIds(): string[] {
  return [...REGISTRY.keys()];
}
