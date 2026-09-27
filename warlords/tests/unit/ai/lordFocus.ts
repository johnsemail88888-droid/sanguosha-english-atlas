// Harness for 「怎么我一下主公一下就死了？」: a human hero near the bot 主公 and his guard
// squad (the real HeroBot, squads, nav) on the test map. Scenarios:
//   'rebelShot'   a 反贼 walks up to the lord's squad and fires ONE shot at the lord
//   'loyalShot'   a 忠臣 hits the lord once by accident (no claim)
//   'loyalNear'   a 忠臣 just stands near the lord (no shot)
//   'rebelFocus'  a 反贼 (admitted: 跳反) at mid range keeps shooting the lord — the lord side's
//                 focused fire, the "must survive ≥ 3 s" case
// Measures the time from the first damage the human takes to going down (濒死) and death, and
// who dealt the damage: the lord's own weapon, his abilities, his guards (troops / summons
// credited to him), other heroes (loyalist…), the human's own squad, area effects.
import type { Entity, EntityId, GameEvent, InputAction, RoleId } from '../../../src/core/types';
import { BTN_FIRE, SIM_DT, emptyInput } from '../../../src/core/types';
import { aimAnglesFor } from '../../../src/sim/aim';
import { HeroBot } from '../../../src/sim/ai/heroBot';
import type { DamageRequest } from '../../../src/sim/api';
import type { World } from '../../../src/sim/world';
import { createWorld } from '../../../src/sim/world';
import { hero, makeInit, makeTestMap, place } from '../sim/helpers';

export type LordScenario = 'rebelShot' | 'loyalShot' | 'loyalNear' | 'rebelFocus';

export interface LordFocusOptions {
  lord: string;
  scenario: LordScenario;
  /** distance from the lord (m) */
  dist: number;
  /** the human's hero (default 关羽, 400 HP) */
  me?: string;
  seed?: number;
  /** seconds simulated after the first shot / arrival */
  seconds?: number;
  /** late game (pressure: the lord no longer holds back) — the scene starts at this match time (s) */
  startAt?: number;
}

export type DamageCategory = 'lordGun' | 'lordAbility' | 'lordGuards' | 'otherHero' | 'otherTroops' | 'ownSquad' | 'other';

export interface LordFocusResult {
  opts: LordFocusOptions;
  /** seconds from the human's first damage taken to going down (Infinity: never) */
  firstHitToDown: number;
  /** seconds from the human's first damage taken to death (Infinity: never) */
  firstHitToDeath: number;
  downed: boolean;
  dead: boolean;
  /** damage taken (HP + shield) by category, while standing (before going down) */
  took: Record<DamageCategory, number>;
  /** largest damage taken within any 1 s window while standing */
  peak1s: number;
  hpLeft: number;
  lordHpLost: number;
  /** guard troops alive around the lord at the start */
  guards: number;
}

const ROLES5: RoleId[] = ['lord', 'loyalist', 'rebel', 'rebel', 'traitor'];

