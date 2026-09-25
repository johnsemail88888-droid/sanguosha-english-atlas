// ViewSource for a remote client, built from host snapshots (GAME_SPEC §11).
//
//  - Jitter buffer of recent snapshots; remote entities render INTERP_DELAY in
//    the past, interpolated between the two bracketing snapshots. The render
//    clock is slewed (±10 %) towards the estimated host time so it never jumps
//    on ordinary jitter; it snaps only on large discontinuities.
//  - When the buffer runs dry, entities are extrapolated from their last
//    velocity for at most 250 ms.
//  - The local hero is predicted with the shared sim/physics predictMove, one
//    fixed step per sent InputFrame (the host consumes exactly one input per
//    tick), and reconciled on every snapshot by replaying the inputs the host
//    has not yet acknowledged (ackSeq). Forced movement (dash / knockback) that
//    the host reports in `you.forced` is replayed with forcedMove. Residual
//    error is smoothed away (fast blend for large errors, snap for teleports).
//  - Input is sent at INPUT_HZ on the unreliable channel; each packet repeats
//    the edge actions of the previous INPUT_REDUNDANCY frames. When the page
//    loses focus the controls are released immediately (releaseInput).
//  - Events are released in sync with the rendered tick (capped delay), except
//    events caused by the local hero, which are released immediately.
//  - Output entities are pooled per id (interp.ViewEntityPool): the render loop
//    allocates nothing per entity.
import type { MapData } from '../core/map';
import type { Vec3 } from '../core/math';
import {
  BTN_ADS,
  INPUT_HZ,
  INTERP_DELAY,
  SIM_DT,
  VF_AIRBORNE,
  VF_DEAD,
  type EntityId,
  type GameEvent,
  type GameResult,
  type InputAction,
  type InputFrame,
  type PrivateHeroView,
  type PublicPlayerView,
  type Snapshot,
  type ViewEntity,
  type ZoneView,
} from '../core/types';
import { HERO_BY_ID } from '../data/heroes';
import { MOUNT_BY_ID } from '../data/items';
import { WEAPON_BY_ID } from '../data/weapons';
import type { ViewSource } from '../render/view';
import {
  WALK_SPEED,
  brakeForcedEnd,
  buildCollisionWorld,
  forcedMove,
  predictMove,
  type CollisionWorld,
  type MoveMods,
  type MoveState,
} from '../sim/physics';
import { quantizeInput } from './codec';
import { copyEntityInto, emptyZone, lerpEntityInto, lerpZoneInto, MAX_QUEUED_EVENTS, ViewEntityPool } from './interp';
import { INPUT_REDUNDANCY, type InputPacket } from './protocol';
import { neutralInput } from './validate';

/** Max extrapolation beyond the newest snapshot (seconds). */
export const EXTRAPOLATION_CAP = 0.25;
/** Max time an event waits for the render clock (seconds). */
const EVENT_MAX_DELAY = 0.25;
/** Prediction errors up to this are smoothed gently (meters). */
export const SMOOTH_DISTANCE = 4;
/** Larger errors are blended quickly (~100 ms); beyond this they snap (teleport, respawn). */
export const SNAP_DISTANCE = 12;
/** Error smoothing time constant for small errors (seconds). */
const SMOOTH_TAU = 0.1;
/** Error blending time constant for large errors: ~95 % gone after 100 ms. */
const FAST_BLEND_TAU = 0.033;
/** Keep this much snapshot history (seconds). */
const BUFFER_SECONDS = 1;
const MAX_PENDING_INPUTS = 120;
/** HUD timers are re-derived at most this often (seconds). */
const HUD_REFRESH = 0.05;

export interface ClientViewOptions {
  map: MapData;
  localEntityId: EntityId | null;
  /** send one InputPacket to the host (unreliable) */
  sendInput: (packet: InputPacket) => void;
  /** seconds; defaults to performance.now()/1000 */
  now?: () => number;
}

interface BufferedSnapshot {
  snap: Snapshot;
  at: number;
  byId: ReadonlyMap<EntityId, ViewEntity>;
}

interface QueuedEvent {
  tick: number;
  at: number;
  ev: GameEvent;
}

interface PendingInput {
  seq: number;
  frame: InputFrame;
}

/** Forced movement being predicted for the local hero. */
interface ForcedPrediction {
  vx: number;
  vz: number;
  /** seconds of forced movement left (host: (n − ½) ticks; 0 = only the end brake is pending) */
  left: number;
  /** the end-of-forced brake (SHU-1: speed capped at walking speed) was replayed */
  braked: boolean;
}

