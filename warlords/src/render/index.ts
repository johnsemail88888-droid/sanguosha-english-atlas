// Public surface of the render module (named exports only).
export { GameRenderer } from './renderer';
export type { GameRendererOptions, RenderStats } from './renderer';
export { registerAbilityVfx } from './vfx/abilities';
export type { AbilityVfxFn, AbilityVfxContext, AbilityEvent } from './vfx/abilities';
export type { Effects, BurstOptions } from './vfx/effects';
export { renderHeroPortrait, clearPortraitCache } from './portrait';
export { mountHeroTurntable } from './turntable';
export type { TurntableHandle } from './turntable';
export { mountGameView } from './mountGame';
export type { GameViewHandle, MountGameOptions } from './mountGame';
export { createHeroModel, createTroopModel, createWeaponModel, disposeModel, registerHeroGlb } from './models';
export { HERO_VIEW_RANGE, QUALITY_PRESETS, qualityPreset } from './quality';
export type { ViewSource } from './view';
