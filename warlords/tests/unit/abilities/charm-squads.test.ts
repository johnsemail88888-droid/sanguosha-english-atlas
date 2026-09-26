// C3-1 / C3-2: a charm duel (貂蝉 离间, 周瑜 反间) is nobody's intent — only the charmed
// heroes' forced shots (×dmgMul) hurt. Their squads (and the other side's) sit the fight out,
// soldiers never adopt what a charmed commander is forced to aim at, and when the charm ends
// both sides forget it: no squad keeps shooting.
// Before the fix, two idle human victims with squads both ended at 0 HP (195–346 each during
// the 2.5 s charm + 60–254 after, pt3-combat lijian.test.ts LJ_MODE=hs).
import { describe, expect, it } from 'vitest';
import type { Entity, GameEvent, RoleId } from '../../../src/core/types';
import { emptyInput } from '../../../src/core/types';
import { HERO_BY_ID } from '../../../src/data';
import { aimAnglesFor } from '../../../src/sim/aim';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import type { World } from '../../../src/sim/world';
import { hero, makeWorld, place, stepN } from '../sim/helpers';

const ROLES: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];
const T = (s: number): number => Math.round(s * 30);

interface Tally {
  /** damage each victim took (from anyone) during the charm / in the 5.5 s after it */
  during: [number, number];
  after: [number, number];
  /** shots fired by the victims' soldiers during / after */
  troopShots: number;
  troopShotsAfter: number;
  hp: [number, number];
}

/**
 * Caster (seat 2) casts `slot` on victim t1 (seat 4) standing 8 m from t2 (seat 3), both with
 * their squads; the victims are idle humans (the charm aims and fires for them) or bots.
 */
function duel(caster: string, pair: [string, string], humansVictims: boolean, charmFor = 2.5): Tally {
  const humans = humansVictims ? [0, 1, 2, 3, 4] : [0, 1, 2];
  const w: World = makeWorld(ROLES, {
    heroes: ['dummy', 'dummy', caster, pair[0], pair[1]],
    humans,
    squads: true,
    nav: true,
    botFactory: (seat, d, s) => new HeroBot(seat, d, s),
  });
  const me = hero(w, 2);
  const t1 = hero(w, 4);
  const t2 = hero(w, 3);
  for (const s of [0, 1]) place(w, hero(w, s), 45 + s * 3, 55);
  place(w, me, -20, -20, Math.PI);
  place(w, t1, -20, -8, 0);
  place(w, t2, -12, -8, 0);
  for (const e of [...w.entities()]) {
    if (e.kind !== 'troop') continue;
    const c = w.commanderOf(e);
    if (c) place(w, e, c.pos.x + 1, c.pos.z + (c === me ? -3 : 3));
  }
  for (const v of [t1, t2]) {
    v.hero!.armor = null;
    v.hero!.mount = null;
  }
  let seq = 1;
  const frame = (actions: ReturnType<typeof emptyInput>['actions'] = []): void => {
    const c = { x: t1.pos.x, y: t1.pos.y + 1.1, z: t1.pos.z };
    const a = aimAnglesFor(me.pos, c);
    w.setInput(me.hero!.playerId, { ...emptyInput(seq++), yaw: a.yaw, pitch: a.pitch, aimTargetId: t1.id, aimPoint: c, actions });
  };
  for (let i = 0; i < 10; i++) {
    frame();
    w.step();
    w.drainEvents();
  }
  frame([{ a: 'ability', slot: 'q' }]);
  const out: Tally = { during: [0, 0], after: [0, 0], troopShots: 0, troopShotsAfter: 0, hp: [0, 0] };
  const t0 = w.time;
  let casted = false;
  const victimsSquads = new Set([...t1.hero!.squad, ...t2.hero!.squad]);
  for (let i = 0; i < T(charmFor + 5.5); i++) {
    w.step();
    frame();
    const late = w.time - t0 > charmFor + 0.1;
    for (const ev of w.drainEvents() as GameEvent[]) {
      if (ev.t === 'ability' && ev.src === me.id && !ev.proc) casted = true;
      if (ev.t === 'hit' && ev.amount > 0 && (ev.target === t1.id || ev.target === t2.id)) {
        const k = ev.target === t1.id ? 0 : 1;
        (late ? out.after : out.during)[k] += ev.amount;
      }
      if (ev.t === 'shot' && victimsSquads.has(ev.src)) {
        if (late) out.troopShotsAfter++;
        else out.troopShots++;
      }
    }
  }
  expect(casted, `${caster} cast`).toBe(true);
  out.hp = [t1.hp, t2.hp];
  return out;
}

