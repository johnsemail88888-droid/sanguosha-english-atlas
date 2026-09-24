import { it } from 'vitest';
import type { GameEvent, MatchSettings, RoleId } from '../../../src/core/types';
import { defaultSettings } from '../../../src/core/types';
import { HEROES } from '../../../src/data';
import type { ItemImplEx } from '../../../src/sim/ext';
import { getItem } from '../../../src/sim/items';
import type { MatchInit } from '../../../src/sim/host';
import { createWorld } from '../../../src/sim/world';

function botInit(roles: RoleId[], seed: number, patch: Partial<MatchSettings> = {}): MatchInit {
  const heroes = HEROES.map((h) => h.id);
  return {
    settings: { ...defaultSettings(), playerCount: roles.length as 8, botDifficulty: 'hard', ...patch },
    seed,
    seats: roles.map((role, i) => ({ seat: i, playerId: `bot-${i}`, name: `Bot ${i}`, isBot: true, role, heroId: heroes[(i * 7 + seed) % heroes.length] })),
  };
}

const IDS = ['lebusishu', 'bingliang', 'juedou', 'zhengbing', 'guohe', 'jiedao'];

it('probe', () => {
  const seeds = (process.env.SEEDS ?? '31').split(',').map(Number);
  const secs = Number(process.env.SECS ?? 900);
  const counts: Record<string, [number, number, number]> = {};
  const orig = new Map<string, ItemImplEx['botShouldUse']>();
  for (const id of IDS) {
    const impl = getItem(id) as ItemImplEx;
    orig.set(id, impl.botShouldUse);
    counts[id] = [0, 0, 0];
    const f = impl.botShouldUse!;
    impl.botShouldUse = (sim, self) => {
      const r = f.call(impl, sim, self);
      counts[id][1]++;
      if (r) counts[id][0]++;
      return r;
    };
  }
  const reasons: Record<string, number> = {};
  const held: Record<string, number> = {};
  const jd = getItem('juedou') as ItemImplEx;
  const jf = jd.botShouldUse!;
  jd.botShouldUse = (sim, self) => {
    const r = jf.call(jd, sim, self);
    const t = sim.get(sim.inputOf(self).aimTargetId);
    const k = !t ? 'noaim' : t.kind !== 'hero' ? 'aim:' + t.kind : sim.isOwnSide(self, t) ? 'ownside' : t.hero!.downed ? 'downed' : !sim.lineOfSight(sim.eyePos(self), t.pos) ? 'nolos?' : Math.hypot(t.pos.x - self.pos.x, t.pos.z - self.pos.z) > 20 ? 'far' : `hp me=${(self.hp / self.maxHp).toFixed(1)} them=${(t.hp / t.maxHp).toFixed(1)} r=${r}`;
    reasons[k] = (reasons[k] ?? 0) + 1;
    return r;
  };
  try {
    for (const seed of seeds) {
      const roles: RoleId[] = ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'traitor'];
      const t0 = performance.now();
      const w = createWorld(botInit(roles, seed), { onWarn: () => {} });
      let traps = 0; let sprung = 0;
      for (let i = 0; i < secs * 30 && !w.result(); i++) {
        if (process.env.INJECT && i % 300 === 0) for (const h of w.heroList()) { if (!h.hero!.dead) { const s = h.hero!.items; const k = (i / 300) % 3; s[3] = { id: k === 0 ? 'lebusishu' : k === 1 ? 'bingliang' : 'juedou', count: 1 }; } }
        if (i % 300 === 0) for (const h of w.heroList()) if (!h.hero!.dead) for (const st of h.hero!.items) if (st && IDS.includes(st.id)) held[st.id] = (held[st.id] ?? 0) + 1;
        w.step();
        for (const ev of w.drainEvents() as GameEvent[]) {
          if (ev.t === 'itemUse' && IDS.includes(ev.item)) counts[ev.item][2]++;
          if (ev.t === 'sfx' && ev.name === 'trap') sprung++;
        }
        traps = Math.max(traps, w.kindList('hazard').filter((h) => h.hazard!.kind.endsWith('Trap')).length);
      }
      console.log(`seed ${seed}: ${((performance.now() - t0) / 1000).toFixed(1)}s wall, t=${w.time.toFixed(0)} maxLiveTraps=${traps} sprung=${sprung}`);
    }
    console.log(JSON.stringify(counts));
    console.log('held', JSON.stringify(held));
    console.log(JSON.stringify(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 25)));
  } finally {
    for (const id of IDS) (getItem(id) as ItemImplEx).botShouldUse = orig.get(id);
    jd.botShouldUse = jf;
  }
}, 900000);
