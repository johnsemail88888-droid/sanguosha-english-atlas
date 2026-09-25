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
//   __sgwl.cheats.*                  sim cheats for LOCAL single-player sessions only (never an
//                                    online host: guests are real people): time scale, god mode,
//                                    give item/weapon, teleport, kill, down
import type { EntityId, GameEvent, PrivateHeroView, PublicPlayerView, Vec3, ViewEntity } from '../core/types';
import type { ViewSource } from '../render/view';
import { HEROES, ITEMS, isPassiveAbility } from '../data';
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
  downHero?(e: unknown, creditId: EntityId | undefined): void;
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

/** How a session was created: cheats only ever touch a 'local' (single-player, no network) one. */
export type DebugSessionKind = 'local' | 'host' | 'guest';

export interface SgwlDebug {
  readonly version: string;
  /** kind of the current session (null: none / unknown) */
  readonly sessionKind: DebugSessionKind | null;
  readonly phase: string | null;
  readonly screen: string | null;
  readonly session: GameSession | null;
  readonly view: ViewSource | null;
  readonly handle: unknown;
  readonly gameHandle: unknown;
  readonly timings: Record<string, number>;
  readonly events: { counts: Record<string, number>; deaths: DebugDeath[]; downed: number; total: number; heroHits: number; heroDamage: number };
  localId(): EntityId | null;
  localEntity(): ViewEntity | null;
  local(): PrivateHeroView | null;
  players(): readonly PublicPlayerView[];
  entities(): readonly ViewEntity[];
  elapsed(): number;
  stats(): unknown;
  mark(name: string): void;
  /**
   * Fire every ability / item-card / explosion VFX once in front of your hero
   * (synthetic events through the renderer, a few per frame). Resolves with the count.
   */
  vfxSmoke(perFrame?: number): Promise<number>;
  cheats: {
    /** true only in a local single-player match (not when hosting or joining online) */
    available(): boolean;
    timeScale(scale: number): boolean;
    god(on?: boolean): boolean;
    give(itemId: string, count?: number): boolean;
    weapon(weaponId: string): boolean;
    equip(id: string): boolean;
    heal(): boolean;
    teleport(x: number, z: number): boolean;
    /** move any hero (a bot too) to (x, ground, z) — e.g. bring two bots together so they fight */
    teleportHero(entityId: EntityId, x: number, z: number): boolean;
    /** kill a hero (other entity kinds are refused) */
    kill(entityId: EntityId): boolean;
    /** knock your own hero down (濒死) — or `entityId`'s */
    down(entityId?: EntityId): boolean;
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
  /**
   * The newest session, held weakly: the hooks must not keep a finished match
   * (host, sim, views) alive after the app dropped it (memory checks run with ?debug=1).
   */
  private sessionRef: WeakRef<GameSession> | null = null;
  private readonly kinds = new WeakMap<GameSession, DebugSessionKind>();
  private game: DebugGame | null = null;
  private readonly timings: Record<string, number> = {};
  private events = { counts: {} as Record<string, number>, deaths: [] as DebugDeath[], downed: 0, total: 0, heroHits: 0, heroDamage: 0 };
  private scale = 1;
  private god = false;
  private godTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly version: string,
    private readonly root: () => HTMLElement | null,
  ) {
    this.install();
  }

  private get session(): GameSession | null {
    return this.sessionRef?.deref() ?? null;
  }

  private set session(s: GameSession | null) {
    this.sessionRef = s ? new WeakRef(s) : null;
  }

