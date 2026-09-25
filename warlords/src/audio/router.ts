// Maps host GameEvents + the per-frame ViewSource state to sounds. Pure logic
// against the `SoundSink` interface so it is unit-testable in Node with a
// recording sink (the live implementation is the AudioEngine).
import type { Vec3 } from '../core/math';
import type { EntityId, GameEvent, StatusId, ViewEntity } from '../core/types';
import { VF_AIRBORNE, VF_DEAD, VF_DODGING, VF_DOWNED, VF_FIRING, VF_MOUNTED, VF_OPENED, VF_RELOADING, VF_SHIELDED, VF_SPRINTING } from '../core/types';
import type { ViewSource } from '../render/view';
import type { SfxName } from './catalog';
import { resolveSfxName } from './catalog';
import {
  abilityFlavorOf,
  fireRateOf,
  gunFlavorOf,
  gunSoundOf,
  hash01,
  isChainWeapon,
  isLordAbility,
  isProjectileWeapon,
  itemSoundOf,
  kingdomOfHero,
  pickupSoundOf,
  reloadTimeOf,
  stepSoundOf,
} from './classify';
import type { GunSound } from './classify';
import type { MusicTrack } from './music';
import type { LoopName } from './recipes/loops';
import type { LoopOpts, PlayOpts, SfxHandle } from './sfx';
import { closestOnSegment, distance } from './spatial';
import { surfaceIndexFor } from './surfaces';
import type { Surface, SurfaceIndex } from './surfaces';

export interface SoundSink {
  now(): number;
  listener(): Vec3;
  play(name: SfxName, o?: PlayOpts): SfxHandle | null;
  loop(key: string, name: LoopName, o?: LoopOpts): void;
  music(track: MusicTrack | null): void;
  dipMusic(db: number, hold: number): void;
  /** local hero entered / left 濒死 (edge-triggered by the router) */
  autoDowned(on: boolean): void;
  /** 0..1 bleed-out progress while downed (heartbeat tempo) */
  downedUrgency(x: number): void;
}

const STATUS_SOUND: Partial<Record<StatusId, string>> = {
  stun: 'stun',
  freeze: 'freeze',
  burn: 'burn',
  charm: 'charm',
  dance: 'dance',
  silence: 'silence',
  stealth: 'stealth',
  reveal: 'reveal',
  root: 'root',
  chained: 'chain',
  shield: 'shield',
  invuln: 'invuln',
  haste: 'haste',
  nullify: 'nullify',
  dmgBoost: 'buff',
  fireRateUp: 'buff',
  noReload: 'buff',
  undodgeable: 'buff',
  pierce: 'buff',
  lifesteal: 'buff',
};

/** statuses only worth hearing on yourself */
const LOCAL_ONLY_STATUS = new Set<string>(['reveal', 'buff', 'haste']);

const RELOAD_SCRIPTS: Record<GunSound, readonly [number, string][]> = {
  pistol: [
    [0.12, 'out'],
    [0.55, 'in'],
    [0.82, 'rack'],
  ],
  smg: [
    [0.12, 'out'],
    [0.55, 'in'],
    [0.85, 'rack'],
  ],
  rifle: [
    [0.12, 'out'],
    [0.55, 'in'],
    [0.85, 'rack'],
  ],
  dmr: [
    [0.12, 'out'],
    [0.55, 'in'],
    [0.85, 'rack'],
  ],
  lmg: [
    [0.1, 'out'],
    [0.5, 'in'],
    [0.86, 'rack'],
  ],
  sniper: [
    [0.06, 'bolt'],
    [0.32, 'out'],
    [0.62, 'in'],
  ],
  shotgun: [],
  launcher: [
    [0.3, 'out'],
    [0.65, 'in'],
    [0.88, 'rack'],
  ],
  bow: [[0.25, 'draw']],
  crossbow: [
    [0.15, 'crank'],
    [0.6, 'draw'],
  ],
  flamer: [[0.2, 'tank']],
  tesla: [[0.35, 'in']],
  melee: [],
};

const WORLD_HAZARD: readonly [RegExp, LoopName][] = [
  [/lightning|storm|cloud|thunder|shandian/, 'storm'],
  [/fire|napalm|burn|flame|huo|lava/, 'fire'],
  [/arrow/, 'arrows'],
  [/heal|banner|regen|spring/, 'heal'],
];

const isTrap = (sub: string): boolean => /trap|lebu|bingliang|mine|hidden/.test(sub);

function hazardLoop(sub: string): LoopName | null {
  if (isTrap(sub)) return null;
  for (const [re, name] of WORLD_HAZARD) if (re.test(sub)) return name;
  return null;
}

const posOf = (e: ViewEntity, dy = 0): Vec3 => ({ x: e.x, y: e.y + dy, z: e.z });

interface AirdropTrack {
  id: EntityId;
  pos: Vec3;
  t0: number;
  lastY: number | null;
  falling: boolean;
  still: number;
}

interface StepState {
  phase: number;
}

/** a locally predicted shot waiting for its host echo */
interface PendingShot {
  t: number;
  weapon: string;
}

/** per-`handle()` bookkeeping */
interface Batch {
  /** world impacts played per shooter (capped) */
  impacts: Map<EntityId, number>;
  /** shots seen so far (chain-lightning arcs start where an earlier shot ended) */
  shots: { src: EntityId; weapon: string; to: Vec3 }[];
}