describe('C3-1: 离间 on human victims with squads', () => {
  const pairs: [string, string][] = [
    ['zhangfei', 'guanyu'],
    ['liubei', 'zhaoyun'],
    ['machao', 'lubu'],
  ];
  it('the squads sit the duel out; each victim loses ≤ ~150 incl. the aftermath; nobody keeps fighting', () => {
    for (const pair of pairs) {
      const r = duel('diaochan', pair, true);
      process.stdout.write(`[离间 C3-1] ${pair.join('+')}: during ${r.during.map(Math.round)} after ${r.after.map(Math.round)} troop shots ${r.troopShots}/${r.troopShotsAfter} hp ${r.hp.map(Math.round)}\n`);
      expect(r.troopShots, pair.join('+')).toBeLessThanOrEqual(3);
      expect(r.troopShotsAfter, pair.join('+')).toBe(0);
      for (const k of [0, 1]) {
        expect(r.during[k] + r.after[k], pair.join('+')).toBeLessThanOrEqual(170);
        expect(r.after[k], pair.join('+')).toBeLessThan(15);
        expect(r.hp[k]).toBeGreaterThan(200);
      }
    }
  }, 60000);
});

describe('C3-1: charm bookkeeping', () => {
  function pairWorld(): { w: World; A: Entity; B: Entity; sa: Entity; sb: Entity } {
    const w = makeWorld(ROLES, { heroes: ['dummy', 'dummy', 'diaochan', 'dummy', 'dummy'] });
    ROLES.forEach((_, i) => place(w, hero(w, i), i * 8 - 40, 58));
    const A = hero(w, 3);
    const B = hero(w, 4);
    place(w, A, -10, 20);
    place(w, B, 10, 20);
    const sa = w.spawnTroops(A.id, 'qun_raider', 1, { x: -10, y: 0, z: 24 })[0];
    const sb = w.spawnTroops(B.id, 'qun_raider', 1, { x: 10, y: 0, z: 24 })[0];
    w.step();
    return { w, A, B, sa, sb };
  }

  it('a charmed hero’s soldiers do not treat the charm partner (or its squad) as hostile; the others still do', () => {
    const { w, A, B, sa, sb } = pairWorld();
    // the duel as it happens: both heroes hit each other, a stray shot hits a soldier
    w.applyStatus(A.id, 'charm', 2.5, { sourceId: hero(w, 2).id, params: { targetId: B.id, dmgMul: 0.35 } });
    w.applyStatus(B.id, 'charm', 2.5, { sourceId: hero(w, 2).id, params: { targetId: A.id, dmgMul: 0.35 } });
    w.recordAttack(A.id, B.id);
    w.recordAttack(B.id, A.id);
    w.recordAttack(sb.id, A.id);
    expect(w.isHostileTo(sa, B)).toBe(false);
    expect(w.isHostileTo(sa, sb)).toBe(false);
    expect(w.isHostileTo(sb, A)).toBe(false);
    expect(w.isHostileTo(sb, sa)).toBe(false);
    // an outsider hurting A is still fair game for A's soldiers
    const C = hero(w, 0);
    w.recordAttack(A.id, C.id);
    expect(w.isHostileTo(sa, C)).toBe(true);
  });

  it('when the charm ends both squads forget the fight (attack memory, focus, current targets)', () => {
    const { w, A, B, sa, sb } = pairWorld();
    const src = hero(w, 2).id;
    w.applyStatus(A.id, 'charm', 1, { sourceId: src, params: { targetId: B.id, dmgMul: 0.35 } });
    w.applyStatus(B.id, 'charm', 1, { sourceId: src, params: { targetId: A.id, dmgMul: 0.35 } });
    w.recordAttack(A.id, B.id, sb.id);
    w.recordAttack(sa.id, B.id, sb.id);
    w.recordAttack(sb.id, A.id, sa.id);
    w.recordAttack(B.id, A.id);
    sa.troop!.targetId = sb.id;
    sb.troop!.targetId = A.id;
    stepN(w, T(1.2));
    expect(w.hasStatus(A.id, 'charm')).toBe(false);
    for (const [x, y] of [
      [A, B],
      [A, sb],
      [sa, B],
      [sa, sb],
      [sb, A],
      [sb, sa],
      [B, A],
    ] as const) {
      expect(w.attackedRecently(x.id, y.id), `${x.kind}${x.id}←${y.kind}${y.id}`).toBe(false);
    }
    expect(w.isHostileTo(sa, B)).toBe(false);
    expect(w.isHostileTo(sb, A)).toBe(false);
    expect(sa.troop!.targetId).not.toBe(sb.id);
    expect(sb.troop!.targetId).not.toBe(A.id);
  });

  it('a charmed hero’s forced shots are not his focus (his soldiers don’t adopt the charm target)', () => {
    const { w, A, B, sa } = pairWorld();
    w.applyStatus(A.id, 'charm', 2.5, { sourceId: hero(w, 2).id, params: { targetId: B.id, dmgMul: 0.35 } });
    w.drainEvents();
    let shots = 0;
    for (let i = 0; i < T(1.5); i++) {
      w.step();
      shots += w.drainEvents().filter((e) => e.t === 'shot' && e.src === A.id).length;
    }
    expect(shots).toBeGreaterThan(2); // the charm fired for him
    expect(w.focusOf(A.id).id).toBeUndefined();
    expect(w.isHostileTo(sa, B)).toBe(false);
  });
});

