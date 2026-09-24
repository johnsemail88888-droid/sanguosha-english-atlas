import { it } from 'vitest';
import { createWorld } from '../../../src/sim/world';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { makeBotInit, realMap } from './harness';
const SEED = Number(process.env.AI_SEED ?? 1000);
const P = Number(process.env.AI_P ?? 5) as 5;
const MODE = (process.env.AI_MODE ?? 'standard') as 'chaos';
const DIFF = (process.env.AI_DIFF ?? 'easy') as 'easy';
it('debug lord kills', () => {
  const bots: HeroBot[] = [];
  const init = makeBotInit({ players: P, mode: MODE, difficulty: DIFF, seed: SEED });
  const w = createWorld(init, { map: realMap(), onWarn: () => {}, botFactory: (s, d, sd) => { const b = new HeroBot(s, d, sd); bots[s] = b; return b; } });
  const out: string[] = [];
  const role = (id?: number) => { const e = id !== undefined ? w.get(id) : undefined; return e?.hero ? `${e.hero.role}#${e.hero.seat}` : e ? `${e.kind}${id}` : '-'; };
  while (!w.result() && w.time < 900) {
    w.step();
    for (const ev of w.drainEvents()) {
      if (ev.t === 'hit' && ev.amount > 0) { const v = w.get(ev.target); const a = ev.src !== undefined ? w.get(ev.src) : undefined; if (v?.hero && a?.hero && (v.hero.role === 'double' || v.hero.role === 'loyalist') && a.hero.role === 'lord') { const b = bots[a.hero.seat]; out.push(`${w.time.toFixed(2)} LORDHIT ${role(v.id)} amt ${ev.amount.toFixed(0)} ${ev.dtype} downed=${v.hero.downed} lordTarget=${role(b.target?.id)} mode=${b.mode} hst=${b.hostility(v).toFixed(2)} ally=${b.allyScore(v).toFixed(2)} ev=${JSON.stringify(b.beliefs.evidence(v.id))}`); } }
      if (ev.t === 'hit' && ev.amount > 0) { const v = w.get(ev.target); const a = ev.src !== undefined ? w.get(ev.src) : undefined; if (v?.hero && a?.hero && v.hero.role === 'lord' && (a.hero.role === 'double' || a.hero.role === 'loyalist')) { const b = bots[a.hero.seat]; out.push(`${w.time.toFixed(2)} HITLORD by ${role(a.id)} amt ${ev.amount.toFixed(0)} ${ev.dtype} their target=${role(b.target?.id)} mode=${b.mode} hstLord=${b.hostility(v).toFixed(2)}`); } }
      if (ev.t === 'death' && ev.kind === 'hero') out.push(`${w.time.toFixed(1)} DEATH ${role(ev.target)} by ${role(ev.killer)}`);
      if (ev.t === 'claim') out.push(`${w.time.toFixed(1)} CLAIM ${role(ev.who)} ${ev.role}`);
      if (ev.t === 'itemUse') { const a = w.get(ev.who); if (a?.hero?.role === 'lord') out.push(`${w.time.toFixed(1)} LORD ITEM ${ev.item}`); }
      if (ev.t === 'ability') { const a = w.get(ev.src); if (a?.hero?.role === 'lord') out.push(`${w.time.toFixed(1)} LORD ABILITY ${ev.ability}`); }
    }
  }
  out.push('RESULT ' + w.result()?.winner + ' ' + w.result()?.durationSec + ' lord=' + w.heroList()[0].hero!.heroId);
  process.stdout.write(out.join('\n') + '\n');
}, 300000);