/** a predicted shot is matched with its host echo within this window (s) */
const LOCAL_ECHO_WINDOW = 1.2;
/** an arc's origin is at least this far (m, horizontal) from the shooter */
const ARC_MIN_OFFSET = 1.2;
/** ...and certainly an arc beyond this (view interpolation lag included) */
const ARC_SURE_OFFSET = 4;
/** zone horn and the phase announcement land on the same tick */
const HORN_ANNOUNCE_HOLD = 1.5;
/** thud for an airdrop whose landing was neither seen nor reported (sim fall time is 12 s) */
const AIRDROP_FALLBACK = 13.5;
/** shielded heroes other than you are audible within this range (m) */
const SHIELD_HUM_RANGE = 12;

/** Passive ability triggers (GameEvent ability.proc): abilityCast at this gain and size. */
export const PROC_GAIN = 0.5;
export const PROC_SIZE = 0.6;
/** EMP pulses play the 'thunder' explosion at this (small) size. */
export const EMP_SIZE = 0.6;
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

/** crate-tier variant of the crateOpen sound for a crate / airdrop entity */
function crateVariant(e: ViewEntity): '1' | '2' | '3' {
  if (e.kind === 'airdrop') return '3';
  return /3|gold|air/.test(e.sub) ? '3' : /2|bronze/.test(e.sub) ? '2' : '1';
}

/** A reference that does not keep its target alive (strong where WeakRef is missing). */
interface Ref<T> {
  deref(): T | undefined;
}
function weakRef<T extends object>(v: T): Ref<T> {
  return typeof WeakRef === 'function' ? new WeakRef(v) : { deref: () => v };
}

export class EventRouter {
  /**
   * The match view being fed and its surface index, held weakly: the engine
   * outlives every match, and a finished match (its view → host → sim world,
   * map) must not stay in memory through it.
   */
  private viewRef: Ref<ViewSource> | null = null;
  private surfacesRef: Ref<SurfaceIndex> | null = null;
  private get view(): ViewSource | null {
    return this.viewRef?.deref() ?? null;
  }
  private get surfaces(): SurfaceIndex | null {
    return this.surfacesRef?.deref() ?? null;
  }
  private pendingLocal: PendingShot[] = [];
  private lastShotAt = new Map<EntityId, number>();
  private flags = new Map<EntityId, number>();
  private reloads = new Map<EntityId, SfxHandle[]>();
  private steps = new Map<EntityId, StepState>();
  private throttles = new Map<string, number>();
  private airdrops: AirdropTrack[] = [];
  /** recent landing thuds (so the sim's airdropLand and the view heuristic never double) */
  private landed: { pos: Vec3; t: number }[] = [];
  private zonePhase = -1;
  private viewZonePhase = -1;
  private lastHorn = -Infinity;
  private lastLocalReload = 0;
  private lastLocalDowned = false;
  private lastUpdate = -1;
  private lastPrune = 0;
  private warned = 0;
  /** short-term combat heat 0..1 (nearby gunfire / explosions / damage) */
  heat = 0;

  constructor(private readonly sink: SoundSink) {}

  /** Forget all per-match state (new ViewSource). */
  reset(): void {
    this.pendingLocal = [];
    this.lastShotAt.clear();
    this.flags.clear();
    this.reloads.clear();
    this.steps.clear();
    this.throttles.clear();
    this.airdrops = [];
    this.landed = [];
    this.zonePhase = -1;
    this.viewZonePhase = -1;
    this.lastHorn = -Infinity;
    this.lastUpdate = -1;
    this.lastLocalReload = 0;
    this.lastLocalDowned = false;
    this.heat = 0;
  }

  /**
   * 0..1 music intensity implied by the zone phase (0 before the first
   * shrink, 1 in the final circle). 0 when no match view has been fed for a
   * couple of seconds (menus), so a finished match never keeps the music hot.
   */
  zoneLevel(now = this.sink.now()): number {
    if (this.lastUpdate < 0 || now - this.lastUpdate > 2) return 0;
    const phase = Math.max(this.zonePhase, this.viewZonePhase);
    return Math.max(0, Math.min(1, phase / 5));
  }

  /** true (and arms the throttle) if `key` did not fire within `gap` seconds */
  private gate(key: string, gap: number, now = this.sink.now()): boolean {
    const last = this.throttles.get(key);
    if (last !== undefined && now - last < gap) return false;
    this.throttles.set(key, now);
    return true;
  }

  private safeLocalId(view: ViewSource): EntityId | null {
    try {
      return view.localId();
    } catch {
      return null;
    }
  }

  // ── Local instant feedback ────────────────────────────────────────────────
  localFire(weaponId: string): void {
    const now = this.sink.now();
    const loc = this.safeLocal();
    if (loc) {
      const w = loc.weapons[loc.activeSlot];
      if (w && w.id === weaponId && w.mag <= 0 && loc.reloading <= 0) {
        if (this.gate('dry', 0.22, now)) this.sink.play('dryFire', { local: true, priority: 4 });
        return;
      }
    }
    this.pendingLocal.push({ t: now, weapon: weaponId });
    if (this.pendingLocal.length > 64) this.pendingLocal.shift();
    this.heat = Math.min(1, this.heat + 0.015);
    const g = gunSoundOf(weaponId);
    if (g === 'flamer') {
      this.sink.loop('flamer:local', 'flamer', { gain: 0.8, keepAlive: 0.22, priority: 4 });
      return;
    }
    this.sink.play('gun', { variant: g, local: true, seed: hash01(weaponId), flavor: gunFlavorOf(weaponId), priority: 4, group: 'gun:local' });
    if (g === 'pistol' || g === 'smg' || g === 'rifle' || g === 'dmr' || g === 'lmg' || g === 'sniper') {
      this.sink.play('casing', { delay: 0.32 + Math.random() * 0.15, local: true });
    }
    const fr = fireRateOf(weaponId);
    if (g === 'shotgun' && fr <= 1.6) this.sink.play('reload', { variant: 'pump', delay: 0.26, local: true, priority: 3, group: 'action' });
    if (g === 'sniper' && fr <= 1.2) this.sink.play('reload', { variant: 'bolt', delay: 0.42, local: true, priority: 3, group: 'action' });
  }

