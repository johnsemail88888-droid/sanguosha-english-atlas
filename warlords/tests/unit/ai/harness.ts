// Full-match harness for the AI metrics tests: runs all-bot matches on the
// real generated map and collects results, pacing, deaths by cause, ability /
// item use, movement (stuck detection) and tick times.
import type { Entity, EntityId, GameResult, MatchSettings, RoleId } from '../../../src/core/types';
import { defaultSettings } from '../../../src/core/types';
import { HEROES, LORD_CANDIDATE_IDS, ROLE_DISTRIBUTION } from '../../../src/data';
import type { MatchInit } from '../../../src/sim/host';
import { generateMap } from '../../../src/sim/map/generate';
import type { MapData } from '../../../src/core/map';
import { Rng } from '../../../src/core/rng';
import { FAILSAFE_TIME } from '../../../src/sim/rules';
import { ZONE_PHASES } from '../../../src/sim/zone';
import type { World } from '../../../src/sim/world';
import { createWorld } from '../../../src/sim/world';
import { HeroBot } from '../../../src/sim/ai/heroBot';

/** Start of the last shrink (circle closing to 0). */
export const FINAL_SHRINK_START = ZONE_PHASES.reduce((t, p, i) => (i < ZONE_PHASES.length - 1 ? t + p.wait + p.shrink : t + p.wait), 0);

let cachedMap: MapData | null = null;
export function realMap(): MapData {
  if (!cachedMap) cachedMap = generateMap(defaultSettings().mapSeed);
  return cachedMap;
}

export interface MatchSpec {
  players: 5 | 6 | 7 | 8;
  mode: 'standard' | 'chaos';
  difficulty: 'easy' | 'normal' | 'hard';
  seed: number;
}

/** Deal roles + heroes like the lobby does (lord picks a lord candidate). */
export function makeBotInit(spec: MatchSpec): MatchInit {
  const rng = new Rng(spec.seed * 7919 + 17);
  const variants = ROLE_DISTRIBUTION[spec.mode][spec.players];
  const roles: RoleId[] = [...rng.pick(variants)];
  // index 0 stays the lord seat; shuffle the rest
  const rest = rng.shuffle(roles.slice(1));
  const dealt: RoleId[] = [roles[0], ...rest];
  const pool = rng.shuffle(HEROES.map((h) => h.id));
  const lordHero = rng.pick(LORD_CANDIDATE_IDS);
  const heroes = [lordHero, ...pool.filter((h) => h !== lordHero)];
  const settings: MatchSettings = { ...defaultSettings(), playerCount: spec.players, mode: spec.mode, botDifficulty: spec.difficulty };
  return {
    settings,
    seed: spec.seed,
    seats: dealt.map((role, i) => ({ seat: i, playerId: `bot-${i}`, name: `Bot ${i}`, isBot: true, role, heroId: heroes[i] })),
  };
}

export interface MatchMetrics {
  spec: MatchSpec;
  result: GameResult;
  winner: string;
  duration: number;
  decidedByCombat: boolean;
  deaths: Record<'hero' | 'npc' | 'zone' | 'other', number>;
  abilities: number;
  items: number;
  claims: number;
  quickchats: number;
  revives: number;
  heroDamage: number;
  /** minimum metres moved during any full minute a bot was alive and standing */
  minMetersPerMinute: number;
  /** longest time (s) any living, standing bot stayed within 1.5 m of one spot */
  longestIdle: number;
  tickAvgMs: number;
  tickP95Ms: number;
  tickMaxMs: number;
  lordKilledLoyal: number;
  /** sim time of the first hero-on-hero hit that did damage (Infinity: none) */
  firstHeroHitAt: number;
  /** hero-on-hero damage dealt before 180 s */
  heroDmgBefore180: number;
  /** first / last hero death (NaN: none) */
  firstDeathAt: number;
  lastDeathAt: number;
  /** damage rebels dealt to the real lord / to the 影武者 */
  rebelDmgOnLord: number;
  rebelDmgOnDouble: number;
  /** bot casts pressed after aiming / abandoned (aim never settled) */
  castsAimed: number;
  castTimeouts: number;
  /** rebel pushes started / broken off (summed over rebel bots) */
  pushes: number;
  failedPushes: number;
  /** death sequence: "time:role<killerRole" */
  deathLog: string[];
  /** exceptions thrown by bot / troop / NPC brains (must stay empty) */
  brainErrors: string[];
}

