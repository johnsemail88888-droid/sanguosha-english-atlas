// Debug / automated play-testing hooks (window.__sgwl). Only installed when the
// page is opened with `?debug=1` (or localStorage 'sgwl.debug' = '1'): e2e specs
// and developers drive and inspect the real app through it. Never shipped as a
// gameplay feature — nothing here runs for normal players.
//
//   __sgwl.phase / screen            session phase, UI screen id
//   __sgwl.session / view / handle   the live GameSession, ViewSource, game view handle
//   __sgwl.localEntity() / local()   your hero's ViewEntity / private HUD state
//   __sgwl.players()                 public player list
//   __sgwl.events                    counts of GameEvents seen this match (by type) + hero deaths
//   __sgwl.timings                   load milestones (ms since navigation start)
//   __sgwl.cheats.*                  host-only sim cheats (single player / hosting): time scale,
//                                    god mode, give item/weapon, teleport, kill, win
import type { EntityId, GameEvent, PrivateHeroView, PublicPlayerView, Vec3, ViewEntity } from '../core/types';
import type { ViewSource } from '../render/view';
import type { GameSession } from './session';

export interface DebugDeath {
  target: EntityId;
  killer?: EntityId;
  heroId?: string;
  role?: string;
  /** view.elapsed() when it happened (sim seconds) */
  at: number;
}

/** Minimal structural view of what cheats need from the host's World (sim/world.ts implements it). */
interface WorldLike {
  readonly tick: number;
  readonly time: number;
  get(id: EntityId | undefined): { id: EntityId; kind: string; hp: number; maxHp: number; pos: Vec3; dead?: boolean } | undefined;
  heroes(): { id: EntityId; hp: number; maxHp: number }[];
  entityOf(playerId: string): EntityId | null;
  applyStatus?(id: EntityId, status: string, duration: number, opts?: { params?: Record<string, number> }): boolean;
  removeStatus?(id: EntityId, status: string): void;
  giveItem?(id: EntityId, itemId: string, count?: number): boolean;
  giveWeapon?(id: EntityId, weaponId: string): void;
  equip?(id: EntityId, armorOrMountId: string): void;
  teleport?(id: EntityId, pos: Vec3): void;
  groundHeight?(x: number, z: number): number;
  heal?(id: EntityId, amount: number): number;
  killHero?(e: unknown, creditId: EntityId | undefined): void;
  setCooldown?(id: EntityId, abilityId: string, seconds: number): void;
}

interface HostLike {
  simHost?: WorldLike | null;
  debugState?(): unknown;
  /** formal time-scale hook (INTEGRATION_REQUESTS APP-1); falls back to the loop's step length */
  setDebugTimeScale?(scale: number): void;
}

export interface DebugGame {
  view: ViewSource;
  session: GameSession;
  /** the render-side handle (renderer, input, canvas) */
  handle: unknown;
  /** the UI-facing GameHandle */
  gameHandle: unknown;
}

export interface SgwlDebug {
  readonly version: string;
  readonly phase: string | null;
  readonly screen: string | null;
  readonly session: GameSession | null;
  readonly view: ViewSource | null;
  readonly handle: unknown;
  readonly gameHandle: unknown;
  readonly timings: Record<string, number>;
  readonly events: { counts: Record<string, number>; deaths: DebugDeath[]; downed: number; total: number };
  localId(): EntityId | null;
  localEntity(): ViewEntity | null;
  local(): PrivateHeroView | null;
  players(): readonly PublicPlayerView[];
  entities(): readonly ViewEntity[];
  elapsed(): number;
  stats(): unknown;
  mark(name: string): void;
  cheats: {
    available(): boolean;
    timeScale(scale: number): boolean;
    god(on?: boolean): boolean;
    give(itemId: string, count?: number): boolean;
    weapon(weaponId: string): boolean;
    equip(id: string): boolean;
    heal(): boolean;
    teleport(x: number, z: number): boolean;
    kill(entityId: EntityId): boolean;
    killOthers(): number;
    resetCooldowns(): boolean;
  };
}

declare global {
  interface Window {
    __sgwl?: SgwlDebug;
  }
}

/** Debug hooks are on for `?debug=1` (or localStorage sgwl.debug = 1). */
export function debugEnabled(): boolean {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    if (q.get('debug') === '1') return true;
  } catch {
    /* ignore */
  }
  try {
    return globalThis.localStorage?.getItem('sgwl.debug') === '1';
  } catch {
    return false;
  }
}

