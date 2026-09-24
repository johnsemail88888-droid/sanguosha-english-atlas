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
  /** death sequence: "time:role<killerRole" */
  deathLog: string[];
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
  const w: World = createWorld(makeBotInit(spec), { map: realMap(), onWarn: () => {} });
  const heroes = w.heroList();
  const deaths = { hero: 0, npc: 0, zone: 0, other: 0 };
  let abilities = 0;
  let items = 0;
  let claims = 0;
  let quickchats = 0;
  let revives = 0;
  let lordKilledLoyal = 0;
  const deathLog: string[] = [];
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
        case 'death': {
          if (ev.kind !== 'hero') break;
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
    deathLog,
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
      t.minMinute = Math.min(t.minMinute, t.minuteDist);
      t.minuteStart = now;
      t.minuteDist = 0;
    }
    if (!t.idleAnchor || Math.hypot(p.x - t.idleAnchor.x, p.z - t.idleAnchor.z) > 1.5 || busy) t.idleAnchor = { x: p.x, z: p.z, t: now };
    else t.longestIdle = Math.max(t.longestIdle, now - t.idleAnchor.t);
  }
}

export function formatTable(rows: MatchMetrics[]): string {
  const head = ['#', 'players', 'mode', 'diff', 'seed', 'winner', 'dur(s)', 'combat', 'deaths h/n/z/o', 'abil', 'items', 'claims', 'revives', 'm/min', 'idle(s)', 'tick avg/p95 ms'];
  const lines = [head.join(' | ')];
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
        r.abilities,
        r.items,
        r.claims,
        r.revives,
        r.minMetersPerMinute,
        r.longestIdle,
        `${r.tickAvgMs.toFixed(2)}/${r.tickP95Ms.toFixed(2)}`,
      ].join(' | '),
    );
  });
  return lines.join('\n');
}
