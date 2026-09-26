// Headless 8-bot matches with only 蜀 Shu heroes on the generated map: the
// abilities get used by bots in real fights and the match reaches a valid
// result without a single isolated exception.
import { describe, expect, it } from 'vitest';
import type { GameEvent, RoleId } from '../../../src/core/types';
import { defaultSettings } from '../../../src/core/types';
import { ROLE_BY_ID } from '../../../src/data';
import { SHU_HEROES } from '../../../src/data/heroes-shu';
import { FAILSAFE_TIME } from '../../../src/sim/rules';
import { createWorld } from '../../../src/sim/world';

const ROLES8: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
const SHU_IDS = new Set(SHU_HEROES.flatMap((h) => h.abilities.map((a) => a.id)));

function play(seed: number, rotate: number): { casts: Map<string, number>; warnings: string[]; winner: string; duration: number } {
  const heroes = SHU_HEROES.map((h) => h.id);
  const warnings: string[] = [];
  const w = createWorld(
    {
      settings: { ...defaultSettings(), playerCount: 8 },
      seed,
      seats: ROLES8.map((role, i) => ({
        seat: i,
        playerId: `bot-${i}`,
        name: `Bot ${i}`,
        isBot: true,
        role,
        heroId: heroes[(i + rotate) % heroes.length],
      })),
    },
    { onWarn: (m) => warnings.push(m) },
  );
  const casts = new Map<string, number>();
  const maxTicks = Math.ceil((FAILSAFE_TIME + 5) * 30);
  for (let i = 0; i < maxTicks && !w.result(); i++) {
    w.step();
    const ev: GameEvent[] = w.drainEvents();
    for (const e of ev) if (e.t === 'ability' && SHU_IDS.has(e.ability)) casts.set(e.ability, (casts.get(e.ability) ?? 0) + 1);
    // sanity: nobody ever ends up with a non-finite position / HP
    if (i % 30 === 0) {
      for (const h of w.heroList()) {
        expect(Number.isFinite(h.pos.x + h.pos.y + h.pos.z + h.hp + h.shield)).toBe(true);
        expect(h.hp).toBeLessThanOrEqual(h.maxHp + 1e-6);
      }
    }
  }
  const res = w.result();
  expect(res, 'match finished').toBeTruthy();
  for (const id of res!.winners) {
    const f = ROLE_BY_ID[res!.roles[id]].faction;
    expect(f === res!.winner || f === 'neutral').toBe(true);
  }
  return { casts, warnings, winner: res!.winner, duration: res!.durationSec };
}

describe('8-bot 蜀-only matches', () => {
  it('finish with a valid result, bots use the Shu abilities, and nothing throws', () => {
    const all = new Map<string, number>();
    for (const [seed, rotate] of [
      [101, 0], // 刘备 is the Lord (激将 available)
      [202, 3],
      [303, 5],
    ]) {
      const r = play(seed, rotate);
      process.stdout.write(`[shu-match] seed ${seed}: ${r.winner} after ${r.duration}s, casts ${JSON.stringify(Object.fromEntries(r.casts))}\n`);
      expect(r.warnings.filter((m) => /threw|non-finite/.test(m)), `seed ${seed}`).toEqual([]);
      for (const [k, v] of r.casts) all.set(k, (all.get(k) ?? 0) + v);
    }
    // bots exercised most of the kit (actives + event-emitting passives)
    expect(all.size).toBeGreaterThanOrEqual(12);
  }, 180_000);
});
