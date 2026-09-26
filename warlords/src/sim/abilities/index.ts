// Imports every kingdom file so their registerAbility() calls run.
import './shu';
import './wei';
import './wu';
import './qun';

export { getAbility, hasAbility, registerAbility, registeredAbilityIds } from './registry';
export type { AbilityImplEx, HeroModifiers } from './registry';