const cloneState = (s: MoveState): MoveState => ({
  pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
  vel: { x: s.vel.x, y: s.vel.y, z: s.vel.z },
  onGround: s.onGround,
});

export class ClientView implements ViewSource {
  readonly map: MapData;
  private readonly cw: CollisionWorld;
  private readonly now: () => number;
  private readonly sendInput: (p: InputPacket) => void;

  // snapshot buffer (sorted by tick)
  private buf: BufferedSnapshot[] = [];
  private offset: number | null = null;
  private renderTime: number | null = null;

  // output
  private readonly pool = new ViewEntityPool();
  private readonly zoneOut: ZoneView = emptyZone();
  private elapsedOut = 0;
  private viewTickOut = 0;
  private youOut: PrivateHeroView | null = null;
  private youOutSrc: PrivateHeroView | null = null;
  private youOutAt = -Infinity;
  private latestYou: PrivateHeroView | null = null;
  private latestYouAt = 0;
  private playersOut: readonly PublicPlayerView[] = [];
  private resultValue: GameResult | null = null;

  // events
  private pendingEvents: QueuedEvent[] = [];
  private readyEvents: GameEvent[] = [];

  // input + prediction
  private localEntityId: EntityId | null;
  private latestInput: InputFrame | null = null;
  private pendingActions: InputAction[] = [];
  private sentHistory: { seq: number; actions: InputAction[] }[] = [];
  private seq = 0;
  private inputAcc = 0;
  private suspended = false;
  private pending: PendingInput[] = [];
  private pred: MoveState | null = null;
  private predPrev: MoveState | null = null;
  private forced: ForcedPrediction | null = null;
  private readonly errOffset: Vec3 = { x: 0, y: 0, z: 0 };
  private errTau = SMOOTH_TAU;
  private readonly disp: Vec3 = { x: 0, y: 0, z: 0 };
  private lastReconciledTick = -1;
  private lastAuth: { pos: Vec3; time: number } | null = null;
  private disposed = false;

  /** diagnostics (tests / debug overlay) */
  readonly stats = { snapshots: 0, dropped: 0, extrapolating: false, inputsSent: 0, lastError: 0 };

  constructor(opts: ClientViewOptions) {
    this.map = opts.map;
    this.cw = buildCollisionWorld(opts.map);
    this.localEntityId = opts.localEntityId;
    this.sendInput = opts.sendInput;
    this.now = opts.now ?? (() => performance.now() / 1000);
  }

