import { it } from 'vitest';
import { createWorld } from '../../../src/sim/world';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { makeBotInit, realMap } from './harness';
const SEED = Number(process.env.AI_SEED ?? 1004);
const P = Number(process.env.AI_P ?? 5) as 5;
const MODE = (process.env.AI_MODE ?? 'chaos') as 'chaos';
const DIFF = (process.env.AI_DIFF ?? 'easy') as 'easy';
it('debug idle', () => {
  const bots: HeroBot[] = [];
  const init = makeBotInit({ players: P, mode: MODE, difficulty: DIFF, seed: SEED });
  const w = createWorld(init, { map: realMap(), onWarn: () => {}, botFactory: (s, d, sd) => { const b = new HeroBot(s, d, sd); bots[s] = b; return b; } });
  const out: string[] = [];
  const anchor = new Map<number, { x: number; z: number; t: number; modes: Set<string> }>();
  const worst = new Map<number, { dur: number; at: number; modes: string; pos: string; goal: string }>();
  while (!w.result() && w.time < 900) {
    w.step();
    for (const ev of w.drainEvents()) {
      if (ev.t === 'hit' && ev.amount > 0) { const v = w.get(ev.target); const a = ev.src !== undefined ? w.get(ev.src) : undefined; if (v?.hero && a?.hero && (v.hero.role === 'double' || v.hero.role === 'loyalist') && a.hero.role === 'lord') { const b = bots[a.hero.seat]; out.push(`${w.time.toFixed(2)} LORDHIT ${v.hero.role} amt ${ev.amount.toFixed(0)} ${ev.dtype} downed=${v.hero.downed} lordTarget=${b.target?.hero?.role ?? b.target?.kind} mode=${b.mode} hst=${b.hostility(v).toFixed(2)} ally=${b.allyScore(v).toFixed(2)}`); } }
      if (ev.t === 'death' && ev.kind === 'hero') { const e = w.get(ev.target)!; const k = ev.killer !== undefined ? w.get(ev.killer) : undefined; out.push(`${w.time.toFixed(1)} DEATH ${e.hero!.role}#${e.hero!.seat} by ${k?.hero ? k.hero.role + '#' + k.hero.seat : k?.kind ?? '-'}`); }
    }
    if (w.tick % 30 !== 0) continue;
    for (const h of w.heroList()) {
      const st = h.hero!; const b = bots[st.seat];
      if (st.dead || st.downed) { anchor.delete(h.id); continue; }
      const a = anchor.get(h.id);
      if (!a || Math.hypot(h.pos.x - a.x, h.pos.z - a.z) > 1.5) { anchor.set(h.id, { x: h.pos.x, z: h.pos.z, t: w.time, modes: new Set([b.mode]) }); continue; }
      a.modes.add(b.mode + (b.target ? '>' + (b.target.hero ? b.target.hero.role : b.target.kind) : ''));
      if (w.time > Number(process.env.AI_T0 ?? 380) && w.time < Number(process.env.AI_T1 ?? 440) && w.tick % 150 === 0) out.push(`${w.time.toFixed(0)} ${st.role}#${st.seat} ${b.mode} pos ${h.pos.x.toFixed(0)},${h.pos.z.toFixed(0)} goal ${JSON.stringify((b as any).goal ? { x: Math.round((b as any).goal.x), z: Math.round((b as any).goal.z) } : null)} hp ${h.hp.toFixed(0)}`);
      const dur = w.time - a.t;
      const wv = worst.get(h.id);
      if (!wv || dur > wv.dur) worst.set(h.id, { dur, at: a.t, modes: [...a.modes].join(','), pos: `${Math.round(h.pos.x)},${Math.round(h.pos.y)},${Math.round(h.pos.z)}`, goal: JSON.stringify((b as any).goal ? { x: Math.round((b as any).goal.x), z: Math.round((b as any).goal.z) } : null) + ' stuck=' + (b as any).nav.stuck + ' unreach=' + (b as any).nav.unreachable });
    }
  }
  out.push('RESULT ' + w.result()?.winner + ' ' + w.result()?.durationSec);
  for (const h of w.heroList()) { const v = worst.get(h.id); out.push(`${h.hero!.role}#${h.hero!.seat} ${h.hero!.heroId}: idle ${v?.dur.toFixed(0)}s from ${v?.at.toFixed(0)} modes ${v?.modes} pos ${v?.pos} goal ${v?.goal}`); }
  process.stdout.write(out.join('\n') + '\n');
}, 300000);
