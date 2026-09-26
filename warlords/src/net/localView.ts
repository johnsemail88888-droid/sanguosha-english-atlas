// ViewSource for the host / single player: reads the in-process SimHost.
// Renders between the last two sim ticks using the fixed-step accumulator
// alpha, so motion is smooth at any display refresh rate with ≤ 1 tick latency.
// Output objects are pooled (see interp.ViewEntityPool): no per-frame garbage.
import type { MapData } from '../core/map';
import type {
  EntityId,
  GameEvent,
  GameResult,
  InputFrame,
  PlayerId,
  PrivateHeroView,
  PublicPlayerView,
  Snapshot,
  ViewEntity,
  ZoneView,
} from '../core/types';
import type { ViewSource } from '../render/view';
import type { SimHost } from '../sim/host';
import { copyEntityInto, emptyZone, lerpEntityInto, lerpZoneInto, MAX_QUEUED_EVENTS, ViewEntityPool } from './interp';
import { neutralInput } from './validate';

export class LocalView implements ViewSource {
  readonly map: MapData;
  private prev: Snapshot | null = null;
  private cur: Snapshot | null = null;
  private readonly prevById = new Map<EntityId, ViewEntity>();
  private events: GameEvent[] = [];
  private readonly pool = new ViewEntityPool();
  private readonly zoneOut: ZoneView = emptyZone();
  private elapsedOut = 0;
  private dirty = true;
  private alpha = 1;
  private disposed = false;
  private lastInput: InputFrame | null = null;
  private suspended = false;

  constructor(
    private readonly host: SimHost,
    private readonly playerId: PlayerId,
    private readonly alphaFn: () => number,
    /** every input frame of the local player, before the sim gets it (the host session's spawn shield) */
    private readonly onInput?: (frame: InputFrame) => void,
  ) {
    this.map = host.map;
    this.onStep();
  }

  /** Called by the host session after every sim step. */
  onStep(): void {
    if (this.disposed) return;
    this.prev = this.cur;
    this.cur = this.host.snapshotFor(this.playerId);
    this.prevById.clear();
    if (this.prev) for (const e of this.prev.ents) this.prevById.set(e.id, e);
    this.dirty = true;
  }

  /** Called by the host session with the events this player may see. */
  pushEvents(evs: readonly GameEvent[]): void {
    if (this.disposed || evs.length === 0) return;
    for (const e of evs) this.events.push(e);
    if (this.events.length > MAX_QUEUED_EVENTS) this.events.splice(0, this.events.length - MAX_QUEUED_EVENTS);
  }

  /**
   * Let go of the controls right now (window lost focus): the hero stops
   * moving and firing until the next pushInput.
   */
  releaseInput(): void {
    if (this.disposed) return;
    const n = neutralInput(this.lastInput);
    if (n) this.host.setInput(this.playerId, n);
  }

  /** Page hidden: release the controls and ignore input until shown again. */
  setSuspended(on: boolean): void {
    if (on === this.suspended) return;
    this.suspended = on;
    if (on) this.releaseInput();
  }

  dispose(): void {
    this.disposed = true;
    this.events = [];
    this.pool.clear();
  }

  update(_dt: number): void {
    const a = this.alphaFn();
    if (a !== this.alpha) {
      this.alpha = a;
      this.dirty = true;
    }
    this.rebuild();
  }

  private rebuild(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const cur = this.cur;
    if (!cur) return;
    const prev = this.prev;
    const t = prev ? this.alpha : 1;
    const pool = this.pool;
    pool.begin();
    for (const e of cur.ents) {
      const out = pool.take(e.id);
      const p = t < 1 ? this.prevById.get(e.id) : undefined;
      if (p) lerpEntityInto(out, p, e, t);
      else copyEntityInto(out, e);
    }
    pool.end();
    lerpZoneInto(this.zoneOut, prev ? prev.zone : cur.zone, cur.zone, t);
    this.elapsedOut = prev ? prev.elapsed + (cur.elapsed - prev.elapsed) * t : cur.elapsed;
  }

  entities(): readonly ViewEntity[] {
    this.rebuild();
    return this.pool.list;
  }

  get(id: EntityId): ViewEntity | undefined {
    this.rebuild();
    return this.pool.get(id);
  }

  localId(): EntityId | null {
    return this.cur?.you?.entityId ?? this.host.entityOf(this.playerId);
  }

  local(): PrivateHeroView | null {
    return this.cur?.you ?? null;
  }

  zone(): ZoneView {
    this.rebuild();
    return this.zoneOut;
  }

  players(): readonly PublicPlayerView[] {
    return this.cur?.players ?? [];
  }

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  viewTick(): number {
    return this.cur?.tick ?? this.host.tick;
  }

  elapsed(): number {
    this.rebuild();
    return this.elapsedOut;
  }

  result(): GameResult | null {
    return this.host.result();
  }

  pushInput(frame: InputFrame): void {
    if (this.disposed || this.suspended) return;
    this.lastInput = frame;
    this.onInput?.(frame);
    this.host.setInput(this.playerId, frame);
  }
}
