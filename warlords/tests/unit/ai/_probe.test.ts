import { it } from 'vitest';
import { createWorld } from '../../../src/sim/world';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import { makeBotInit, realMap } from './harness';
const SEED = Number(process.env.PSEED ?? 8013);
const P = Number(process.env.PP ?? 6);
const MODE = (process.env.PMODE ?? 'chaos') as 'chaos' | 'standard';
const DIFF = (process.env.PDIFF ?? 'normal') as 'easy' | 'normal' | 'hard';
it('probe match', () => {
  const bots: HeroBot[] = [];
  const w = createWorld(makeBotInit({ players: P as 6, mode: MODE, difficulty: DIFF, seed: SEED }), { map: realMap(), onWarn: () => {}, botFactory: (s, d, seed) => { const b = new HeroBot(s, d, seed); bots.push(b); return b; } });
  const role = (id?: number) => { const e = id !== undefined ? w.get(id) : undefined; return e?.hero ? `${e.hero.role}${e.id}` : e ? e.kind : '?'; };
  const mat: Record<string, number> = {};
  const lines: string[] = [];
  let lastSec = -1;
  for (let i = 0; i < 30 * 600 && !w.result(); i++) {
    w.step();
    for (const ev of w.drainEvents()) {
      if (ev.t === 'hit' && ev.amount > 0 && !ev.blocked) {
        const s = ev.src !== undefined ? w.get(ev.src) : undefined; const t = w.get(ev.target);
        if (s?.hero && t) { const tt = t.hero ? t.hero.role : (w.commanderOf(t)?.hero ? 'sq:' + w.commanderOf(t)!.hero!.role : t.kind); const k = `${s.hero.role}->${tt}`; mat[k] = (mat[k] ?? 0) + ev.amount; }
        if (s?.hero && t?.hero && Math.floor(w.time / 10) !== lastSec) { lastSec = Math.floor(w.time / 10); lines.push(`${w.time.toFixed(0)} ${role(ev.src)} hits ${role(ev.target)}`); }
      }
      if (ev.t === 'death' && ev.kind === 'hero') lines.push(`${w.time.toFixed(0)} DEATH ${role(ev.target)} by ${role(ev.killer)}`);
      if (ev.t === 'downed') lines.push(`${w.time.toFixed(0)} downed ${role(ev.target)} by ${role(ev.src)}`);
      if (ev.t === 'revived') lines.push(`${w.time.toFixed(0)} revived ${role(ev.target)} by ${role(ev.by)}`);
      if (ev.t === 'quickchat') lines.push(`${w.time.toFixed(0)} chat ${role(ev.who)} ${ev.id}`);
    }
    if (w.tick % 30 === 0 && w.time > 100 && w.time < 190) {
      for (const b of bots) { const st = (b as unknown as { strategy: { probeState: string } }).strategy; const e = w.heroList()[b.seat]; if (e.hero!.role === 'rebel' && !e.hero!.dead) lines.push(`${w.time.toFixed(0)} R${e.id} ${st.probeState} mode ${b.mode} tgt ${b.target?.id ?? '-'} hp ${Math.round(e.hp)} dLord ${Math.round(Math.hypot(e.pos.x - w.heroList()[0].pos.x, e.pos.z - w.heroList()[0].pos.z))}`); }
    }
    if (w.tick % (30 * 20) === 0) {
      const st = w.heroList().map((h) => `${h.hero!.role}${h.id}:${h.hero!.dead ? 'X' : Math.round(h.hp)}@${Math.round(h.pos.x)},${Math.round(h.pos.z)}`).join(' ');
      lines.push(`${w.time.toFixed(0)} STATE ${st}`);
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
  process.stdout.write(JSON.stringify(w.result()?.winner) + ' ' + w.time.toFixed(0) + '\n');
  process.stdout.write(Object.entries(mat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${Math.round(v)}`).join(' ') + '\n');
  process.stdout.write(bots.map((b) => { const st = (b as unknown as { strategy: Record<string, unknown> }).strategy; return `${b.seat}:${b.role} probeAt ${Number(st.probeAt).toFixed(0)} state ${st.probeState} end ${Number(st.probeEndAt).toFixed(0)} pushAt ${Number(st.pushAt).toFixed(0)} w ${b.weapon?.id}/${b.weapon?.class}`; }).join('\n') + '\n');
  process.stdout.write(bots.map((b) => `${b.seat}:${JSON.stringify(b.pushStats())} aimed ${b.stats.castsAimed} to ${JSON.stringify(b.stats.timeoutsById)}`).join('\n') + '\n');
}, 120_000);