interface MoveTrack {
  lastSample: { x: number; z: number } | null;
  minuteStart: number;
  minuteDist: number;
  minMinute: number;
  idleAnchor: { x: number; z: number; t: number } | null;
  longestIdle: number;
}

export function runMatch(spec: MatchSpec, opts: { timing?: boolean } = {}): MatchMetrics {
  const brainErrors: string[] = [];
  const bots: HeroBot[] = [];
  const w: World = createWorld(makeBotInit(spec), {
    map: realMap(),
    onWarn: (m) => {
      if (/brain threw/.test(m)) brainErrors.push(m);
    },
    // every bot exception is recorded (the world would swallow it and idle the bot for a tick)
    botFactory: (seat, d, seed) => {
      const b = new HeroBot(seat, d, seed);
      bots.push(b);
      return {
        think(sim, self, dt) {
          try {
            return b.think(sim, self, dt);
          } catch (err) {
            brainErrors.push(`bot ${seat}: ${String(err)}`);
            throw err;
          }
        },
      };
    },
  });
  const heroes = w.heroList();
  const deaths = { hero: 0, npc: 0, zone: 0, other: 0 };
  let abilities = 0;
  let items = 0;
  let claims = 0;
  let quickchats = 0;
  let revives = 0;
  let lordKilledLoyal = 0;
  const deathLog: string[] = [];
  let firstHeroHitAt = Infinity;
  let heroDmgBefore180 = 0;
  let firstDeathAt = NaN;
  let lastDeathAt = NaN;
  let rebelDmgOnLord = 0;
  let rebelDmgOnDouble = 0;
  const tracks = new Map<EntityId, MoveTrack>();
  for (const h of heroes) tracks.set(h.id, { lastSample: null, minuteStart: 0, minuteDist: 0, minMinute: Infinity, idleAnchor: null, longestIdle: 0 });
  const times: number[] = [];
  const maxTicks = Math.ceil((FAILSAFE_TIME + 5) * 30);
  for (let i = 0; i < maxTicks && !w.result(); i++) {
    const t0 = opts.timing ? performance.now() : 0;
    w.step();
    if (opts.timing) times.push(performance.now() - t0);
    for (const ev of w.drainEvents()) {
      switch (ev.t) {
        case 'hit': {
          const src = ev.src !== undefined ? w.get(ev.src) : undefined;
          const tgt = w.get(ev.target);
          if (!src?.hero || !tgt?.hero || src === tgt || ev.amount <= 0 || ev.blocked) break;
          if (w.time < firstHeroHitAt) firstHeroHitAt = w.time;
          if (w.time < 180) heroDmgBefore180 += ev.amount;
          if (src.hero.role === 'rebel' && tgt.hero.role === 'lord') rebelDmgOnLord += ev.amount;
          if (src.hero.role === 'rebel' && tgt.hero.role === 'double') rebelDmgOnDouble += ev.amount;
          break;
        }
        case 'death': {
          if (ev.kind !== 'hero') break;
          if (Number.isNaN(firstDeathAt)) firstDeathAt = w.time;
          lastDeathAt = w.time;
          const victim = w.get(ev.target);
          const killer = ev.killer !== undefined ? w.get(ev.killer) : undefined;
          deathLog.push(`${Math.round(w.time)}:${ev.role ?? '?'}<${killer?.hero ? killer.hero.role : killer ? killer.kind : 'zone'}`);
          if (killer?.hero) {
            deaths.hero++;
            if (killer.hero.role === 'lord' && (ev.role === 'loyalist' || ev.role === 'double')) lordKilledLoyal++;
          } else if (killer?.kind === 'npc') deaths.npc++;
          else if (victim && outsideZone(w, victim)) deaths.zone++;
          else deaths.other++;
          break;
        }
        case 'ability':
          abilities++;
          break;
        case 'itemUse':
          items++;
          break;
        case 'claim':
          claims++;
          break;
        case 'quickchat':
          quickchats++;
          break;
        case 'revived':
          revives++;
          break;
        default:
          break;
      }
    }
    if (w.tick % 30 === 0) sampleMovement(w, heroes, tracks);
  }
  const result = w.result()!;
  let minMinute = Infinity;
  let longestIdle = 0;
  for (const t of tracks.values()) {
    minMinute = Math.min(minMinute, t.minMinute);
    longestIdle = Math.max(longestIdle, t.longestIdle);
  }
  times.sort((a, b) => a - b);
  const avg = times.length ? times.reduce((s, x) => s + x, 0) / times.length : 0;
  return {
    spec,
    result,
    winner: result.winner,
    duration: result.durationSec,
    decidedByCombat: result.durationSec < FINAL_SHRINK_START,
    deaths,
    abilities,
    items,
    claims,
    quickchats,
    revives,
    heroDamage: Math.round(heroes.reduce((s, h) => s + h.hero!.stats.damage, 0)),
    minMetersPerMinute: minMinute === Infinity ? -1 : Math.round(minMinute),
    longestIdle: Math.round(longestIdle),
    tickAvgMs: avg,
    tickP95Ms: times.length ? times[Math.floor(times.length * 0.95)] : 0,
    tickMaxMs: times.length ? times[times.length - 1] : 0,
    lordKilledLoyal,
    firstHeroHitAt,
    heroDmgBefore180: Math.round(heroDmgBefore180),
    firstDeathAt,
    lastDeathAt,
    rebelDmgOnLord: Math.round(rebelDmgOnLord),
    rebelDmgOnDouble: Math.round(rebelDmgOnDouble),
    castsAimed: bots.reduce((a, b) => a + b.stats.castsAimed, 0),
    castTimeouts: bots.reduce((a, b) => a + b.stats.castTimeouts, 0),
    pushes: bots.reduce((a, b) => a + b.pushStats().pushes, 0),
    failedPushes: bots.reduce((a, b) => a + b.pushStats().failed, 0),
    deathLog,
    brainErrors,
  };
}

