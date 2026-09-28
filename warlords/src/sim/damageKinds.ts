// What kind of hit a DamageRequest is, for the rules that care (a leaf module: combat.ts, the
// ability hooks 鬼才 / 倾国 / 流离 and the tests all share one definition).
import type { DamageRequest } from './api';

/**
 * A weapon bullet: any direct hit of a weapon (hitscan bullet, pellet, arrow, rocket or flame
 * stream striking the body) — the hits armor, 八卦, 鬼才, 倾国 and 流离 care about. Not an
 * explosion's area damage (`splash`), the zone, 'true' HP loss or a melee blow (a troop's
 * sword is not a bullet: no armor reduction, 藤甲 immunity, 八卦 dodge or 仁王 block).
 * Fire bullets count (藤甲 then skips its bullet reduction and applies only its fire ×).
 */
export const isBulletDamage = (req: DamageRequest): boolean =>
  req.weaponId !== undefined && req.splash !== true && req.type !== 'zone' && req.type !== 'true' && req.type !== 'melee';