  // ── inbound (called by ClientSession) ────────────────────────────────────
  /** A decoded snapshot (treated as immutable); `byId` = its entities by id, if already built. */
  onSnapshot(s: Snapshot, byIdIn?: ReadonlyMap<EntityId, ViewEntity>): void {
    if (this.disposed) return;
    const at = this.now();
    const newest = this.buf[this.buf.length - 1];
    if (newest && s.tick <= newest.snap.tick) {
      // late or duplicate packet: insert if it fills a gap, else drop
      if (this.buf.some((b) => b.snap.tick === s.tick) || s.tick < this.buf[0].snap.tick) {
        this.stats.dropped++;
        return;
      }
    }
    let byId = byIdIn;
    if (!byId) {
      const m = new Map<EntityId, ViewEntity>();
      for (const e of s.ents) m.set(e.id, e);
      byId = m;
    }
    const entry: BufferedSnapshot = { snap: s, at, byId };
    let i = this.buf.length;
    while (i > 0 && this.buf[i - 1].snap.tick > s.tick) i--;
    this.buf.splice(i, 0, entry);
    this.stats.snapshots++;
    const latest = this.buf[this.buf.length - 1].snap;
    while (this.buf.length > 3 && this.buf[1].snap.time < latest.time - BUFFER_SECONDS) this.buf.shift();

    // clock offset (host time − local time): follow improvements immediately,
    // latency increases slowly, so the buffer stays filled.
    const sample = s.time - at;
    if (this.offset === null) this.offset = sample;
    else if (sample > this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.05;

    if (s === latest) {
      this.playersOut = s.players;
      if (s.you) {
        this.latestYou = s.you;
        this.latestYouAt = at;
        this.localEntityId = s.you.entityId;
      }
      this.reconcile(s);
    }
  }

  onEvents(tick: number, events: readonly GameEvent[]): void {
    if (this.disposed) return;
    const at = this.now();
    for (const ev of events) {
      if (this.isLocalEvent(ev)) this.readyEvents.push(ev);
      else this.pendingEvents.push({ tick, at, ev });
    }
    this.capQueues();
  }

  setResult(r: GameResult): void {
    this.resultValue = r;
  }

  dispose(): void {
    this.disposed = true;
    this.buf = [];
    this.pendingEvents = [];
    this.readyEvents = [];
    this.pool.clear();
  }

  private isLocalEvent(ev: GameEvent): boolean {
    const me = this.localEntityId;
    if (me === null) return false;
    switch (ev.t) {
      case 'shot':
      case 'melee':
      case 'ability':
        return ev.src === me;
      case 'hit':
        return ev.src === me || ev.target === me;
      case 'pickup':
      case 'itemUse':
      case 'reward':
        return ev.who === me;
      default:
        return false;
    }
  }

  private capQueues(): void {
    if (this.pendingEvents.length > MAX_QUEUED_EVENTS) this.pendingEvents.splice(0, this.pendingEvents.length - MAX_QUEUED_EVENTS);
    if (this.readyEvents.length > MAX_QUEUED_EVENTS) this.readyEvents.splice(0, this.readyEvents.length - MAX_QUEUED_EVENTS);
  }

  // ── prediction ───────────────────────────────────────────────────────────
  private moveMods(frame: InputFrame): MoveMods {
    const you = this.latestYou;
    const ads = (frame.buttons & BTN_ADS) !== 0;
    if (you?.moveMods) return { ...you.moveMods, ads, downed: you.downed };
    return estimateMoveMods(you, ads);
  }

  /** Advance a predicted state by one input frame (one host tick). */
  private stepPrediction(state: MoveState, frame: InputFrame, forced: ForcedPrediction | null): void {
    if (forced && forced.left > 1e-6) {
      forcedMove(this.cw, state, forced.vx, forced.vz, SIM_DT);
      forced.left -= SIM_DT;
      return;
    }
    if (forced && !forced.braked) {
      // first tick after the forced movement: the host caps the speed here (sim/world.ts updateHero)
      forced.braked = true;
      brakeForcedEnd(state.vel, WALK_SPEED);
    }
    predictMove(this.cw, state, frame, SIM_DT, this.moveMods(frame));
  }

  private reconcile(s: Snapshot): void {
    const me = this.localEntityId;
    const ent = me === null ? undefined : s.ents.find((e) => e.id === me);
    if (!ent || (ent.flags & VF_DEAD) !== 0 || s.you?.dead) {
      this.pred = null;
      this.predPrev = null;
      this.forced = null;
      this.errOffset.x = this.errOffset.y = this.errOffset.z = 0;
      this.lastAuth = null;
      return;
    }
    if (s.tick <= this.lastReconciledTick) return;
    this.lastReconciledTick = s.tick;

    const authPos = { x: ent.x, y: ent.y, z: ent.z };
    let vel: Vec3 = s.you?.vel ?? { x: 0, y: 0, z: 0 };
    if (!s.you?.vel && this.lastAuth && s.time > this.lastAuth.time) {
      const dt = s.time - this.lastAuth.time;
      vel = {
        x: (authPos.x - this.lastAuth.pos.x) / dt,
        y: (authPos.y - this.lastAuth.pos.y) / dt,
        z: (authPos.z - this.lastAuth.pos.z) / dt,
      };
    }
    this.lastAuth = { pos: authPos, time: s.time };
    const onGround = s.you?.onGround ?? (ent.flags & VF_AIRBORNE) === 0;

    // acknowledged inputs are done
    while (this.pending.length > 0 && this.pending[0].seq <= s.ackSeq) this.pending.shift();

    // what is on screen now (prediction + residual smoothing) and the bare prediction
    const had = this.pred !== null;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let px = 0;
    let py = 0;
    let pz = 0;
    if (had) {
      const shown = this.displayPos(true);
      sx = shown.x;
      sy = shown.y;
      sz = shown.z;
      const bare = this.displayPos(false);
      px = bare.x;
      py = bare.y;
      pz = bare.z;
    }
    const f = s.you?.forced;
    const forced: ForcedPrediction | null =
      f && f.remaining >= 0 && Number.isFinite(f.vel.x) && Number.isFinite(f.vel.z)
        ? { vx: f.vel.x, vz: f.vel.z, left: f.remaining, braked: false }
        : null;
    const state: MoveState = { pos: { ...authPos }, vel: { ...vel }, onGround };
    let prev = cloneState(state);
    for (const p of this.pending) {
      prev = cloneState(state);
      this.stepPrediction(state, p.frame, forced);
    }
    this.pred = state;
    this.predPrev = this.pending.length > 0 ? prev : cloneState(state);
    this.forced = forced && (forced.left > 1e-6 || !forced.braked) ? forced : null;

    if (had) {
      const after = this.displayPos(false);
      // misprediction of this snapshot (diagnostics)
      this.stats.lastError = Math.hypot(px - after.x, py - after.y, pz - after.z);
      // visual jump the new prediction would cause: blend it away
      const ex = sx - after.x;
      const ey = sy - after.y;
      const ez = sz - after.z;
      const jump = Math.hypot(ex, ey, ez);
      if (jump > SNAP_DISTANCE) {
        // teleport / respawn / revive: show the truth at once
        this.errOffset.x = this.errOffset.y = this.errOffset.z = 0;
      } else {
        this.errOffset.x = ex;
        this.errOffset.y = ey;
        this.errOffset.z = ez;
        this.errTau = jump > SMOOTH_DISTANCE ? FAST_BLEND_TAU : SMOOTH_TAU;
      }
    }
  }

  /** Predicted render position of the local hero (a shared scratch vector). */
  private displayPos(withOffset: boolean): Vec3 {
    const out = this.disp;
    const cur = this.pred;
    if (!cur) {
      out.x = out.y = out.z = 0;
      return out;
    }
    const prev = this.predPrev ?? cur;
    const t = Math.min(1, this.inputAcc * INPUT_HZ);
    out.x = prev.pos.x + (cur.pos.x - prev.pos.x) * t;
    out.y = prev.pos.y + (cur.pos.y - prev.pos.y) * t;
    out.z = prev.pos.z + (cur.pos.z - prev.pos.z) * t;
    if (withOffset) {
      out.x += this.errOffset.x;
      out.y += this.errOffset.y;
      out.z += this.errOffset.z;
    }
    return out;
  }

  private sendFrame(): void {
    const latest = this.latestInput;
    if (!latest) return;
    const seq = ++this.seq;
    const frame = quantizeInput({
      ...latest,
      seq,
      actions: this.pendingActions,
      viewTick: this.viewTickOut,
    });
    this.pendingActions = [];
    const history = this.sentHistory.slice(-INPUT_REDUNDANCY);
    this.sendInput({ frame, history });
    this.stats.inputsSent++;
    this.sentHistory.push({ seq, actions: frame.actions });
    if (this.sentHistory.length > INPUT_REDUNDANCY) this.sentHistory.shift();

    this.pending.push({ seq, frame });
    if (this.pending.length > MAX_PENDING_INPUTS) this.pending.shift();
    if (this.pred) {
      this.predPrev = cloneState(this.pred);
      this.stepPrediction(this.pred, frame, this.forced);
      if (this.forced && this.forced.left <= 1e-6 && this.forced.braked) this.forced = null;
    }
  }

  /**
   * Let go of the controls right now: send a frame with no movement / buttons
   * (same view direction) immediately, outside the render loop. Used when the
   * window loses focus; the next pushInput takes over again.
   */
  releaseInput(): void {
    if (this.disposed) return;
    const n = neutralInput(this.latestInput);
    if (!n) return;
    this.latestInput = n;
    this.sendFrame();
  }

  /** Page hidden: release the controls and ignore input until shown again. */
  setSuspended(on: boolean): void {
    if (on === this.suspended) return;
    this.suspended = on;
    if (on) this.releaseInput();
  }

  // ── ViewSource ───────────────────────────────────────────────────────────
  pushInput(frame: InputFrame): void {
    if (this.disposed || this.suspended) return;
    const prev = this.latestInput;
    // reuse the stored frame object: pushInput runs every render frame
    const li: InputFrame = prev ?? { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, actions: [] };
    li.seq = frame.seq;
    li.moveX = frame.moveX;
    li.moveZ = frame.moveZ;
    li.yaw = frame.yaw;
    li.pitch = frame.pitch;
    li.buttons = frame.buttons;
    // li.actions stays empty: edge actions travel through pendingActions
    if (frame.aimPoint) {
      if (li.aimPoint) {
        li.aimPoint.x = frame.aimPoint.x;
        li.aimPoint.y = frame.aimPoint.y;
        li.aimPoint.z = frame.aimPoint.z;
      } else {
        li.aimPoint = { x: frame.aimPoint.x, y: frame.aimPoint.y, z: frame.aimPoint.z };
      }
    } else if (li.aimPoint) {
      delete li.aimPoint;
    }
    if (frame.aimTargetId !== undefined) li.aimTargetId = frame.aimTargetId;
    else if (li.aimTargetId !== undefined) delete li.aimTargetId;
    this.latestInput = li;
    if (frame.actions.length > 0) this.pendingActions.push(...frame.actions);
    if (this.pendingActions.length > 64) this.pendingActions.splice(0, this.pendingActions.length - 64);
  }

  update(dt: number): void {
    if (this.disposed) return;
    const now = this.now();
    if (!Number.isFinite(dt) || dt < 0) dt = 0;

    // 1. input at a fixed rate (drop backlog after a stall)
    const step = 1 / INPUT_HZ;
    this.inputAcc += dt;
    let sends = 0;
    while (this.inputAcc >= step) {
      this.inputAcc -= step;
      if (sends++ < 3) this.sendFrame();
    }
    if (this.inputAcc >= step) this.inputAcc %= step;
    const decay = Math.exp(-dt / this.errTau);
    this.errOffset.x *= decay;
    this.errOffset.y *= decay;
    this.errOffset.z *= decay;

    // 2. render clock
    if (this.buf.length === 0 || this.offset === null) return;
    const target = now + this.offset - INTERP_DELAY;
    if (this.renderTime === null) this.renderTime = target;
    else {
      const err = target - this.renderTime;
      const rate = 1 + Math.max(-0.1, Math.min(0.1, err));
      this.renderTime += dt * rate;
      if (Math.abs(target - this.renderTime) > 0.3) this.renderTime = target;
    }
    this.compose(now);
  }

  private compose(now: number): void {
    const rt = this.renderTime as number;
    const buf = this.buf;
    let ai = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].snap.time <= rt) {
        ai = i;
        break;
      }
    }
    const pool = this.pool;
    pool.begin();
    this.stats.extrapolating = false;

    if (ai === -1) {
      // render clock before the oldest snapshot: show the oldest as-is
      const first = buf[0];
      for (const e of first.snap.ents) copyEntityInto(pool.take(e.id), e);
      lerpZoneInto(this.zoneOut, first.snap.zone, first.snap.zone, 1);
      this.viewTickOut = first.snap.tick;
      this.elapsedOut = first.snap.elapsed;
    } else if (ai === buf.length - 1) {
      // buffer ran dry: extrapolate from the newest snapshot (capped)
      const b = buf[ai];
      const a = ai > 0 ? buf[ai - 1] : null;
      const extra = Math.min(rt - b.snap.time, EXTRAPOLATION_CAP);
      const span = a ? b.snap.time - a.snap.time : 0;
      this.stats.extrapolating = extra > 0.001;
      for (const e of b.snap.ents) {
        const out = copyEntityInto(pool.take(e.id), e);
        const pe = a?.byId.get(e.id);
        if (pe && span > 1e-4 && extra > 0 && (e.flags & VF_DEAD) === 0) {
          const k = extra / span;
          out.x = e.x + (e.x - pe.x) * k;
          out.y = e.y + (e.y - pe.y) * k;
          out.z = e.z + (e.z - pe.z) * k;
        }
      }
      lerpZoneInto(this.zoneOut, b.snap.zone, b.snap.zone, 1);
      this.viewTickOut = b.snap.tick;
      this.elapsedOut = b.snap.elapsed + Math.max(0, extra);
    } else {
      const a = buf[ai];
      const b = buf[ai + 1];
      const span = b.snap.time - a.snap.time;
      const t = span > 1e-6 ? Math.min(1, Math.max(0, (rt - a.snap.time) / span)) : 1;
      for (const e of b.snap.ents) {
        const out = pool.take(e.id);
        const pe = a.byId.get(e.id);
        if (pe) lerpEntityInto(out, pe, e, t);
        else copyEntityInto(out, e);
      }
      lerpZoneInto(this.zoneOut, a.snap.zone, b.snap.zone, t);
      this.viewTickOut = Math.floor(a.snap.tick + (b.snap.tick - a.snap.tick) * t);
      this.elapsedOut = a.snap.elapsed + (b.snap.elapsed - a.snap.elapsed) * t;
    }
    pool.end();

    // local hero: predicted position, immediate aim
    const me = this.localEntityId;
    const mine = me === null ? undefined : pool.get(me);
    if (mine && this.pred) {
      const p = this.displayPos(true);
      mine.x = p.x;
      mine.y = p.y;
      mine.z = p.z;
      mine.speed = Math.hypot(this.pred.vel.x, this.pred.vel.z);
      if (this.latestInput) {
        mine.yaw = this.latestInput.yaw;
        mine.pitch = this.latestInput.pitch;
      }
    }

    // HUD timers tick down locally between snapshots
    const you = this.latestYou;
    if (you && (you !== this.youOutSrc || now - this.youOutAt >= HUD_REFRESH)) {
      this.youOutSrc = you;
      this.youOutAt = now;
      const age = Math.max(0, now - this.latestYouAt);
      const dec = (v: number): number => (Number.isFinite(v) ? Math.max(0, v - age) : v);
      const cooldowns: Record<string, number> = {};
      for (const k of Object.keys(you.cooldowns)) cooldowns[k] = dec(you.cooldowns[k]);
      this.youOut = {
        ...you,
        cooldowns,
        reloading: dec(you.reloading),
        downedRemaining: dec(you.downedRemaining),
        statuses: you.statuses.map((s) => ({ id: s.id, remaining: dec(s.remaining) })),
      };
    }

    // release events that the render clock has reached (in-place compaction)
    const pend = this.pendingEvents;
    if (pend.length > 0) {
      let w = 0;
      for (let i = 0; i < pend.length; i++) {
        const q = pend[i];
        if (q.tick <= this.viewTickOut || now - q.at >= EVENT_MAX_DELAY) this.readyEvents.push(q.ev);
        else pend[w++] = q;
      }
      pend.length = w;
      this.capQueues();
    }
  }

  entities(): readonly ViewEntity[] {
    return this.pool.list;
  }

  get(id: EntityId): ViewEntity | undefined {
    return this.pool.get(id);
  }

  localId(): EntityId | null {
    return this.localEntityId;
  }

  local(): PrivateHeroView | null {
    return this.youOut ?? this.latestYou;
  }

  zone(): ZoneView {
    return this.zoneOut;
  }

  players(): readonly PublicPlayerView[] {
    return this.playersOut;
  }

  drainEvents(): GameEvent[] {
    const out = this.readyEvents;
    this.readyEvents = [];
    return out;
  }

  viewTick(): number {
    return this.viewTickOut;
  }

  elapsed(): number {
    return this.elapsedOut;
  }

  result(): GameResult | null {
    return this.resultValue;
  }

  /** Debug: newest buffered snapshot tick, render clock lag, pending inputs. */
  debugInfo(): { newestTick: number; buffered: number; pendingInputs: number; renderLag: number; forced: boolean } {
    const newest = this.buf[this.buf.length - 1];
    return {
      newestTick: newest?.snap.tick ?? -1,
      buffered: this.buf.length,
      pendingInputs: this.pending.length,
      renderLag: newest && this.renderTime !== null ? newest.snap.time - this.renderTime : 0,
      forced: this.forced !== null,
    };
  }
}