describe('C3-2: 周瑜 反间 matches 离间', () => {
  it('the forced shots hit at ×0.35 like 离间 (same dmgMul in the data)', () => {
    const fj = HERO_BY_ID.zhouyu.abilities.find((a) => a.id === 'zhouyu_fanjian')!;
    const lj = HERO_BY_ID.diaochan.abilities.find((a) => a.id === 'diaochan_lijian')!;
    expect(fj.params.dmgMul).toBe(lj.params.dmgMul);
    expect(fj.params.duration).toBeLessThanOrEqual(lj.params.duration);
  });

  it('反间 on an idle human with a squad next to another idle human: the bystander loses ≤ ~150, no squad war', () => {
    for (const pair of [
      ['zhangfei', 'guanyu'],
      ['machao', 'lubu'],
    ] as [string, string][]) {
      const r = duel('zhouyu', pair, true, HERO_BY_ID.zhouyu.abilities.find((a) => a.id === 'zhouyu_fanjian')!.params.duration);
      process.stdout.write(`[反间 C3-2] ${pair.join('+')}: during ${r.during.map(Math.round)} after ${r.after.map(Math.round)} troop shots ${r.troopShots}/${r.troopShotsAfter} hp ${r.hp.map(Math.round)}\n`);
      expect(r.troopShotsAfter).toBe(0);
      for (const k of [0, 1]) {
        expect(r.during[k] + r.after[k], pair.join('+')).toBeLessThanOrEqual(170);
        expect(r.hp[k]).toBeGreaterThan(200);
      }
    }
  }, 60000);
});