  /** Local dry-fire click (explicit call). */
  dryFire(): void {
    if (this.gate('dry', 0.22)) this.sink.play('dryFire', { local: true, priority: 4 });
  }

  private safeLocal(): ReturnType<ViewSource['local']> {
    try {
      return this.view?.local() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Consume the oldest pending local shot (fired within LOCAL_ECHO_WINDOW)
   * whose weapon satisfies `match`; true when the host event is its echo.
   */
  private consumeLocal(now: number, match: (weaponId: string) => boolean): boolean {
    while (this.pendingLocal.length && now - this.pendingLocal[0].t > LOCAL_ECHO_WINDOW) this.pendingLocal.shift();
    const i = this.pendingLocal.findIndex((p) => match(p.weapon));
    if (i < 0) return false;
    this.pendingLocal.splice(i, 1);
    return true;
  }

  // ── Per frame ──────────────────────────────────────────────────────────────
  handle(events: readonly GameEvent[], view: ViewSource): void {
    if (view !== this.view) {
      this.reset();
      this.viewRef = weakRef(view);
      let idx: SurfaceIndex | null = null;
      try {
        idx = surfaceIndexFor(view.map);
      } catch {
        idx = null;
      }
      this.surfacesRef = idx ? weakRef(idx) : null;
    }
    const now = this.sink.now();
    const dt = this.lastUpdate < 0 ? 0 : Math.max(0, Math.min(0.25, now - this.lastUpdate));
    this.lastUpdate = now;
    const localId = this.safeLocalId(view);
    const batch: Batch = { impacts: new Map(), shots: [] };
    for (const ev of events) {
      try {
        this.event(ev, view, localId, now, batch);
      } catch (err) {
        if (this.warned++ < 3) console.warn('[audio] event handling failed', ev?.t, err);
      }
    }
    try {
      this.scan(view, localId, now, dt);
    } catch (err) {
      if (this.warned++ < 3) console.warn('[audio] view scan failed', err);
    }
    this.heat *= Math.exp(-dt / 7);
  }

  private entityPos(view: ViewSource, id: EntityId | undefined, dy = 1): Vec3 | undefined {
    if (id === undefined) return undefined;
    const e = view.get(id);
    return e ? posOf(e, dy) : undefined;
  }

  /** material at a hit point; null when the point is in the air (a miss) */
  private surfaceAt(p: Vec3): Surface | null {
    return this.surfaces ? this.surfaces.impactAt(p) : 'dirt';
  }

  private event(ev: GameEvent, view: ViewSource, localId: EntityId | null, now: number, batch: Batch): void {
    const lis = this.sink.listener();
    switch (ev.t) {
      case 'shot':
        return this.onShot(ev, view, localId, now, batch, lis);
      case 'hit':
        return this.onHit(ev, view, localId, now);
      case 'explosion': {
        const k = (ev.kind || '').toLowerCase();
        // EMP pulse (过河拆桥): an electric crack, not a frag blast — the thunder recipe, kept small
        const emp = /(^|[^a-z])emp([^a-z]|$)/.test(k); // 'emp', 'emp_pulse' — not 'tempest'
        const variant = /fire|napalm|incend|burn|flame/.test(k)
          ? 'fire'
          : emp || /thunder|lightning|storm|shock/.test(k)
            ? 'thunder'
            : /ice|frost|freeze|cryo/.test(k)
              ? 'ice'
              : /holy|heal|light/.test(k)
                ? 'holy'
                : /gas|smoke|poison|mafei/.test(k)
                  ? 'gas'
                  : k === 'rocket'
                    ? 'rocket'
                    : 'frag';
        const size = emp ? EMP_SIZE : Math.max(0.5, Math.min(2.2, (ev.radius || 5) / 5));
        this.sink.play('explosion', { pos: ev.pos, variant, size });
        const d = distance(ev.pos, lis);
        if (d < 45) {
          this.sink.dipMusic(3 + (45 - d) / 10, 0.25);
          this.heat = Math.min(1, this.heat + 0.2);
        }
        return;
      }
      case 'melee': {
        const local = ev.src === localId;
        // only a predicted melee-weapon swing is echoed by this event; ability
        // cleaves (武圣, 青龙斩, ...) never cancel a pending gunshot
        if (local && this.consumeLocal(now, (w) => gunSoundOf(w) === 'melee')) return;
        this.sink.play('gun', { variant: 'melee', pos: local ? undefined : ev.pos, local });
        return;
      }
      case 'ability': {
        const e = view.get(ev.src);
        const heroId = e?.kind === 'hero' ? e.sub : undefined;
        const kingdom = e?.kingdom ?? kingdomOfHero(heroId) ?? 'god';
        const local = ev.src === localId;
        if (!this.gate(`ab:${ev.src}:${ev.ability}`, 0.25, now)) return;
        const pos = local ? undefined : e ? posOf(e, 1.2) : ev.pos;
        if (!local && !pos) return;
        // a passive trigger (奸雄, 流离, 连营 …) is not an activation: a lighter, smaller cue
        const proc = ev.proc === true;
        this.sink.play('abilityCast', {
          pos,
          variant: kingdom,
          flavor: abilityFlavorOf(ev.ability),
          size: proc ? PROC_SIZE : isLordAbility(heroId, ev.ability) ? 1.5 : 1,
          gain: proc ? PROC_GAIN : undefined,
          local,
          priority: proc ? (local ? 3 : 2) : local ? 4 : 3,
        });
        return;
      }
      case 'status': {
        const variant = STATUS_SOUND[ev.status];
        if (!variant) return;
        const local = ev.target === localId;
        if (!ev.on) {
          if (ev.status === 'shield' && (local || this.near(view, ev.target, lis, 20))) {
            if (this.gate(`sd:${ev.target}`, 0.5, now)) this.sink.play('shieldDown', { pos: local ? undefined : this.entityPos(view, ev.target), gain: local ? 0.8 : 0.6 });
          }
          return;
        }
        if (!local && (LOCAL_ONLY_STATUS.has(variant) || !this.near(view, ev.target, lis, 30))) return;
        if (!this.gate(`st:${ev.target}:${ev.status}`, 0.6, now)) return;
        this.sink.play('status', {
          variant,
          pos: local ? undefined : this.entityPos(view, ev.target),
          gain: local ? 1 : variant === 'stealth' ? 0.5 : 0.8,
          priority: local ? 4 : 2,
        });
        return;
      }
      case 'heal': {
        if (!(ev.amount >= 1)) return;
        const local = ev.target === localId;
        const big = ev.amount >= 60;
        if (local) {
          if (!this.gate('heal:local', big ? 0.6 : ev.amount < 20 ? 2.2 : 1.1, now)) return;
          this.sink.play('heal', { size: big ? 1.5 : 1, gain: ev.amount < 20 ? 0.55 : 1, priority: 4 });
        } else {
          if (!this.near(view, ev.target, lis, 25) || !this.gate(`heal:${ev.target}`, 1.6, now)) return;
          this.sink.play('heal', { pos: this.entityPos(view, ev.target), size: big ? 1.5 : 1, gain: 0.7 });
        }
        return;
      }
      case 'downed': {
        const local = ev.target === localId;
        this.sink.play('downed', { pos: local ? undefined : this.entityPos(view, ev.target), priority: local ? 5 : 3 });
        if (local) {
          this.sink.play('tinnitus', {});
          this.heat = Math.min(1, this.heat + 0.3);
        }
        return;
      }
      case 'revived': {
        const local = ev.target === localId;
        this.sink.play('revive', { pos: local ? undefined : this.entityPos(view, ev.target), priority: local ? 5 : 3 });
        return;
      }
      case 'death': {
        const local = ev.target === localId;
        if (ev.kind === 'hero') {
          this.sink.play('deathGong', { local });
          if (ev.killer !== undefined && ev.killer === localId && !local) this.sink.play('killConfirm', { delay: 0.05 });
        } else if (ev.kind === 'troop' || ev.kind === 'npc') {
          const pos = this.entityPos(view, ev.target, 0.8);
          if (pos) this.sink.play('unitDeath', { pos });
          if (ev.killer !== undefined && ev.killer === localId && this.gate('kc:unit', 0.3, now)) {
            this.sink.play('killConfirm', { gain: 0.45, pitch: 1.12 });
          }
        }
        return;
      }
      case 'pickup': {
        const local = ev.who === localId;
        if (!local && !this.near(view, ev.who, lis, 12)) return;
        this.sink.play('pickup', { variant: pickupSoundOf(ev.item), pos: local ? undefined : this.entityPos(view, ev.who), gain: local ? 1 : 0.6 });
        return;
      }
      case 'itemUse': {
        const local = ev.who === localId;
        const pos = local ? undefined : (this.entityPos(view, ev.who) ?? ev.pos);
        if (!local && (!pos || distance(pos, lis) > 45)) return;
        this.sink.play('itemUse', { variant: itemSoundOf(ev.item), pos, priority: local ? 4 : 2 });
        return;
      }
      case 'reward':
        if (ev.who === localId) this.sink.play('reward', { variant: ev.kind === 'lordPenalty' ? 'penalty' : 'reward' });
        return;
      case 'zone':
        if (ev.phase !== this.zonePhase) {
          this.zonePhase = ev.phase;
          if (ev.phase >= 1) {
            this.sink.play('zoneHorn', {});
            this.lastHorn = now;
          }
        }
        return;
      case 'airdrop': {
        const h = hash01(`drop${ev.id}`) * Math.PI * 2;
        const dx = Math.cos(h);
        const dz = Math.sin(h);
        const alt = ev.pos.y + 110;
        this.sink.play('plane', {
          path: {
            from: { x: ev.pos.x - dx * 420, y: alt, z: ev.pos.z - dz * 420 },
            to: { x: ev.pos.x + dx * 420, y: alt, z: ev.pos.z + dz * 420 },
            duration: 9,
          },
          size: 1,
        });
        this.airdrops.push({ id: ev.id, pos: { ...ev.pos }, t0: now, lastY: null, falling: false, still: 0 });
        return;
      }
      case 'claim':
        if (this.gate('claim', 0.2, now)) this.sink.play('claim', {});
        return;
      case 'quickchat':
        if (ev.who !== localId && this.gate('chat', 0.25, now)) this.sink.play('chat', {});
        return;
      case 'chat':
        if (this.gate('chat', 0.25, now)) this.sink.play('chat', {});
        return;
      case 'command':
        if (ev.who === localId) this.sink.play('command', { variant: ev.order });
        return;
      case 'announce':
        // the zone horn already covers the phase-change announcement
        if (now - this.lastHorn < HORN_ANNOUNCE_HOLD && (ev.kind === 'big' || ev.kind === 'warn')) return;
        if (ev.kind === 'big' && this.gate('ann:big', 1, now)) this.sink.play('announce', { variant: 'big' });
        else if (ev.kind === 'warn' && this.gate('ann:warn', 1.5, now)) this.sink.play('announce', { variant: 'warn' });
        return;
      case 'sfx': {
        const r = resolveSfxName(ev.name);
        if (!r) return;
        if (r.name === 'crateOpen') return this.onCrateOpen(ev.pos, r.variant, view, now);
        if (r.name === 'airdropThud' && ev.pos) return this.onAirdropLand(ev.pos, now);
        this.sink.play(r.name, { pos: ev.pos, variant: r.variant });
        return;
      }
      case 'gameOver': {
        const won = localId !== null && ev.result.winners.includes(localId);
        this.sink.music(won ? 'victory' : 'defeat');
        return;
      }
      default:
        return;
    }
  }

  /** sim `crateOpen` sfx: tier from the crate / airdrop entity at `pos` */
  private onCrateOpen(pos: Vec3 | undefined, variant: string, view: ViewSource, now: number): void {
    let crate: ViewEntity | undefined;
    if (pos) {
      let best = 2.5;
      for (const e of view.entities()) {
        if (e.kind !== 'crate' && e.kind !== 'airdrop') continue;
        const d = horiz(e, pos);
        if (d < best) {
          best = d;
          crate = e;
        }
      }
    }
    const key = crate ? `crate:${crate.id}` : pos ? `crate:${Math.round(pos.x)}:${Math.round(pos.z)}` : 'crate:?';
    if (!this.gate(key, 1, now)) return;
    this.sink.play('crateOpen', { pos: crate ? posOf(crate, 0.5) : pos, variant: crate ? crateVariant(crate) : variant || '1' });
  }

  /** sim `airdropLand` sfx: the authoritative landing (the view heuristic is the fallback) */
  private onAirdropLand(pos: Vec3, now: number): void {
    const i = this.airdrops.findIndex((a) => horiz(a.pos, pos) < 6);
    if (i >= 0) this.airdrops.splice(i, 1);
    else if (this.landed.some((l) => now - l.t < 5 && horiz(l.pos, pos) < 6)) return;
    this.thud(pos, now);
  }

  private thud(pos: Vec3, now: number): void {
    this.landed = this.landed.filter((l) => now - l.t < 5);
    this.landed.push({ pos, t: now });
    this.sink.play('airdropThud', { pos });
  }

  private near(view: ViewSource, id: EntityId, lis: Vec3, r: number): boolean {
    const e = view.get(id);
    return !!e && distance(posOf(e), lis) <= r;
  }

  /**
   * Chain-lightning jump: the sim emits an extra `shot` per jump with the same
   * src + weapon, starting at the previous victim. Arcs never consume a local
   * prediction and never sound like another gunshot.
   */
  private isArc(ev: Extract<GameEvent, { t: 'shot' }>, shooter: ViewEntity | undefined, view: ViewSource, batch: Batch): boolean {
    if (!isChainWeapon(ev.weapon)) return false;
    // starts where an earlier shot of this volley ended (its victim)
    for (const p of batch.shots) {
      if (p.src === ev.src && p.weapon === ev.weapon && distance(p.to, ev.from) < 1.5) return true;
    }
    if (!shooter) return false;
    const off = horiz(ev.from, shooter);
    if (off > ARC_SURE_OFFSET) return true;
    if (off < ARC_MIN_OFFSET) return false;
    // close range: an arc starts at another unit's centre, a primary at the shooter's eye
    for (const e of view.entities()) {
      if (e.id === shooter.id || (e.kind !== 'hero' && e.kind !== 'troop' && e.kind !== 'npc' && e.kind !== 'turret')) continue;
      if (horiz(e, ev.from) < 0.9) return true;
    }
    return false;
  }

  private onShot(ev: Extract<GameEvent, { t: 'shot' }>, view: ViewSource, localId: EntityId | null, now: number, batch: Batch, lis: Vec3): void {
    const g = gunSoundOf(ev.weapon);
    const shooter = view.get(ev.src);
    if (this.isArc(ev, shooter, view, batch)) {
      batch.shots.push({ src: ev.src, weapon: ev.weapon, to: ev.to });
      const cp = closestOnSegment(ev.from, ev.to, lis);
      if (distance(cp, lis) < 70) this.sink.play('arc', { pos: cp, gain: ev.src === localId ? 1 : 0.85 });
      return;
    }
    batch.shots.push({ src: ev.src, weapon: ev.weapon, to: ev.to });
    // world impact where the round ended (not on a unit, not in the air, not a projectile's aim point)
    const impacts = batch.impacts.get(ev.src) ?? 0;
    if (ev.hit === undefined && impacts < 3 && g !== 'flamer' && g !== 'melee' && !isProjectileWeapon(ev.weapon)) {
      const surf = this.surfaceAt(ev.to);
      if (surf) {
        batch.impacts.set(ev.src, impacts + 1);
        this.sink.play('impact', { pos: ev.to, variant: surf });
      }
    }
    if (ev.src === localId) {
      const echo = (w: string): boolean => w === ev.weapon;
      if (g === 'flamer') {
        // host confirms a local flamethrower: keep the local loop alive
        this.sink.loop('flamer:local', 'flamer', { gain: 0.8, keepAlive: 0.22, priority: 4 });
        this.consumeLocal(now, echo);
        return;
      }
      if (this.consumeLocal(now, echo)) return;
      // shot not initiated by localFire (ability volley, charm auto-fire)
      this.sink.play('gun', { variant: g, local: true, seed: hash01(ev.weapon), flavor: gunFlavorOf(ev.weapon), priority: 4, group: 'gun:local' });
      return;
    }
    const d = distance(ev.from, lis);
    if (g === 'flamer') {
      this.sink.loop(`flamer:${ev.src}`, 'flamer', { pos: ev.from, gain: 0.9, keepAlive: 0.25, profile: 'medium' });
      return;
    }
    // stagger shots from one shooter that arrive bunched (network / frame hitch)
    const fr = fireRateOf(ev.weapon);
    const last = this.lastShotAt.get(ev.src) ?? -Infinity;
    const start = Math.max(now, last + Math.min(0.12, 0.6 / Math.max(0.5, fr)));
    const delay = start - now;
    if (delay > 0.3) return;
    this.lastShotAt.set(ev.src, start);
    const hero = shooter?.kind === 'hero';
    this.sink.play('gun', {
      pos: ev.from,
      variant: g,
      seed: hash01(ev.weapon),
      flavor: gunFlavorOf(ev.weapon),
      priority: hero ? 2 : 1,
      delay,
      gain: hero ? 1 : 0.8,
    });
    this.heat = Math.min(1, this.heat + (d < 60 ? 0.045 : 0.008));
    // supersonic crack / whiz when a round passes close to the listener
    if (d > 6) {
      const cp = closestOnSegment(ev.from, ev.to, lis);
      const miss = distance(cp, lis);
      if (miss < 3.5 && distance(cp, ev.from) > 8 && distance(cp, ev.to) > 0.5) {
        this.sink.play('flyby', { pos: cp, delay, gain: 1 - miss / 4 });
      }
    }
  }

  private onHit(ev: Extract<GameEvent, { t: 'hit' }>, view: ViewSource, localId: EntityId | null, now: number): void {
    const local = ev.target === localId;
    const target = view.get(ev.target);
    if (ev.blocked) {
      const variant =
        ev.blocked === 'shield' ? 'shield' : ev.blocked === 'armor' ? 'armor' : ev.blocked === 'invuln' ? 'invuln' : ev.blocked === 'nullify' ? 'nullify' : 'dodge';
      this.sink.play('impact', { pos: local ? undefined : ev.pos, variant, gain: local ? 0.7 : 0.9 });
      return;
    }
    if (ev.dtype === 'zone') {
      if (local && this.gate('zoneTick', 0.9, now)) this.sink.play('zoneTick', {});
      return;
    }
    if (local) {
      if (this.gate('hurt', 0.12, now)) this.sink.play('hurt', { size: Math.max(0.5, Math.min(1.6, ev.amount / 60)) });
      this.heat = Math.min(1, this.heat + 0.08);
    } else if (ev.dtype === 'normal' || ev.dtype === 'pierce' || ev.dtype === 'melee' || ev.dtype === 'true') {
      let variant: Surface | 'flesh' = 'flesh';
      if (target) {
        if (target.kind === 'crate') variant = 'wood';
        else if (target.kind === 'turret' || target.kind === 'airdrop') variant = 'metal';
        else if (target.kind === 'hero' || target.kind === 'troop' || target.kind === 'npc') variant = 'flesh';
        else variant = this.surfaceAt(ev.pos) ?? 'dirt';
      }
      this.sink.play('impact', { pos: ev.pos, variant, size: ev.dtype === 'melee' ? 1.4 : 1 });
      if (variant === 'flesh' && target?.armor && Math.random() < 0.35) this.sink.play('impact', { pos: ev.pos, variant: 'armor', gain: 0.5 });
    }
    if (ev.src !== undefined && ev.src === localId && !local && ev.amount > 0) {
      if (ev.head) this.sink.play('headshot', {});
      else this.sink.play('hitmarker', { pitch: ev.amount >= 50 ? 0.85 : 1 });
    }
  }

  // ── Continuous state from the view ───────────────────────────────────────
  private scan(view: ViewSource, localId: EntityId | null, now: number, dt: number): void {
    const lis = this.sink.listener();
    const local = this.safeLocal();
    if (local) {
      if (local.reloading > 0 && this.lastLocalReload <= 0 && localId !== null) {
        const w = local.weapons[local.activeSlot];
        this.startReload(localId, w?.id, local.reloading, undefined);
      } else if (local.reloading <= 0 && this.lastLocalReload > 0.12 && localId !== null) {
        this.cancelReload(localId);
      }
      this.lastLocalReload = local.reloading;
      const downed = local.downed && !local.dead;
      if (downed !== this.lastLocalDowned) {
        this.lastLocalDowned = downed;
        this.sink.autoDowned(downed);
      }
      if (downed) this.sink.downedUrgency(1 - Math.max(0, Math.min(1, local.downedRemaining / 12)));
    }

    const walkers: { e: ViewEntity; d: number }[] = [];
    const shielded: { e: ViewEntity; d: number }[] = [];
    let localShield = !!local && local.shield > 0 && !local.dead;
    const hazards: { e: ViewEntity; d: number; loop: LoopName }[] = [];
    const rockets: { e: ViewEntity; d: number }[] = [];
    const ents = view.entities();
    for (const e of ents) {
      const d = distance(posOf(e), lis);
      if (e.kind === 'hero' || e.kind === 'troop' || e.kind === 'npc') {
        const prev = this.flags.get(e.id);
        this.flags.set(e.id, e.flags);
        const isLocal = e.id === localId;
        if (prev !== undefined && e.kind === 'hero') {
          const rising = e.flags & ~prev;
          const falling = prev & ~e.flags;
          if (rising & VF_DODGING && (isLocal || d < 30)) this.sink.play('dodge', { pos: isLocal ? undefined : posOf(e, 1), gain: isLocal ? 0.8 : 1 });
          if (!isLocal) {
            if (rising & VF_RELOADING && d < 18) this.startReload(e.id, e.weapon, reloadTimeOf(e.weapon), posOf(e, 1.2));
            else if (falling & VF_RELOADING) this.cancelReload(e.id);
          }
          if (d < 24 && !(e.flags & (VF_DEAD | VF_DOWNED))) {
            if (rising & VF_AIRBORNE) this.sink.play('footstep', { variant: 'jump', pos: posOf(e), gain: isLocal ? 0.5 : 0.8 });
            else if (falling & VF_AIRBORNE) this.sink.play('footstep', { variant: 'land', pos: posOf(e), gain: isLocal ? 0.6 : 1 });
          }
        }
        if (!isLocal && e.kind === 'hero' && e.flags & VF_FIRING && gunSoundOf(e.weapon) === 'flamer' && d < 60) {
          this.sink.loop(`flamer:${e.id}`, 'flamer', { pos: posOf(e, 1.3), gain: 0.9, keepAlive: 0.25, profile: 'medium' });
        }
        if (e.kind === 'hero' && (e.flags & VF_SHIELDED || e.shield > 0) && !(e.flags & VF_DEAD)) {
          if (isLocal) localShield = true;
          else if (d < SHIELD_HUM_RANGE) shielded.push({ e, d });
        }
        const maxD = e.kind === 'hero' ? 28 : 16;
        if (d < maxD && !(e.flags & (VF_DEAD | VF_AIRBORNE)) && e.speed > (e.flags & VF_DOWNED ? 0.2 : 0.7)) walkers.push({ e, d });
        else this.steps.delete(e.id);
      } else if (e.kind === 'crate' || e.kind === 'airdrop') {
        const prev = this.flags.get(e.id);
        this.flags.set(e.id, e.flags);
        if (prev !== undefined && !(prev & VF_OPENED) && e.flags & VF_OPENED && d < 40) {
          // the sim's crateOpen sfx usually arrives first and arms the same gate
          if (this.gate(`crate:${e.id}`, 1, now)) this.sink.play('crateOpen', { pos: posOf(e, 0.5), variant: crateVariant(e) });
        }
      } else if (e.kind === 'hazard') {
        const loop = d < 50 ? hazardLoop(e.sub) : null;
        if (loop) hazards.push({ e, d, loop });
      } else if (e.kind === 'projectile') {
        if (d < 55 && /rocket|missile|ship|fireball|drone/.test(e.sub)) rockets.push({ e, d });
      }
    }

    // footsteps for the closest movers
    walkers.sort((a, b) => a.d - b.d);
    for (let i = 0; i < walkers.length; i++) {
      const { e } = walkers[i];
      if (i >= 6) {
        this.steps.delete(e.id);
        continue;
      }
      this.stepFor(e, e.id === localId, dt);
    }
    // hazard loops: nearest few
    hazards.sort((a, b) => a.d - b.d);
    let fires = 0;
    let others = 0;
    for (const h of hazards) {
      if (h.loop === 'fire' ? fires++ >= 3 : others++ >= 2) continue;
      this.sink.loop(`haz:${h.e.id}`, h.loop, { pos: posOf(h.e, 0.5), size: Math.max(0.5, Math.min(2, (h.e.radius ?? 3) / 3)), keepAlive: 0.3, priority: 1 });
    }
    // barrier hum: yourself (non-positional) + the two nearest shielded heroes
    if (localShield) this.sink.loop('shield:local', 'shield', { gain: 0.55, keepAlive: 0.3, priority: 3 });
    shielded.sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(2, shielded.length); i++) {
      const e = shielded[i].e;
      this.sink.loop(`shield:${e.id}`, 'shield', { pos: posOf(e, 1.1), gain: 0.8, keepAlive: 0.3, profile: 'quiet', priority: 1 });
    }
    rockets.sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(3, rockets.length); i++) {
      const r = rockets[i].e;
      this.sink.loop(`proj:${r.id}`, 'rocket', { pos: posOf(r), keepAlive: 0.15, profile: 'medium', priority: 2 });
    }

    this.zoneAmbience(view, lis);
    this.trackAirdrops(view, now);

    if (now - this.lastPrune > 2) {
      this.lastPrune = now;
      const alive = new Set<EntityId>();
      for (const e of ents) alive.add(e.id);
      for (const id of this.flags.keys()) if (!alive.has(id)) this.flags.delete(id);
      for (const id of this.steps.keys()) if (!alive.has(id)) this.steps.delete(id);
      for (const id of this.lastShotAt.keys()) if (!alive.has(id)) this.lastShotAt.delete(id);
      for (const [k, t] of this.throttles) if (now - t > 30) this.throttles.delete(k);
    }
  }

