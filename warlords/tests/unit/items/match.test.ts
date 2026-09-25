// Real matches on the generated map: bots actually reach for the situational
// cards (traps, duels, conscription) instead of carrying them all game, and no
// item implementation throws. Counts the item hints' own "yes" answers
// (botShouldUse), not the AI planner's decisions, so AI tuning elsewhere does
// not move these numbers much.
import { describe, expect, it } from 'vitest';
import type { GameEvent, MatchSettings, RoleId } from '../../../src/core/types';
import { defaultSettings } from '../../../src/core/types';
import { HEROES } from '../../../src/data';
import type { ItemImplEx } from '../../../src/sim/ext';
import type { MatchInit } from '../../../src/sim/host';
import { getItem } from '../../../src/sim/items';
import { createWorld } from '../../../src/sim/world';

const ROLES8: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
/** cards handed out in turn (slot 4) to every living bot every 10 s */
const DEAL = ['lebusishu', 'bingliang', 'juedou', 'zhengbing'];
const SEEDS = [64, 77];
const SECONDS = 150;

function botInit(seed: number, patch: Partial<MatchSettings> = {}): MatchInit {
  const heroes = HEROES.map((h) => h.id);
  return {
    settings: { ...defaultSettings(), playerCount: 8, botDifficulty: 'hard', ...patch },
    seed,
    seats: ROLES8.map((role, i) => ({ seat: i, playerId: `bot-${i}`, name: `Bot ${i}`, isBot: true, role, heroId: heroes[(i * 7 + seed) % heroes.length] })),
  };
}

describe('item hints in real 8-bot matches', () => {
  it('bots lay traps, accept duels and recruit with 征兵令; nothing throws', () => {
    const yes: Record<string, number> = {};
    const asked: Record<string, number> = {};
    const played: Record<string, number> = {};
    const saved = new Map<string, ItemImplEx['botShouldUse']>();
    for (const id of DEAL) {
      const impl = getItem(id) as ItemImplEx;
      const hint = impl.botShouldUse!;
      saved.set(id, hint);
      yes[id] = asked[id] = played[id] = 0;
      impl.botShouldUse = (sim, self) => {
        const r = hint.call(impl, sim, self);
        asked[id]++;
        if (r) yes[id]++;
        return r;
      };
    }
    const warnings: string[] = [];
    let sprung = 0;
    try {
      for (const seed of SEEDS) {
        const w = createWorld(botInit(seed), { onWarn: (m) => warnings.push(m) });
        for (let i = 0; i < SECONDS * 30 && !w.result(); i++) {
          if (i % 300 === 0) {
            const id = DEAL[(i / 300) % DEAL.length];
            // (not mid-channel: swapping the card being played would play the new one)
            for (const h of w.heroList()) if (!h.hero!.dead && !h.hero!.downed && !h.hero!.channel) h.hero!.items[3] = { id, count: 1 };
          }
          w.step();
          for (const ev of w.drainEvents() as GameEvent[]) {
            if (ev.t === 'itemUse' && ev.item in played) played[ev.item]++;
            if (ev.t === 'sfx' && ev.name === 'trap') sprung++;
          }
        }
      }
    } finally {
      for (const [id, hint] of saved) (getItem(id) as ItemImplEx).botShouldUse = hint;
    }
    console.log(`[items/match] hint yes/asked ${DEAL.map((id) => `${id} ${yes[id]}/${asked[id]}`).join(', ')}; played ${JSON.stringify(played)}; traps sprung ${sprung}`);
    expect(warnings.filter((m) => /threw|NaN|non-finite/.test(m))).toEqual([]);
    for (const id of DEAL) expect(yes[id], `${id} hint said yes`).toBeGreaterThan(0);
    expect(played.lebusishu + played.bingliang, 'traps laid').toBeGreaterThan(0);
  }, 240_000);
});