function outsideZone(w: World, e: Entity): boolean {
  const z = w.zoneView();
  return Math.hypot(e.pos.x - z.center.x, e.pos.z - z.center.z) > z.radius - 0.5;
}

function sampleMovement(w: World, heroes: Entity[], tracks: Map<EntityId, MoveTrack>): void {
  const now = w.time;
  for (const h of heroes) {
    const t = tracks.get(h.id)!;
    const st = h.hero!;
    const busy = st.dead || st.downed || !!st.channel;
    if (st.dead || st.downed) {
      t.lastSample = null;
      t.minuteStart = now;
      t.minuteDist = 0;
      t.idleAnchor = null;
      continue;
    }
    const p = { x: h.pos.x, z: h.pos.z };
    if (t.lastSample) t.minuteDist += Math.hypot(p.x - t.lastSample.x, p.z - t.lastSample.z);
    t.lastSample = p;
    if (now - t.minuteStart >= 60) {
      // standing in the last circle is not being stuck
      if (now < FINAL_SHRINK_START) t.minMinute = Math.min(t.minMinute, t.minuteDist);
      t.minuteStart = now;
      t.minuteDist = 0;
    }
    if (!t.idleAnchor || Math.hypot(p.x - t.idleAnchor.x, p.z - t.idleAnchor.z) > 1.5 || busy || now >= FINAL_SHRINK_START) t.idleAnchor = { x: p.x, z: p.z, t: now };
    else t.longestIdle = Math.max(t.longestIdle, now - t.idleAnchor.t);
  }
}