  private stepFor(e: ViewEntity, isLocal: boolean, dt: number): void {
    const mounted = !!(e.flags & VF_MOUNTED) || !!e.mount;
    const kind = e.flags & VF_DOWNED ? 'crawl' : stepSoundOf(e.kind, e.sub, mounted);
    const rate =
      kind === 'crawl'
        ? 1.1
        : kind === 'hoof'
          ? Math.max(1.6, Math.min(4, e.speed * 0.32))
          : kind === 'stomp'
            ? Math.max(0.7, Math.min(1.4, e.speed * 0.25))
            : Math.max(1.2, Math.min(3.4, 0.9 + e.speed * 0.3));
    let st = this.steps.get(e.id);
    if (!st) {
      st = { phase: 0.5 + Math.random() * 0.4 };
      this.steps.set(e.id, st);
    }
    st.phase += dt * rate;
    if (st.phase < 1) return;
    st.phase -= Math.floor(st.phase);
    const pos = posOf(e);
    let variant: string = kind;
    if (kind === 'foot') variant = this.surfaces?.floorAt(pos) ?? 'dirt';
    if (variant === 'soft' || variant === 'metal') variant = 'dirt';
    const size = (e.flags & VF_SPRINTING ? 1.2 : 1) * (e.kind === 'hero' ? 1 : 0.8);
    const gain = isLocal ? 0.35 : e.kind === 'hero' ? 1 : 0.6;
    this.sink.play('footstep', { variant, pos, size, gain, priority: isLocal ? 1 : 0 });
    if (kind === 'hoof') this.sink.play('footstep', { variant, pos, size: size * 0.8, gain: gain * 0.8, delay: 0.075, priority: 0 });
  }