/** Fallback MoveMods when the host does not send `you.moveMods`. */
export function estimateMoveMods(you: PrivateHeroView | null, ads: boolean): MoveMods {
  if (!you) return { speedMul: 1, canSprint: true, canJump: true, rooted: false, ads, downed: false };
  // remaining: seconds, Infinity / -1 = until consumed (both active), 0 = expiring now
  const has = (id: string): boolean => you.statuses.some((s) => s.id === id && s.remaining !== 0);
  let speedMul = HERO_BY_ID[you.heroId]?.speedMul ?? 1;
  if (you.mount) speedMul *= MOUNT_BY_ID[you.mount]?.speedMul ?? 1;
  const w = you.weapons[you.activeSlot];
  if (w) speedMul *= WEAPON_BY_ID[w.id]?.moveSpeedMul ?? 1;
  if (has('haste')) speedMul *= 1.3;
  if (has('slow')) speedMul *= 0.7;
  if (has('freeze')) speedMul *= 0.4;
  if (has('dance')) speedMul *= 0.5;
  const rooted = has('root') || has('stun');
  const frozen = has('freeze');
  return {
    speedMul,
    canSprint: !frozen && !you.downed,
    canJump: !frozen && !you.downed && !rooted,
    rooted,
    ads,
    downed: you.downed,
  };
}
