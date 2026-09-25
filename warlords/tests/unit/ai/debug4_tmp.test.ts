import { it } from 'vitest';
import type { RoleId } from '../../../src/core/types';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { createWorld } from '../../../src/sim/world';
import { hero, makeInit } from '../sim/helpers';
import { realMap } from './harness';
it('zone debug', () => {
  const roles: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
  let bot: HeroBot | undefined;
  const w = createWorld(makeInit(roles, ['caocao', 'guanyu', 'guanyu', 'guanyu', 'guanyu'], {}, [0, 1, 3, 4]), { map: realMap(), ambient: false, airdrops: false, squads: false, zone: true, onWarn: () => {}, botFactory: (s, d, sd) => { const b = new HeroBot(s, d, sd); if (s === 2) bot = b; return b; } });
  const me = hero(w, 2);
  while (w.time < 262) { w.step(); w.drainEvents(); }
  const z0 = w.zoneView();
  const dx = -z0.center.x, dz = -z0.center.z; const l = Math.hypot(dx, dz) || 1;
  const out = { x: z0.center.x - (dx / l) * (z0.radius + 25), z: z0.center.z - (dz / l) * (z0.radius + 25) };
  const c = (v: number) => Math.max(-145, Math.min(145, v));
  w.teleport(me.id, { x: c(out.x), y: w.groundHeight(c(out.x), c(out.z)), z: c(out.z) });
  const lines: string[] = [`zone ${JSON.stringify(z0)} me ${JSON.stringify(me.pos)}`];
  for (let t = 0; t < 30 * 40; t++) {
    w.step();
    if (t % 60 === 0) { const z = w.zoneView(); lines.push(`${w.time.toFixed(0)} pos ${me.pos.x.toFixed(0)},${me.pos.y.toFixed(0)},${me.pos.z.toFixed(0)} hp ${me.hp.toFixed(0)} dead ${me.hero!.dead} mode ${bot!.mode} goal ${JSON.stringify((bot as any).goal)} dz ${(Math.hypot(me.pos.x - z.center.x, me.pos.z - z.center.z) - z.radius).toFixed(0)} stuck ${(bot as any).nav.stuck}`); }
  }
  process.stdout.write(lines.join('\n') + '\n');
});