export function formatTable(rows: MatchMetrics[]): string {
  const head = ['#', 'players', 'mode', 'diff', 'seed', 'winner', 'dur(s)', 'combat', 'deaths h/n/z/o', '1st hit', 'dmg<180', '1st/last death', 'abil', 'items', 'aimed/timeout', 'claims', 'revives', 'push/fail', 'm/min', 'idle(s)', 'tick avg/p95 ms'];
  const lines = [head.join(' | ')];
  const t = (x: number): string => (Number.isFinite(x) ? x.toFixed(0) : '-');
  rows.forEach((r, i) => {
    lines.push(
      [
        i + 1,
        r.spec.players,
        r.spec.mode,
        r.spec.difficulty,
        r.spec.seed,
        r.winner,
        r.duration.toFixed(0),
        r.decidedByCombat ? 'yes' : 'no',
        `${r.deaths.hero}/${r.deaths.npc}/${r.deaths.zone}/${r.deaths.other}`,
        t(r.firstHeroHitAt),
        r.heroDmgBefore180,
        `${t(r.firstDeathAt)}/${t(r.lastDeathAt)}`,
        r.abilities,
        r.items,
        `${r.castsAimed}/${r.castTimeouts}`,
        r.claims,
        r.revives,
        `${r.pushes}/${r.failedPushes}`,
        r.minMetersPerMinute,
        r.longestIdle,
        `${r.tickAvgMs.toFixed(2)}/${r.tickP95Ms.toFixed(2)}`,
      ].join(' | '),
    );
  });
  return lines.join('\n');
}

/** Aggregate pacing / outcome summary of a set of matches. */
export interface SampleSummary {
  n: number;
  wins: Record<string, number>;
  winsByMode: Record<string, Record<string, number>>;
  avgDuration: number;
  combatShare: number;
  /** share of matches with hero-on-hero damage before 180 s */
  earlyDamageShare: number;
  medianFirstHit: number;
  medianFirstDeath: number;
  /** mean seconds between the first and the last hero death (matches with ≥ 2 deaths) */
  meanDeathSpread: number;
  rebelOnLordShare: number;
}

export function summarize(rows: MatchMetrics[]): SampleSummary {
  const median = (xs: number[]): number => {
    const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
    return a.length ? a[Math.floor(a.length / 2)] : NaN;
  };
  const wins: Record<string, number> = {};
  const winsByMode: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    wins[r.winner] = (wins[r.winner] ?? 0) + 1;
    const m = (winsByMode[r.spec.mode] ??= {});
    m[r.winner] = (m[r.winner] ?? 0) + 1;
  }
  const spreads = rows.filter((r) => r.deaths.hero + r.deaths.npc + r.deaths.zone + r.deaths.other >= 2 && Number.isFinite(r.firstDeathAt)).map((r) => r.lastDeathAt - r.firstDeathAt);
  const onLord = rows.reduce((s, r) => s + r.rebelDmgOnLord, 0);
  const onDouble = rows.reduce((s, r) => s + r.rebelDmgOnDouble, 0);
  return {
    n: rows.length,
    wins,
    winsByMode,
    avgDuration: rows.reduce((s, r) => s + r.duration, 0) / Math.max(1, rows.length),
    combatShare: rows.filter((r) => r.decidedByCombat).length / Math.max(1, rows.length),
    earlyDamageShare: rows.filter((r) => r.heroDmgBefore180 > 0).length / Math.max(1, rows.length),
    medianFirstHit: median(rows.map((r) => r.firstHeroHitAt)),
    medianFirstDeath: median(rows.map((r) => r.firstDeathAt)),
    meanDeathSpread: spreads.length ? spreads.reduce((s, x) => s + x, 0) / spreads.length : NaN,
    rebelOnLordShare: onLord + onDouble > 0 ? onLord / (onLord + onDouble) : NaN,
  };
}

export function formatSummary(s: SampleSummary): string {
  const f = (x: number, d = 0): string => (Number.isFinite(x) ? x.toFixed(d) : '-');
  return [
    `matches ${s.n} · wins ${JSON.stringify(s.wins)} · by mode ${JSON.stringify(s.winsByMode)}`,
    `avg ${f(s.avgDuration)} s · combat-decided ${f(s.combatShare * 100)}% · hero damage before 180 s in ${f(s.earlyDamageShare * 100)}% · median first hit ${f(s.medianFirstHit)} s · median first death ${f(s.medianFirstDeath)} s · mean first→last death ${f(s.meanDeathSpread)} s · rebel damage on the real lord (乱世) ${f(s.rebelOnLordShare * 100)}%`,
  ].join('\n');
}