export class DebugHooks {
  private session: GameSession | null = null;
  private game: DebugGame | null = null;
  private readonly timings: Record<string, number> = {};
  private events = { counts: {} as Record<string, number>, deaths: [] as DebugDeath[], downed: 0, total: 0 };
  private scale = 1;
  private god = false;
  private godTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly version: string,
    private readonly root: () => HTMLElement | null,
  ) {
    this.install();
  }

  /** Remember the newest session (wrap every session factory with this). */
  trackSession<T extends GameSession>(s: T): T {
    this.session = s;
    this.mark('session');
    try {
      s.on('phase', (p) => this.mark(`phase:${p}`));
      s.on('matchStart', () => this.mark('matchStart'));
    } catch {
      /* ignore */
    }
    return s;
  }

  attachGame(g: DebugGame): () => void {
    this.game = g;
    this.session = g.session;
    this.events = { counts: {}, deaths: [], downed: 0, total: 0 };
    this.scale = 1;
    this.mark('mountGame');
    return () => {
      if (this.game === g) this.game = null;
      this.stopGod();
    };
  }

  onEvents(evs: readonly GameEvent[]): void {
    const view = this.game?.view;
    for (const e of evs) {
      this.events.total++;
      this.events.counts[e.t] = (this.events.counts[e.t] ?? 0) + 1;
      if (e.t === 'death' && e.kind === 'hero') {
        this.events.deaths.push({ target: e.target, killer: e.killer, heroId: e.heroId, role: e.role, at: view?.elapsed() ?? 0 });
      } else if (e.t === 'downed') this.events.downed++;
    }
  }

  mark(name: string): void {
    if (this.timings[name] === undefined) this.timings[name] = Math.round(performance.now());
  }

  private host(): HostLike | null {
    const s = this.session as unknown as HostLike | null;
    return s && s.simHost !== undefined ? s : null;
  }

  private world(): WorldLike | null {
    return this.host()?.simHost ?? null;
  }

  private meId(): EntityId | null {
    const v = this.game?.view;
    return v ? v.localId() : null;
  }

  private stopGod(): void {
    if (this.godTimer !== null) clearInterval(this.godTimer);
    this.godTimer = null;
  }

  private install(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const w = (): WorldLike | null => self.world();
    const api: SgwlDebug = {
      version: this.version,
      get phase() {
        return self.session?.phase ?? null;
      },
      get screen() {
        return self.root()?.dataset.activeScreen ?? null;
      },
      get session() {
        return self.session;
      },
      get view() {
        return self.game?.view ?? self.session?.view ?? null;
      },
      get handle() {
        return self.game?.handle ?? null;
      },
      get gameHandle() {
        return self.game?.gameHandle ?? null;
      },
      get timings() {
        return self.timings;
      },
      get events() {
        return self.events;
      },
      localId: () => this.meId(),
      localEntity: () => {
        const v = this.game?.view;
        const id = v?.localId();
        return v && id !== null && id !== undefined ? v.get(id) ?? null : null;
      },
      local: () => this.game?.view.local() ?? null,
      players: () => this.game?.view.players() ?? [],
      entities: () => this.game?.view.entities() ?? [],
      elapsed: () => this.game?.view.elapsed() ?? 0,
      stats: () => {
        const r = (this.game?.handle as { renderer?: { stats(): unknown } } | undefined)?.renderer;
        return r ? r.stats() : null;
      },
      mark: (n) => this.mark(n),
      cheats: {
        available: () => w() !== null,
        timeScale: (scale) => {
          const host = this.host();
          if (!host) return false;
          const k = Math.max(0.1, Math.min(10, scale));
          if (typeof host.setDebugTimeScale === 'function') {
            host.setDebugTimeScale(k);
            this.scale = k;
            return true;
          }
          // fallback: shorten the host loop's fixed step (wall-clock ms per sim tick)
          const loop = (host as unknown as { loop?: { stepMs?: number; maxCatchUp?: number } }).loop;
          if (!loop || typeof loop.stepMs !== 'number') return false;
          const base = loop.stepMs * this.scale;
          loop.stepMs = base / k;
          loop.maxCatchUp = Math.max(5, Math.ceil(5 * k));
          this.scale = k;
          return true;
        },
        god: (on = true) => {
          const world = w();
          const id = this.meId();
          if (!world || id === null || !world.applyStatus) return false;
          this.god = on;
          this.stopGod();
          if (on) {
            const tickGod = (): void => {
              const ww = w();
              const me = this.meId();
              if (!ww || me === null) return;
              try {
                ww.applyStatus?.(me, 'invuln', 5);
                const e = ww.get(me);
                if (e && e.hp < e.maxHp) ww.heal?.(me, e.maxHp);
              } catch {
                /* ignore */
              }
            };
            tickGod();
            this.godTimer = setInterval(tickGod, 1000);
          } else {
            try {
              world.removeStatus?.(id, 'invuln');
            } catch {
              /* ignore */
            }
          }
          return true;
        },
        give: (itemId, count = 1) => {
          const world = w();
          const id = this.meId();
          return !!(world && id !== null && world.giveItem?.(id, itemId, count));
        },
        weapon: (weaponId) => {
          const world = w();
          const id = this.meId();
          if (!world?.giveWeapon || id === null) return false;
          world.giveWeapon(id, weaponId);
          return true;
        },
        equip: (armorOrMount) => {
          const world = w();
          const id = this.meId();
          if (!world?.equip || id === null) return false;
          world.equip(id, armorOrMount);
          return true;
        },
        heal: () => {
          const world = w();
          const id = this.meId();
          if (!world?.heal || id === null) return false;
          world.heal(id, 10_000);
          return true;
        },
        teleport: (x, z) => {
          const world = w();
          const id = this.meId();
          if (!world?.teleport || id === null) return false;
          const y = world.groundHeight ? world.groundHeight(x, z) : 0;
          world.teleport(id, { x, y, z });
          return true;
        },
        kill: (entityId) => {
          const world = w();
          const e = world?.get(entityId);
          if (!world?.killHero || !e) return false;
          world.killHero(e, this.meId() ?? undefined);
          return true;
        },
        killOthers: () => {
          const world = w();
          const me = this.meId();
          if (!world?.killHero) return 0;
          let n = 0;
          for (const h of world.heroes()) {
            if (h.id === me || h.hp <= 0 || (h as { dead?: boolean }).dead) continue;
            world.killHero(h, me ?? undefined);
            n++;
          }
          return n;
        },
        resetCooldowns: () => {
          const world = w();
          const me = this.meId();
          const local = this.game?.view.local();
          if (!world?.setCooldown || me === null || !local) return false;
          for (const id of Object.keys(local.cooldowns)) world.setCooldown(me, id, 0);
          return true;
        },
      },
    };
    (globalThis as unknown as { __sgwl?: SgwlDebug }).__sgwl = api;
  }
}
