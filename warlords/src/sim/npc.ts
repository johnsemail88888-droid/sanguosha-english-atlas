// NPCs: 黄巾 camps, summons (南蛮入侵, 黄巾力士…), disbanded squads.
import type { Vec3 } from '../core/math';
import type { Entity, EntityId } from '../core/types';
import { newIntent, resetIntent } from './ai/types';
import type { NpcBrain } from './ai/types';
import { troopDef, weaponDef } from './defs';
import { findFreeSpot } from './physics';
import { driveUnit, unitSize } from './troops';
import type { World } from './world';

export const CAMP_LEASH = 30;

export function spawnNpcEntity(
  w: World,
  npcType: string,
  pos: Vec3,
  opts: { summonerId?: EntityId; lifetime?: number; leash?: number } = {},
): Entity {
  const def = troopDef(npcType, 'neutral');
  const size = unitSize(def);
  const p = findFreeSpot(w.cw, pos, size.radius, size.height, 10);
  const summoner = opts.summonerId !== undefined ? w.get(opts.summonerId) : undefined;
  const e = w.createEntity('npc', p, {
    radius: size.radius,
    height: size.height,
    hp: def.hp,
    kingdom: def.kingdom === 'neutral' ? undefined : def.kingdom,
    ownerId: summoner ? summoner.id : undefined,
    yaw: w.rng.next() * Math.PI * 2,
  });
  const weapon = weaponDef(def.weapon);
  e.npc = {
    npcType: def.id,
    home: { x: p.x, y: p.y, z: p.z },
    leash: opts.leash ?? (summoner ? 1000 : CAMP_LEASH),
    nextFireAt: w.time + 0.4 + w.rng.next() * 0.6,
    summonerId: summoner?.id,
    expiresAt: opts.lifetime !== undefined && opts.lifetime > 0 ? w.time + opts.lifetime : undefined,
    ai: { mag: weapon.magSize, reloadUntil: 0 },
  };
  return e;
}

const intent = newIntent();
const fire = { nextFireAt: 0, mag: 0, reloadUntil: 0 };

export function updateNpcs(w: World, list: readonly Entity[], brain: NpcBrain, dt: number): void {
  const now = w.time;
  for (const u of list) {
    const npc = u.npc;
    if (!u.alive || !npc) continue;
    if (npc.expiresAt !== undefined && now >= npc.expiresAt) {
      // summons and disbanded troops simply vanish
      w.removeEntity(u.id);
      continue;
    }
    const def = troopDef(npc.npcType);
    resetIntent(intent);
    try {
      brain.think(w, u, dt, intent);
    } catch (err) {
      w.warn('npcBrain', `npc brain threw: ${String(err)}`);
    }
    const weapon = weaponDef(def.weapon);
    fire.nextFireAt = npc.nextFireAt;
    fire.mag = npc.ai.mag ?? weapon.magSize;
    fire.reloadUntil = npc.ai.reloadUntil ?? 0;
    driveUnit(w, u, intent, def.speed, weapon, def.accuracy, def.attackRange, fire, 1, dt);
    npc.nextFireAt = fire.nextFireAt;
    npc.ai.mag = fire.mag;
    npc.ai.reloadUntil = fire.reloadUntil;
  }
}
