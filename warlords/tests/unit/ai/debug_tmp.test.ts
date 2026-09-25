import { it } from 'vitest';
import { createWorld } from '../../../src/sim/world';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { makeBotInit, realMap } from './harness';
const SEED = Number(process.env.AI_SEED ?? 1000);
it('debug', () => {
  const bots: HeroBot[] = [];
  const init = makeBotInit({ players: Number(process.env.AI_P ?? 8) as 8, mode: (process.env.AI_MODE ?? 'standard') as 'standard', difficulty: (process.env.AI_DIFF ?? 'normal') as 'normal', seed: SEED });
  const w = createWorld(init, { map: realMap(), onWarn: () => {}, botFactory: (s, d, sd) => { const b = new HeroBot(s, d, sd); bots[s] = b; return b; } });
  const out: string[] = [];
  const role = (id?: number) => { const e = id !== undefined ? w.get(id) : undefined; return e?.hero ? `${e.hero.role}#${e.hero.seat}` : e ? `${e.kind}${id}` : '-'; };
  const firstPair = new Set<string>();
  const b_ent = (id: number) => w.get(id)!;
  while (!w.result() && w.time < 900) {
    w.step();
    for (const ev of w.drainEvents()) {
      if (ev.t === 'hit' && ev.amount > 0 && ev.src !== undefined) {
        const a = w.get(ev.src); const b = w.get(ev.target);
        if (a?.hero && b?.hero) { const k = role(ev.src) + '>' + role(ev.target); if (!firstPair.has(k)) { firstPair.add(k); const b = bots[a.hero.seat]; out.push(`${w.time.toFixed(1)} FIRST HIT ${k} (${ev.dtype} ${a.hero.heroId}/${a.hero.weapons[a.hero.activeSlot]?.id} amt ${ev.amount.toFixed(0)}) atkMode=${b?.mode} atkTarget=${role(b?.target?.id)} hst=${b && b.target ? b.hostility(b.target).toFixed(2) : '-'} hstVictim=${b ? b.hostility(b_ent(ev.target)).toFixed(2) : '-'}`); } }
      }
      if (ev.t === 'death' && ev.kind === 'hero') out.push(`${w.time.toFixed(1)} DEATH ${role(ev.target)} by ${role(ev.killer)}`);
      if (ev.t === 'downed') out.push(`${w.time.toFixed(1)} DOWNED ${role(ev.target)} by ${role(ev.src)}`);
      if (ev.t === 'ability' && w.time > 120 && w.time < 140) out.push(`${w.time.toFixed(1)} ABILITY ${role(ev.src)} ${ev.ability}`);
      if (ev.t === 'itemUse' && w.time > 120 && w.time < 140) out.push(`${w.time.toFixed(1)} ITEM ${role(ev.who)} ${ev.item}`);
      if (ev.t === 'claim') out.push(`${w.time.toFixed(1)} CLAIM ${role(ev.who)} says ${ev.role}`);
    }
    if (w.tick % 90 === 0 && w.time > Number(process.env.AI_T0 ?? 225) && w.time < Number(process.env.AI_T1 ?? 290)) {
      out.push(`${w.time.toFixed(0)} modes: ` + w.heroList().map((h) => { const b = bots[h.hero!.seat]; return `${h.hero!.role}#${h.hero!.seat}:${h.hero!.dead ? 'DEAD' : b?.mode}${b?.target ? '->' + role(b.target.id) : ''}@${Math.round(h.pos.x)},${Math.round(h.pos.z)} hp${Math.round(h.hp)}`; }).join('  '));
    }
  }
  out.push('RESULT ' + JSON.stringify(w.result()?.winner) + ' ' + w.result()?.durationSec);
  process.stdout.write(out.join('\n') + '\n');
}, 300000);
