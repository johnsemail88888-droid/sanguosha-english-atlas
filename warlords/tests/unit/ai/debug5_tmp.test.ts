import { it } from 'vitest';
import { createWorld } from '../../../src/sim/world';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { makeBotInit, realMap } from './harness';
import { isWalkable, nearestWalkable, locateNode, navNodePos } from '../../../src/sim/map/nav';
import { navOf } from '../../../src/sim/ai/navigator';
it('stuck debug', () => {
  const bots: HeroBot[] = [];
  const w = createWorld(makeBotInit({ players: 8, mode: 'standard', difficulty: 'hard', seed: 7043 }), { map: realMap(), onWarn: () => {}, botFactory: (s, d, sd) => { const b = new HeroBot(s, d, sd); bots[s] = b; return b; } });
  const out: string[] = [];
  const me = w.heroList()[1];
  while (w.time < 200) {
    w.step(); w.drainEvents();
    if (w.time > 160 && w.tick % 15 === 0) {
      const b = bots[1] as any;
      out.push(`${w.time.toFixed(1)} pos ${me.pos.x.toFixed(2)},${me.pos.y.toFixed(2)},${me.pos.z.toFixed(2)} vel ${me.vel.x.toFixed(1)},${me.vel.y.toFixed(1)},${me.vel.z.toFixed(1)} onGround ${me.onGround} mode ${b.mode} goal ${JSON.stringify(b.goal && { x: Math.round(b.goal.x), y: Math.round(b.goal.y), z: Math.round(b.goal.z) })} stuck ${b.nav.stuck} unreach ${b.nav.unreachable} path ${b.nav.path ? b.nav.path.length + '@' + b.nav.idx + ' next ' + JSON.stringify(b.nav.path[b.nav.idx]) : 'none'} direct ${b.nav.direct}`);
    }
  }
  const nav = navOf(w)!;
  out.push('walkable ' + isWalkable(nav, me.pos) + ' nearest ' + JSON.stringify(nearestWalkable(nav, me.pos)) + ' node ' + locateNode(nav, me.pos));
  const cols = w.map.colliders.filter((c) => c.kind === 'box' ? Math.hypot(c.cx - me.pos.x, c.cz - me.pos.z) < 12 : Math.hypot(c.x - me.pos.x, c.z - me.pos.z) < 6);
  out.push('colliders ' + JSON.stringify(cols));
  const props = w.map.props.filter((p) => Math.hypot(p.x - me.pos.x, p.z - me.pos.z) < 15).map((p) => `${p.type}@${p.x.toFixed(0)},${p.y.toFixed(1)},${p.z.toFixed(0)} rot ${p.rot.toFixed(2)} s ${p.sx},${p.sy},${p.sz}`);
  out.push('props ' + props.join(' | '));
  out.push('ground ' + w.groundHeight(me.pos.x, me.pos.z) + ' water ' + w.map.waterLevel);
  process.stdout.write(out.join('\n') + '\n');
}, 300000);
