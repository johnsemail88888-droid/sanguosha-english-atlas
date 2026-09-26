// A small, deterministic stand-in SimHost. Used by the net unit/e2e tests and
// handy for UI work while the real sim (sim/world.ts) is unavailable:
// heroes move with the shared predictMove, bots walk in circles, each hero has
// a squad of troops, hidden roles are respected in snapshots, and the match can
// be ended after a fixed time. It is NOT gameplay — no combat.
import type { MapData } from '../core/map';
import { terrainHeight } from '../core/map';
import {
  BTN_ADS,
  SIM_DT,
  VF_DEAD,
  VF_INVULN,
  VF_LORD,
  VF_REVEALED,
  emptyInput,
  type EntityId,
  type GameEvent,
  type GameResult,
  type InputAction,
  type InputFrame,
  type Kingdom,
  type PlayerId,
  type PrivateHeroView,
  type PublicPlayerView,
  type RoleId,
  type Snapshot,
  type ViewEntity,
  type ZoneView,
} from '../core/types';
import { HERO_BY_ID } from '../data/heroes';
import type { MatchInit, SimHost } from '../sim/host';
import { generateMap } from '../sim/map/generate';
import { buildCollisionWorld, predictMove, type CollisionWorld, type MoveState } from '../sim/physics';

export interface FakeSimOptions {
  map?: MapData;
  /** end the match (lord side wins) after this many sim seconds */
  endAfterSeconds?: number;
  /** troops per hero (default 3) */
  troopsPerHero?: number;
}

interface FakeHero {
  id: EntityId;
  seat: number;
  playerId: PlayerId;
  name: string;
  isBot: boolean;
  role: RoleId;
  heroId: string;
  kingdom: Kingdom;
  st: MoveState;
  yaw: number;
  pitch: number;
  hp: number;
  maxHp: number;
  input: InputFrame;
  actions: InputAction[];
  lastSeq: number;
  claim?: RoleId;
  dead: boolean;
  kills: number;
  squad: EntityId[];
}