export function runLordFocus(o: LordFocusOptions): LordFocusResult {
  const meSeat = o.scenario === 'loyalShot' || o.scenario === 'loyalNear' ? 1 : 2;
  const heroes = [o.lord, 'dummy', 'dummy', 'dummy', 'dummy'];
  heroes[meSeat] = o.me ?? 'guanyu';
  const init = makeInit(ROLES5, heroes, {}, [meSeat]);
  init.seed = o.seed ?? 12345;
  const w: World = createWorld(init, {
    map: makeTestMap(),
    ambient: false,
    zone: false,
    airdrops: false,
    squads: true,
    nav: true,
    onWarn: () => {},
    botFactory: (seat, d, s) => new HeroBot(seat, d, s),
  });
  const lord = hero(w, 0);
  const me = hero(w, meSeat);
  // everyone else far away (the 忠臣 bot too: this is the lord and his guards)
  let k = 0;
  for (const s of [0, 1, 2, 3, 4]) {
    if (s === 0 || s === meSeat) continue;
    place(w, hero(w, s), 45, -45 + 6 * k++);
  }
  const L = { x: -25, z: 35 };
  place(w, lord, L.x, L.z, -Math.PI / 2);
  place(w, me, L.x + o.dist, L.z, Math.PI / 2);
  for (const e of [...w.entities()]) {
    if (e.kind !== 'troop') continue;
    const c = w.commanderOf(e);
    if (!c) continue;
    const a = (e.id * 2.39996) % (Math.PI * 2);
    place(w, e, c.pos.x + Math.cos(a) * 3, c.pos.z + Math.sin(a) * 3);
  }
  if (o.startAt) {
    w.tick = Math.round(o.startAt / SIM_DT);
    w.time = w.tick * SIM_DT;
  }
  let seq = 1;
  const chest = (e: Entity): { x: number; y: number; z: number } => ({ x: e.pos.x, y: e.pos.y + 1.1, z: e.pos.z });
  const frame = (buttons = 0, actions: InputAction[] = []): void => {
    const c = chest(lord);
    const a = aimAnglesFor(me.pos, c);
    w.setInput(me.hero!.playerId, { ...emptyInput(seq++), yaw: a.yaw, pitch: a.pitch, aimTargetId: lord.id, aimPoint: c, buttons, actions });
  };
  // settle 1 s (squads gather, bots look around)
  for (let i = 0; i < 30; i++) {
    frame(0, i === 2 && o.scenario === 'rebelFocus' ? [{ a: 'claim', role: 'rebel' }] : []);
    w.step();
    w.drainEvents();
    // hold the human in place (he stands and takes it — no dodging, no retreat)
  }
  const guards = [...w.entities()].filter((e) => e.kind === 'troop' && e.alive && w.commanderOf(e) === lord).length;
  const lordHp0 = lord.hp;

  const res: LordFocusResult = {
    opts: o,
    firstHitToDown: Infinity,
    firstHitToDeath: Infinity,
    downed: false,
    dead: false,
    took: { lordGun: 0, lordAbility: 0, lordGuards: 0, otherHero: 0, otherTroops: 0, ownSquad: 0, other: 0 },
    peak1s: 0,
    hpLeft: 0,
    lordHpLost: 0,
    guards,
  };
  // attribution: every hit the human takes, by its real source
  const orig = w.hooks.onDamageTaken.bind(w.hooks);
  let firstHitAt = -1;
  const window: { t: number; a: number }[] = [];
  w.hooks.onDamageTaken = (target: Entity, src: Entity | undefined, req: DamageRequest, dealt: number): void => {
    orig(target, src, req, dealt);
    if (target !== me || me.hero!.downed) return;
    const amount = dealt + 0; // HP removed (shield soak is not HP)
    if (!(amount > 0)) return;
    if (firstHitAt < 0) firstHitAt = w.time;
    const credit: EntityId | undefined = w.creditOf(req.sourceId);
    let cat: DamageCategory = 'other';
    if (req.type === 'zone' || req.abilityId?.startsWith('status:')) cat = 'other';
    else if (credit === lord.id) cat = src === lord ? (req.abilityId ? 'lordAbility' : 'lordGun') : req.abilityId && src?.kind === 'hazard' ? 'lordAbility' : src?.kind === 'troop' || src?.kind === 'npc' || src?.kind === 'turret' ? 'lordGuards' : 'lordAbility';
    else if (credit === me.id) cat = 'ownSquad';
    else if (src?.kind === 'hero') cat = 'otherHero';
    else if (src?.kind === 'troop' || src?.kind === 'npc' || src?.kind === 'turret') cat = 'otherTroops';
    res.took[cat] += amount;
    window.push({ t: w.time, a: amount });
    while (window.length && w.time - window[0].t > 1) window.shift();
    res.peak1s = Math.max(res.peak1s, window.reduce((s, x) => s + x.a, 0));
  };

  const ticks = Math.round((o.seconds ?? 12) / SIM_DT);
  let shots = 0;
  let pressed = false;
  const wantShots = o.scenario === 'loyalNear' ? 0 : o.scenario === 'rebelFocus' ? 1e9 : 1;
  for (let i = 0; i < ticks; i++) {
    let b = 0;
    if (shots < wantShots && !me.hero!.downed && !me.hero!.dead) {
      const ready = me.hero!.nextFireAt <= w.time + 1e-6 && me.hero!.reloadUntil <= w.time;
      const auto = wantShots > 1;
      if (ready && (auto || !pressed)) b = BTN_FIRE;
      pressed = b !== 0;
    }
    const mag0 = me.hero!.weapons[me.hero!.activeSlot]?.mag ?? 0;
    frame(b);
    // the human stands still (the worst case: no dodge, no cover, no 桃)
    me.vel.x = 0;
    me.vel.z = 0;
    w.step();
    shots += Math.max(0, mag0 - (me.hero!.weapons[me.hero!.activeSlot]?.mag ?? 0));
    for (const ev of w.drainEvents() as GameEvent[]) {
      if (ev.t === 'downed' && ev.target === me.id && !res.downed) {
        res.downed = true;
        if (firstHitAt >= 0) res.firstHitToDown = w.time - firstHitAt;
      }
      if (ev.t === 'death' && ev.target === me.id && !res.dead) {
        res.dead = true;
        if (firstHitAt >= 0) res.firstHitToDeath = w.time - firstHitAt;
      }
    }
    if (res.dead) break;
  }
  res.hpLeft = me.hp;
  res.lordHpLost = lordHp0 - lord.hp;
  w.hooks.onDamageTaken = orig;
  return res;
}

export function fmtLordFocus(r: LordFocusResult): string {
  const t = r.took;
  const f = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(2)}s` : '—');
  const parts = (Object.keys(t) as DamageCategory[]).filter((k) => t[k] > 0).map((k) => `${k} ${Math.round(t[k])}`);
  return `${r.opts.lord.padEnd(9)} ${r.opts.scenario.padEnd(10)} ${String(r.opts.dist).padStart(2)}m guards ${r.guards} · down ${f(r.firstHitToDown)} dead ${f(r.firstHitToDeath)} · peak/1s ${Math.round(r.peak1s)} · ${parts.join(', ') || 'no damage'} · hp ${Math.round(r.hpLeft)}`;
}