  private startReload(id: EntityId, weaponId: string | undefined, total: number, pos: Vec3 | undefined): void {
    this.cancelReload(id);
    const g = gunSoundOf(weaponId);
    const T = Math.max(0.3, Math.min(6, Number.isFinite(total) ? total : 2));
    let script = RELOAD_SCRIPTS[g];
    if (g === 'shotgun') {
      const n = Math.max(2, Math.min(5, Math.round(T / 0.5)));
      const parts: [number, string][] = [];
      for (let i = 0; i < n; i++) parts.push([0.12 + (i * 0.66) / n, 'shell']);
      parts.push([0.88, 'pump']);
      script = parts;
    }
    const local = pos === undefined;
    const handles: SfxHandle[] = [];
    for (const [f, variant] of script) {
      const h = this.sink.play('reload', { variant, pos, delay: f * T, local, priority: local ? 3 : 1, gain: local ? 1 : 0.8 });
      if (h) handles.push(h);
    }
    this.reloads.set(id, handles);
  }

  private cancelReload(id: EntityId): void {
    const hs = this.reloads.get(id);
    if (!hs) return;
    const now = this.sink.now();
    for (const h of hs) if (h.end > now + 0.05) h.stop();
    this.reloads.delete(id);
  }

  private zoneAmbience(view: ViewSource, lis: Vec3): void {
    let z;
    try {
      z = view.zone();
    } catch {
      return;
    }
    if (!z) return;
    if (Number.isFinite(z.phase)) this.viewZonePhase = z.phase;
    if (!(z.radius > 0) || !Number.isFinite(z.radius)) return;
    const dx = lis.x - z.center.x;
    const dz = lis.z - z.center.z;
    const dl = Math.hypot(dx, dz);
    const edge = dl - z.radius;
    if (edge < -30) return;
    const k = Math.max(0, Math.min(1, (edge + 30) / 35));
    const gain = 0.2 + 0.8 * k * k;
    if (edge < 0 && dl > 1e-3) {
      const pos = { x: z.center.x + (dx / dl) * z.radius, y: lis.y, z: z.center.z + (dz / dl) * z.radius };
      this.sink.loop('zone:edge', 'zone', { pos, gain, keepAlive: 0.5, profile: 'ambient', priority: 1 });
    } else {
      this.sink.loop('zone:out', 'zone', { gain: gain * 0.8, keepAlive: 0.5, priority: 1 });
    }
  }

  private trackAirdrops(view: ViewSource, now: number): void {
    if (!this.airdrops.length) return;
    this.airdrops = this.airdrops.filter((a) => {
      const e = view.get(a.id);
      if (e) {
        if (a.lastY !== null) {
          const dy = a.lastY - e.y;
          if (dy > 0.01) {
            a.falling = true;
            a.still = 0;
          } else if (a.falling && Math.abs(dy) < 0.005) {
            a.still++;
          }
        }
        a.lastY = e.y;
        a.pos = posOf(e);
        if (a.falling && a.still >= 2) {
          this.thud(a.pos, now);
          return false;
        }
      } else if (now - a.t0 > AIRDROP_FALLBACK) {
        // never saw it land (out of view) and no airdropLand event arrived
        this.thud(a.pos, now);
        return false;
      }
      return now - a.t0 < 25;
    });
  }
}