  /** Remember the newest session (wrap every session factory with this) and how it was made. */
  trackSession<T extends GameSession>(s: T, kind: DebugSessionKind): T {
    this.session = s;
    this.kinds.set(s, kind);
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
    this.events = { counts: {}, deaths: [], downed: 0, total: 0, heroHits: 0, heroDamage: 0 };
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
      else if (e.t === 'hit' && e.src !== undefined && e.src !== e.target && e.amount > 0 && view) {
        // hero-vs-hero damage (bots fighting each other), attributed through owners (troops / turrets)
        const src = view.get(e.src);
        const tgt = view.get(e.target);
        const srcHero = src?.kind === 'hero' ? src.id : src?.owner;
        if (tgt?.kind === 'hero' && srcHero !== undefined && srcHero !== tgt.id) {
          this.events.heroHits++;
          this.events.heroDamage += e.amount;
        }
      }
    }
  }

  /** Record a milestone (ms since navigation start); the latest occurrence wins (one match after another). */
  mark(name: string): void {
    this.timings[name] = Math.round(performance.now());
  }

  private async vfxSmoke(perFrame: number): Promise<number> {
    const view = this.game?.view;
    const r = (this.game?.handle as { renderer?: { injectEvents(evs: GameEvent[]): void } | null } | undefined)?.renderer;
    const id = view?.localId();
    const me = id !== null && id !== undefined ? view?.get(id) : undefined;
    if (!view || !r || !me) return 0;
    const dir = { x: -Math.sin(me.yaw), y: 0, z: -Math.cos(me.yaw) };
    const pos = { x: me.x + dir.x * 6, y: me.y + 1, z: me.z + dir.z * 6 };
    const evs: GameEvent[] = [];
    for (const h of HEROES) {
      for (const a of h.abilities) {
        if (a.slot === 'passive' || isPassiveAbility(a)) continue;
        evs.push({ t: 'ability', src: me.id, ability: a.id, pos, dir, target: me.id });
      }
    }
    for (const it of ITEMS) evs.push({ t: 'itemUse', who: me.id, item: it.id, pos, target: me.id });
    for (const kind of ['fire', 'frag', 'rocket', 'grenade', 'thunder', 'ice', 'holy', 'heal', 'gas', 'smoke', 'ink', 'emp', 'shockwave'])
      evs.push({ t: 'explosion', pos, radius: 4, kind });
    const nextFrame = (): Promise<void> => new Promise((res) => requestAnimationFrame(() => res()));
    for (let i = 0; i < evs.length; i += perFrame) {
      r.injectEvents(evs.slice(i, i + perFrame));
      await nextFrame();
      await nextFrame();
    }
    return evs.length;
  }

  /** Synthetic events through the renderer (they reach every onEvents subscriber, the HUD included). */
  private inject(evs: GameEvent[]): void {
    const r = (this.game?.handle as { renderer?: { injectEvents(evs: GameEvent[]): void } | null } | undefined)?.renderer;
    try {
      r?.injectEvents(evs);
    } catch {
      /* no renderer yet */
    }
  }

  private kindOf(s: GameSession | null): DebugSessionKind | null {
    return s ? this.kinds.get(s) ?? null : null;
  }

  /** The in-process host of a LOCAL session (single player). Online hosts get no cheats. */
  private host(): HostLike | null {
    const s = this.session;
    if (!s || this.kindOf(s) !== 'local') return null;
    const hs = s as unknown as HostLike;
    return hs.simHost !== undefined ? hs : null;
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
      get sessionKind() {
        return self.kindOf(self.session);
      },
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
      vfxSmoke: (perFrame = 6) => this.vfxSmoke(perFrame),
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
          const ok = !!(world && id !== null && world.giveItem?.(id, itemId, count));
          // like a real pickup for the UI: the HUD toasts the card with its effect line
          if (ok && id !== null) this.inject([{ t: 'pickup', who: id, item: itemId }]);
          return ok;
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
        teleportHero: (entityId, x, z) => {
          const world = w();
          const e = world?.get(entityId);
          if (!world?.teleport || !e || e.kind !== 'hero' || e.dead) return false;
          const y = world.groundHeight ? world.groundHeight(x, z) : 0;
          world.teleport(entityId, { x, y, z });
          return true;
        },
        kill: (entityId) => {
          const world = w();
          const e = world?.get(entityId);
          if (!world?.killHero || !e || e.kind !== 'hero' || e.dead) return false;
          world.killHero(e, this.meId() ?? undefined);
          return true;
        },
        down: (entityId) => {
          const world = w();
          const id = entityId ?? this.meId();
          const e = id !== null && id !== undefined ? world?.get(id) : undefined;
          if (!world?.downHero || !e || e.kind !== 'hero') return false;
          if (id === this.meId()) this.stopGod();
          world.downHero(e, undefined);
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