interface FakeTroop {
  id: EntityId;
  owner: FakeHero;
  slot: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export class FakeSim implements SimHost {
  readonly map: MapData;
  tick = 0;
  time = 0;
  private readonly cw: CollisionWorld;
  private readonly heroes: FakeHero[] = [];
  private readonly troops: FakeTroop[] = [];
  private events: GameEvent[] = [];
  private res: GameResult | null = null;
  private readonly zoneView: ZoneView;
  /** every playerId passed to setInput (tests) */
  readonly inputLog: { playerId: PlayerId; seq: number; actions: InputAction[] }[] = [];
  readonly conversions: { kind: 'bot' | 'human'; playerId: PlayerId; seat?: number }[] = [];
  /** timed statuses per hero (only their presence matters: 'invuln' shows as VF_INVULN): status → until (sim s) */
  private readonly statuses = new Map<EntityId, Map<string, number>>();

  constructor(
    readonly init: MatchInit,
    private readonly opts: FakeSimOptions = {},
  ) {
    this.map = opts.map ?? generateMap(init.settings.mapSeed);
    this.cw = buildCollisionWorld(this.map);
    let nextId = 1;
    const spawns = this.map.spawns.length > 0 ? this.map.spawns : [{ x: 0, y: 0, z: 0 }];
    for (const s of init.seats) {
      const def = HERO_BY_ID[s.heroId];
      const sp = s.role === 'lord' ? this.map.lordSpawn : spawns[s.seat % spawns.length];
      const maxHp = (def?.maxHp ?? 400) + (s.role === 'lord' || s.role === 'double' ? 100 : 0);
      this.heroes.push({
        id: nextId++,
        seat: s.seat,
        playerId: s.playerId,
        name: s.name,
        isBot: s.isBot,
        role: s.role,
        heroId: s.heroId,
        kingdom: def?.kingdom ?? 'qun',
        st: { pos: { x: sp.x, y: terrainHeight(this.map, sp.x, sp.z), z: sp.z }, vel: { x: 0, y: 0, z: 0 }, onGround: true },
        yaw: 0,
        pitch: 0,
        hp: maxHp,
        maxHp,
        input: emptyInput(),
        actions: [],
        lastSeq: 0,
        dead: false,
        kills: 0,
        squad: [],
      });
    }
    const perHero = opts.troopsPerHero ?? 3;
    for (const h of this.heroes) {
      for (let i = 0; i < perHero; i++) {
        const t: FakeTroop = { id: nextId++, owner: h, slot: i, x: h.st.pos.x, y: h.st.pos.y, z: h.st.pos.z, yaw: 0 };
        this.troops.push(t);
        h.squad.push(t.id);
      }
    }
    this.zoneView = {
      phase: 0,
      center: { x: 0, y: 0, z: 0 },
      radius: 230,
      targetCenter: { x: 0, y: 0, z: 0 },
      targetRadius: 230,
      shrinkStart: 90,
      shrinkEnd: 90,
      dps: 0,
    };
    this.events.push({ t: 'announce', zh: '战斗开始！', en: 'The battle begins!', kind: 'big' });
  }

  step(): void {
    this.tick++;
    this.time += SIM_DT;
    for (const h of this.heroes) {
      if (h.dead) continue;
      const input = h.isBot ? this.botInput(h) : h.input;
      predictMove(this.cw, h.st, input, SIM_DT, {
        speedMul: 1,
        canSprint: true,
        canJump: true,
        rooted: false,
        ads: (input.buttons & BTN_ADS) !== 0,
        downed: false,
      });
      h.yaw = input.yaw;
      h.pitch = input.pitch;
      for (const a of h.actions) this.applyAction(h, a);
      h.actions = [];
    }
    for (const t of this.troops) {
      const o = t.owner;
      const ang = o.yaw + Math.PI + (t.slot - 1) * 0.6;
      const tx = o.st.pos.x - Math.sin(ang) * 3;
      const tz = o.st.pos.z - Math.cos(ang) * 3;
      t.x += (tx - t.x) * 0.2;
      t.z += (tz - t.z) * 0.2;
      t.y = terrainHeight(this.map, t.x, t.z);
      t.yaw = o.yaw;
    }
    if (this.opts.endAfterSeconds !== undefined && !this.res && this.time >= this.opts.endAfterSeconds) this.finish();
  }

  private botInput(h: FakeHero): InputFrame {
    const f = emptyInput(this.tick);
    f.moveZ = 1;
    f.yaw = h.yaw + 0.02;
    return f;
  }

  private applyAction(h: FakeHero, a: InputAction): void {
    switch (a.a) {
      case 'jump':
        this.events.push({ t: 'sfx', name: 'jump', pos: { ...h.st.pos } });
        break;
      case 'claim':
        h.claim = a.role;
        this.events.push({ t: 'claim', who: h.id, role: a.role });
        break;
      case 'quickchat':
        this.events.push({ t: 'quickchat', who: h.id, id: a.id });
        break;
      default:
        break;
    }
  }

  private finish(): void {
    const roles: Record<EntityId, RoleId> = {};
    for (const h of this.heroes) roles[h.id] = h.role;
    const winners = this.heroes.filter((h) => h.role === 'lord' || h.role === 'loyalist' || h.role === 'double').map((h) => h.id);
    this.res = {
      winner: 'lord',
      winners,
      roles,
      reasonZh: '主公一方获胜（测试）',
      reasonEn: 'The Lord side wins (test)',
      durationSec: this.time,
    };
    this.events.push({ t: 'gameOver', result: this.res });
  }

  setInput(playerId: PlayerId, frame: InputFrame): void {
    const h = this.heroes.find((x) => x.playerId === playerId);
    if (!h) return;
    h.input = { ...frame, actions: [] };
    h.lastSeq = frame.seq;
    if (frame.actions.length) h.actions.push(...frame.actions);
    this.inputLog.push({ playerId, seq: frame.seq, actions: frame.actions });
  }

  /** role as `viewer` may see it */
  private visibleRole(h: FakeHero, viewer: FakeHero | undefined): RoleId | undefined {
    if (viewer === h) return h.role;
    if (h.dead) return h.role;
    if (h.role === 'lord') return 'lord';
    if (h.role === 'double') return viewer?.role === 'lord' ? 'double' : 'lord';
    return undefined;
  }

  snapshotFor(playerId: PlayerId): Snapshot {
    const viewer = this.heroes.find((x) => x.playerId === playerId);
    const ents: ViewEntity[] = [];
    for (const h of this.heroes) {
      const role = this.visibleRole(h, viewer);
      let flags = 0;
      if (h.dead) flags |= VF_DEAD;
      if (h.role === 'lord' || h.role === 'double') flags |= VF_LORD;
      if (role !== undefined && h !== viewer) flags |= VF_REVEALED;
      if (this.hasStatus(h.id, 'invuln')) flags |= VF_INVULN;
      const e: ViewEntity = {
        id: h.id,
        kind: 'hero',
        sub: h.heroId,
        x: h.st.pos.x,
        y: h.st.pos.y,
        z: h.st.pos.z,
        yaw: h.yaw,
        pitch: h.pitch,
        speed: Math.hypot(h.st.vel.x, h.st.vel.z),
        hp: h.hp,
        maxHp: h.maxHp,
        shield: 0,
        flags,
        kingdom: h.kingdom,
        weapon: HERO_BY_ID[h.heroId]?.signatureWeapon ?? 'pistol',
        name: h.name,
      };
      if (role !== undefined) e.role = role;
      if (h.claim !== undefined) e.claim = h.claim;
      ents.push(e);
    }
    for (const t of this.troops) {
      ents.push({
        id: t.id,
        kind: 'troop',
        sub: HERO_BY_ID[t.owner.heroId]?.troopType ?? 'shu_rifleman',
        x: t.x,
        y: t.y,
        z: t.z,
        yaw: t.yaw,
        pitch: 0,
        speed: 3,
        hp: 100,
        maxHp: 100,
        shield: 0,
        flags: 0,
        kingdom: t.owner.kingdom,
        owner: t.owner.id,
        weapon: 'troop_rifle',
      });
    }
    const players: PublicPlayerView[] = this.heroes.map((h) => {
      const p: PublicPlayerView = {
        playerId: h.playerId,
        name: h.name,
        isBot: h.isBot,
        seat: h.seat,
        entityId: h.id,
        heroId: h.heroId,
        kingdom: h.kingdom,
        alive: !h.dead,
        downed: false,
        kills: h.kills,
      };
      const role = this.visibleRole(h, viewer);
      if (role !== undefined) p.role = role;
      if (h.claim !== undefined) p.claim = h.claim;
      return p;
    });
    let you: PrivateHeroView | null = null;
    if (viewer) {
      you = {
        entityId: viewer.id,
        heroId: viewer.heroId,
        role: viewer.role,
        hp: viewer.hp,
        maxHp: viewer.maxHp,
        shield: 0,
        weapons: [{ id: HERO_BY_ID[viewer.heroId]?.signatureWeapon ?? 'pistol', mag: 30, reserve: 90 }, { id: 'pistol', mag: 12, reserve: 48 }],
        activeSlot: 0,
        items: [{ id: 'tao', count: 1 }, null, null, null],
        armor: null,
        mount: null,
        cooldowns: {},
        charges: {},
        abilityState: {},
        dodgeCharges: 2,
        reloading: 0,
        channel: null,
        downed: false,
        downedRemaining: 0,
        dead: viewer.dead,
        statuses: [],
        squad: viewer.squad.map((id) => ({ id, hp: 100, maxHp: 100 })),
        order: { kind: 'follow' },
        stats: { kills: 0, damage: 0, healing: 0, rescues: 0 },
        vel: { ...viewer.st.vel },
        onGround: viewer.st.onGround,
        moveMods: { speedMul: 1, canSprint: true, canJump: true, rooted: false },
      };
    }
    return {
      tick: this.tick,
      time: this.time,
      ackSeq: viewer?.lastSeq ?? 0,
      ents,
      zone: this.zoneView,
      you,
      players,
      elapsed: this.time,
    };
  }

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  result(): GameResult | null {
    return this.res;
  }

  entityOf(playerId: PlayerId): EntityId | null {
    return this.heroes.find((h) => h.playerId === playerId)?.id ?? null;
  }

  /** Timed status on a hero (the subset of World.applyStatus the host session uses: spawn shield, god mode). */
  applyStatus(id: EntityId, status: string, duration: number): boolean {
    const h = this.heroes.find((x) => x.id === id);
    if (!h || h.dead || !(duration > 0)) return false;
    let m = this.statuses.get(id);
    if (!m) this.statuses.set(id, (m = new Map()));
    m.set(status, Math.max(m.get(status) ?? 0, this.time + duration));
    return true;
  }

  removeStatus(id: EntityId, status: string): void {
    this.statuses.get(id)?.delete(status);
  }

  hasStatus(id: EntityId, status: string): boolean {
    const until = this.statuses.get(id)?.get(status);
    return until !== undefined && until > this.time;
  }

  convertToBot(playerId: PlayerId): void {
    const h = this.heroes.find((x) => x.playerId === playerId);
    if (!h) return;
    h.isBot = true;
    this.conversions.push({ kind: 'bot', playerId });
  }

  convertToHuman(seat: number, playerId: PlayerId, name: string): void {
    const h = this.heroes.find((x) => x.seat === seat);
    if (!h) return;
    h.isBot = false;
    h.playerId = playerId;
    h.name = name;
    h.input = emptyInput();
    this.conversions.push({ kind: 'human', playerId, seat });
  }

  /**
   * Test helper: kill a hero (reveals its role), optionally credited to
   * `killerSeat`. Mirrors the real sim's events: a 赏金猎人 killing its target
   * gets a { t:'reward', kind:'bounty' } event (hidden information).
   */
  kill(seat: number, killerSeat?: number): void {
    const h = this.heroes.find((x) => x.seat === seat);
    if (!h || h.dead) return;
    h.dead = true;
    const killer = killerSeat === undefined ? undefined : this.heroes.find((x) => x.seat === killerSeat);
    if (killer) killer.kills++;
    this.events.push({ t: 'death', target: h.id, killer: killer?.id, kind: 'hero', role: h.role, heroId: h.heroId, name: h.name });
    if (killer && !killer.dead && killer.role === 'bounty' && this.init.seats.find((x) => x.seat === killer.seat)?.bountyTargetSeat === seat) {
      this.events.push({ t: 'reward', who: killer.id, kind: 'bounty', items: ['tao'] });
    }
  }

  /** Test helper: emit an arbitrary event on the next drain. */
  emit(ev: GameEvent): void {
    this.events.push(ev);
  }
}

export const createFakeMatch = (init: MatchInit, opts?: FakeSimOptions): SimHost => new FakeSim(init, opts);
