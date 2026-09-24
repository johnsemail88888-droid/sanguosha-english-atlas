// Dev-harness mocks: a GameSession that walks through the match phases with
// fake data, and a ViewSource with lively fake HUD data. DOM-free (the fake 3D
// view + GameHandle live in harness.ts) so unit tests can drive them in Node.
import type { MapData } from '../../core/map';
import type {
  EntityId,
  GameEvent,
  GameResult,
  HeroSelectView,
  InputFrame,
  ItemStack,
  LobbySeat,
  LobbyState,
  MatchPhase,
  MatchSettings,
  PlayerId,
  PrivateHeroView,
  PublicPlayerView,
  RoleDealView,
  RoleId,
  StatusId,
  SquadOrderKind,
  ViewEntity,
  ZoneView,
} from '../../core/types';
import {
  VF_ADS,
  VF_DEAD,
  VF_DOWNED,
  VF_FIRING,
  VF_LORD,
  VF_MARKED,
  VF_REVEALED,
  defaultSettings,
} from '../../core/types';
import { Rng } from '../../core/rng';
import { HEROES, HERO_BY_ID, ITEMS, ITEM_BY_ID, LORD_CANDIDATE_IDS, ROLE_DISTRIBUTION, WEAPONS, WEAPON_BY_ID } from '../../data';
import type { GameSession, SessionEvent, SessionEventMap } from '../../game/session';
import type { ViewSource } from '../../render/view';
import { generateMap } from '../../sim/map/generate';

export type MockHeroState = 'alive' | 'downed' | 'dead';

export const MOCK_NAMES = ['曹孟德', '孙仲谋', '玩家', '刘玄德', '周公瑾', '赵子龙', '吕奉先', '貂蝉'];

function heroIdAt(i: number): string {
  if (!HEROES.length) return 'guanyu';
  return HEROES[i % HEROES.length].id;
}

/** A spread of heroes (different kingdoms when the roster allows). */
export function mockHeroLineup(count: number, mine?: string): string[] {
  const out: string[] = [];
  const lord = LORD_CANDIDATE_IDS?.[0] ?? heroIdAt(0);
  out.push(lord);
  let i = 1;
  while (out.length < count) {
    const id = heroIdAt(i * 7 + 3);
    i++;
    if (!out.includes(id) || HEROES.length < count) out.push(id);
    if (i > 400) break;
  }
  if (mine) out[2 % count] = mine;
  return out;
}

// ── Mock ViewSource ──────────────────────────────────────────────────────────

export interface MockViewOptions {
  heroId?: string;
  role?: RoleId;
  state?: MockHeroState;
  playerCount?: number;
  seed?: number;
  myName?: string;
  /** generate periodic combat / feed events */
  lively?: boolean;
  /** start the clock here (seconds) */
  startElapsed?: number;
  /** stand outside the zone */
  outside?: boolean;
  /** override the primary weapon (preview crosshairs / scope) */
  weaponId?: string;
  /** keep aiming down sights */
  ads?: boolean;
}

export class MockView implements ViewSource {
  readonly map: MapData;
  private readonly rng: Rng;
  private t: number;
  private readonly t0: number;
  private readonly ents = new Map<EntityId, ViewEntity>();
  private readonly list: ViewEntity[] = [];
  private readonly events: GameEvent[] = [];
  private readonly me: PrivateHeroView;
  private readonly playerList: PublicPlayerView[] = [];
  private readonly zoneV: ZoneView;
  private readonly timers = { hit: 0.2, squad: 0.9, hurt: 2.5, kill: 5, ann: 9, claim: 6, quick: 4, chat: 11, heal: 7 };
  private killIdx = 0;
  private resultV: GameResult | null = null;
  private readonly heroIds: string[];
  private tick = 0;
  readonly myId: EntityId = 1;
  private readonly lively: boolean;
  lastInput: InputFrame | null = null;

  constructor(private readonly opts: MockViewOptions = {}) {
    this.rng = new Rng(opts.seed ?? 7);
    this.map = generateMap(defaultSettings().mapSeed);
    this.lively = opts.lively !== false;
    this.t0 = opts.startElapsed ?? 186;
    this.t = this.t0;
    const count = opts.playerCount ?? 8;
    const myHero = opts.heroId ?? heroIdAt(1);
    this.heroIds = mockHeroLineup(count, myHero);
    const myRole = opts.role ?? 'loyalist';
    const roles = ROLE_DISTRIBUTION.standard[(Math.min(8, Math.max(5, count)) as 5 | 6 | 7 | 8)][0].slice();
    // seat 2 is "you"
    const mySeat = 2 % count;
    const swapIdx = roles.indexOf(myRole);
    if (swapIdx >= 0 && swapIdx !== mySeat && myRole !== 'lord') [roles[swapIdx], roles[mySeat]] = [roles[mySeat], roles[swapIdx]];
    else roles[mySeat] = myRole;
    if (myRole === 'lord') {
      roles[0] = 'loyalist';
    }

    const center = { x: 12, z: 26 };
    for (let seat = 0; seat < count; seat++) {
      const id = seat === mySeat ? this.myId : 100 + seat;
      const heroId = this.heroIds[seat];
      const def = HERO_BY_ID[heroId];
      const role = roles[seat] as RoleId;
      const isLord = role === 'lord' || (seat === 0 && myRole !== 'lord');
      const ang = (seat / count) * Math.PI * 2;
      const dist = seat === mySeat ? 0 : 18 + seat * 7;
      const dead = seat === 5;
      const downedAlly = seat === 3;
      let flags = 0;
      if (isLord) flags |= VF_LORD | VF_REVEALED;
      if (dead) flags |= VF_DEAD | VF_REVEALED;
      if (downedAlly) flags |= VF_DOWNED;
      if (seat === 6) flags |= VF_MARKED;
      const ent: ViewEntity = {
        id,
        kind: 'hero',
        sub: heroId,
        x: seat === mySeat ? center.x : center.x + Math.cos(ang) * dist,
        y: 0,
        z: seat === mySeat ? center.z : center.z + Math.sin(ang) * dist,
        yaw: seat === mySeat ? 0.4 : ang,
        pitch: 0,
        speed: 0,
        hp: dead ? 0 : (def?.maxHp ?? 400) * 0.8,
        maxHp: (def?.maxHp ?? 400) + (isLord ? 100 : 0),
        shield: 0,
        flags,
        kingdom: def?.kingdom,
        weapon: def?.signatureWeapon,
        role: isLord ? 'lord' : dead ? role : seat === mySeat ? myRole : undefined,
        claim: seat === 4 ? 'loyalist' : seat === 7 ? 'rebel' : undefined,
        name: seat === mySeat ? opts.myName ?? MOCK_NAMES[2] : MOCK_NAMES[seat % MOCK_NAMES.length],
      };
      if (downedAlly) {
        // lying right next to you → revive prompt
        ent.x = center.x + 1.6;
        ent.z = center.z - 1.2;
      }
      this.add(ent);
      this.playerList.push({
        playerId: seat === mySeat ? 'local' : `bot-${seat}`,
        name: ent.name ?? '',
        isBot: seat !== mySeat && seat !== 4,
        seat,
        entityId: id,
        heroId,
        kingdom: def?.kingdom ?? 'qun',
        alive: !dead,
        downed: downedAlly,
        role: ent.role && (isLord || dead || seat === mySeat) ? (seat === mySeat ? undefined : ent.role) : undefined,
        claim: ent.claim,
        kills: [2, 0, 3, 1, 0, 1, 4, 0][seat % 8],
        ping: seat === 4 ? 48 : undefined,
      });
    }
    const myDef = HERO_BY_ID[myHero];
    // your squad
    const squad: { id: EntityId; hp: number; maxHp: number }[] = [];
    for (let i = 0; i < 4 + (myRole === 'lord' ? 2 : 0); i++) {
      const id = 200 + i;
      squad.push({ id, hp: 90 - i * 22, maxHp: 90 });
      this.add({ id, kind: 'troop', sub: myDef?.troopType ?? 'shu_rifleman', x: center.x - 3 - i * 1.5, y: 0, z: center.z + 3 + (i % 2) * 2, yaw: 0, pitch: 0, speed: 2, hp: 90 - i * 22, maxHp: 90, shield: 0, flags: 0, kingdom: myDef?.kingdom, owner: this.myId });
    }
    // loot next to you (a weapon that is not your current primary)
    const lootWeapon = WEAPONS.find((w) => w.lootable && w.id !== myDef?.signatureWeapon && w.class !== 'pistol') ?? WEAPONS[0];
    if (opts.state !== 'downed') {
      this.add({ id: 300, kind: 'loot', sub: lootWeapon?.id ?? 'pistol', x: center.x + 0.4, y: 0, z: center.z - 3.4, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: 0 });
    }
    this.add({ id: 301, kind: 'crate', sub: '2', x: center.x + 14, y: 0, z: center.z - 9, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: 0 });
    this.add({ id: 302, kind: 'airdrop', sub: '3', x: center.x + 60, y: 0, z: center.z - 70, yaw: 0, pitch: 0, speed: 0, hp: 1, maxHp: 1, shield: 0, flags: 0 });

    const primary = (opts.weaponId ? WEAPON_BY_ID[opts.weaponId] : undefined) ?? (myDef ? WEAPON_BY_ID[myDef.signatureWeapon] : undefined);
    const pistol = WEAPON_BY_ID.pistol;
    const items: (ItemStack | null)[] = [null, null, null, null];
    const pick = ['tao', 'jiu', 'wuzhong', 'guohe', 'shan', 'sha'].filter((id) => ITEM_BY_ID[id]);
    const pool = pick.length ? pick : ITEMS.slice(0, 3).map((i) => i.id);
    items[0] = pool[0] ? { id: pool[0], count: 2 } : null;
    items[1] = pool[1] ? { id: pool[1], count: 1 } : null;
    items[3] = pool[2] ? { id: pool[2], count: 1 } : null;
    const state = opts.state ?? 'alive';
    this.me = {
      entityId: this.myId,
      heroId: myHero,
      role: myRole,
      hp: state === 'dead' ? 0 : state === 'downed' ? 0 : 260,
      maxHp: (myDef?.maxHp ?? 400) + (myRole === 'lord' ? 100 : 0),
      shield: 0,
      weapons: [
        primary ? { id: primary.id, mag: primary.magSize, reserve: primary.magSize * 4 } : null,
        pistol ? { id: pistol.id, mag: pistol.magSize, reserve: pistol.magSize * 4 } : null,
      ],
      activeSlot: 0,
      items,
      armor: 'bagua',
      mount: 'chitu',
      cooldowns: {},
      charges: {},
      abilityState: {},
      dodgeCharges: 2,
      reloading: 0,
      channel: null,
      downed: state === 'downed',
      downedRemaining: state === 'downed' ? 8.4 : 0,
      dead: state === 'dead',
      statuses: [],
      squad,
      order: { kind: 'follow' },
      bountyTargetId: myRole === 'bounty' ? 106 : undefined,
      knownAllies: myRole === 'lord' ? [104] : undefined,
      stats: { kills: 3, damage: 1240, healing: 180, rescues: 1 },
    };
    const myEnt = this.ents.get(this.myId);
    if (myEnt) {
      myEnt.maxHp = this.me.maxHp;
      myEnt.hp = this.me.hp;
      if (state === 'dead') myEnt.flags |= VF_DEAD | VF_REVEALED;
      if (state === 'downed') myEnt.flags |= VF_DOWNED;
      if (opts.outside) {
        myEnt.x = 140;
        myEnt.z = -120;
      }
    }
    if (state === 'dead') {
      const p = this.playerList.find((x) => x.entityId === this.myId);
      if (p) {
        p.alive = false;
        p.role = myRole;
      }
    }
    this.zoneV = {
      phase: 2,
      center: { x: 20, y: 0, z: 10 },
      radius: 150,
      targetCenter: { x: 30, y: 0, z: 18 },
      targetRadius: 100,
      shrinkStart: this.t0 - 8,
      shrinkEnd: this.t0 + 37,
      dps: 8,
    };
    if (this.lively) this.seedEvents();
  }

  private add(e: ViewEntity): void {
    this.ents.set(e.id, e);
    this.list.push(e);
  }

  private seedEvents(): void {
    // a populated kill feed / chat for the first frame
    const k = (killer: EntityId | undefined, target: EntityId, role: RoleId): GameEvent => {
      const e = this.ents.get(target);
      return { t: 'death', target, killer, kind: 'hero', role, heroId: e?.sub, name: e?.name };
    };
    this.events.push(k(106, 105, 'rebel'));
    this.events.push({ t: 'claim', who: 104, role: 'loyalist' });
    this.events.push({ t: 'chat', from: MOCK_NAMES[4], text: '主公跟我走，西边安全！' });
    this.events.push({ t: 'quickchat', who: 107, id: 'focus' });
    this.events.push({ t: 'announce', zh: '烽火圈开始收缩！', en: 'The zone is closing in!', kind: 'warn' });
    this.events.push({ t: 'downed', target: 107, src: this.myId });
  }

  update(dt: number): void {
    this.t += dt;
    this.tick++;
    const t = this.t;
    const me = this.me;
    const def = HERO_BY_ID[me.heroId];
    const myEnt = this.ents.get(this.myId);
    const alive = !me.dead && !me.downed;
    // HP breathing, shield pulses, dodge / cooldown cycles
    if (alive) {
      me.hp = Math.round(Math.max(40, Math.min(me.maxHp, me.maxHp * 0.62 + Math.sin(t * 0.45) * me.maxHp * 0.25)));
      me.shield = Math.sin(t * 0.3) > 0.4 ? 80 : 0;
      me.dodgeCharges = Math.floor(t / 3) % 3 === 0 ? 1 : 2;
      for (const a of def?.abilities ?? []) {
        if (!a.cooldown) continue;
        const period = a.cooldown + 3;
        const phase = (t + a.id.length) % period;
        me.cooldowns[a.id] = phase < a.cooldown ? a.cooldown - phase : 0;
        if (a.charges && a.charges > 1) me.charges[a.id] = 1 + (Math.floor(t / 5) % a.charges);
      }
      // weapon: fire bursts, reload when empty
      const w = me.weapons[me.activeSlot];
      const wd = w ? WEAPON_BY_ID[w.id] : undefined;
      const firing = Math.sin(t * 1.3) > 0.2;
      if (w && wd) {
        if (me.reloading > 0) {
          me.reloading = Math.max(0, me.reloading - dt);
          if (me.reloading === 0) {
            const need = wd.magSize - w.mag;
            const take = Math.min(need, w.reserve);
            w.mag += take;
            w.reserve -= take;
            if (w.reserve <= 0) w.reserve = wd.magSize * 4;
          }
        } else if (firing) {
          this.fireAcc = (this.fireAcc ?? 0) + dt * Math.min(wd.fireRate, 8);
          while (this.fireAcc >= 1 && w.mag > 0) {
            this.fireAcc -= 1;
            w.mag--;
          }
          if (w.mag <= 0) me.reloading = wd.reloadTime;
        }
      }
      if (myEnt) {
        myEnt.flags = (myEnt.flags & ~(VF_FIRING | VF_ADS)) | (firing && me.reloading === 0 ? VF_FIRING : 0) | (this.opts.ads || Math.sin(t * 0.21) > 0.75 ? VF_ADS : 0);
        myEnt.speed = Math.sin(t * 0.5) > 0 ? 4 : 0;
        myEnt.hp = me.hp;
        myEnt.shield = me.shield;
        myEnt.yaw = 0.4 + Math.sin(t * 0.2) * 0.3;
      }
      // statuses
      const st: { id: StatusId; remaining: number }[] = [];
      const cyc = (period: number, dur: number, off: number): number => {
        const p = (t + off) % period;
        return p < dur ? dur - p : 0;
      };
      const haste = cyc(12, 5, 0);
      if (haste) st.push({ id: 'haste', remaining: haste });
      const boost = cyc(15, 8, 4);
      if (boost) st.push({ id: 'dmgBoost', remaining: boost });
      const burn = cyc(17, 3, 9);
      if (burn) st.push({ id: 'burn', remaining: burn });
      st.push({ id: 'nullify', remaining: 14.2 });
      me.statuses = st;
      // channel every 20 s
      const ch = (t % 20) / 2;
      me.channel = ch < 1 ? { kind: 'open', progress: ch } : null;
      // squad
      me.order = { kind: (['follow', 'hold', 'attack', 'charge'] as SquadOrderKind[])[Math.floor(t / 8) % 4] };
      me.squad.forEach((s, i) => {
        s.hp = Math.max(0, Math.round(s.maxHp * (0.55 + 0.45 * Math.sin(t * 0.4 + i))));
      });
    } else if (me.downed) {
      me.downedRemaining = Math.max(0, 12 - ((t - this.t0) % 12));
    }
    // other heroes wander a little
    for (const e of this.list) {
      if (e.kind !== 'hero' || e.id === this.myId || e.flags & (VF_DEAD | VF_DOWNED)) continue;
      e.x += Math.cos(t * 0.3 + e.id) * dt * 1.5;
      e.z += Math.sin(t * 0.25 + e.id) * dt * 1.5;
      e.yaw += dt * 0.2;
    }
    // zone keeps shrinking in a loop
    const z = this.zoneV;
    const span = z.shrinkEnd - z.shrinkStart;
    const k = Math.max(0, Math.min(1, (t - z.shrinkStart) / span));
    z.radius = 150 + (z.targetRadius - 150) * k;
    if (t > z.shrinkEnd + 20) {
      z.shrinkStart = t + 25;
      z.shrinkEnd = t + 25 + span;
      z.radius = 150;
    }
    if (this.lively) this.generateEvents(dt);
  }

  private fireAcc = 0;

  private generateEvents(dt: number): void {
    const tm = this.timers;
    const r = this.rng;
    for (const key of Object.keys(tm) as (keyof typeof tm)[]) tm[key] -= dt;
    const enemy = this.ents.get(106) ?? this.list[0];
    const me = this.me;
    if (!me.dead && !me.downed && tm.hit <= 0) {
      tm.hit = r.range(0.35, 0.8);
      const head = r.chance(0.2);
      const blocked = r.chance(0.08) ? 'dodge' : undefined;
      this.events.push({ t: 'hit', target: enemy.id, src: this.myId, amount: blocked ? 0 : Math.round(r.range(22, 38) * (head ? 1.6 : 1)), dtype: 'normal', pos: { x: enemy.x, y: 1.5, z: enemy.z }, head, blocked });
    }
    if (tm.squad <= 0) {
      tm.squad = r.range(0.8, 1.6);
      this.events.push({ t: 'hit', target: enemy.id, src: 200, amount: Math.round(r.range(8, 14)), dtype: 'normal', pos: { x: enemy.x, y: 1.2, z: enemy.z } });
    }
    if (tm.hurt <= 0) {
      tm.hurt = r.range(2.5, 4.5);
      this.events.push({ t: 'hit', target: this.myId, src: r.chance(0.5) ? 106 : 107, amount: 18, dtype: 'normal', pos: { x: 0, y: 1, z: 0 } });
    }
    if (tm.heal <= 0) {
      tm.heal = 9;
      this.events.push({ t: 'heal', target: this.myId, amount: 40 });
    }
    if (tm.kill <= 0) {
      tm.kill = r.range(6, 9);
      const victims = [107, 103, 104, 106];
      const killers = [this.myId, 100, 106, 101];
      const i = this.killIdx++ % victims.length;
      const v = this.ents.get(victims[i]);
      const roles: RoleId[] = ['rebel', 'traitor', 'loyalist', 'rebel'];
      if (v) this.events.push({ t: 'death', target: v.id, killer: killers[i], kind: 'hero', role: roles[i], heroId: v.sub, name: v.name });
    }
    if (tm.ann <= 0) {
      tm.ann = 16;
      this.events.push(r.chance(0.5) ? { t: 'airdrop', pos: { x: -40, y: 0, z: 60 }, id: 400 + this.tick } : { t: 'announce', zh: '主公发动了「护驾」！', en: 'The Lord called for guards!', kind: 'big' });
    }
    if (tm.claim <= 0) {
      tm.claim = r.range(10, 14);
      this.events.push({ t: 'claim', who: 107, role: r.chance(0.5) ? 'loyalist' : 'rebel' });
    }
    if (tm.quick <= 0) {
      tm.quick = r.range(7, 10);
      this.events.push({ t: 'quickchat', who: 104, id: r.pick(['protectLord', 'needPeach', 'followMe', 'focus']) });
    }
    if (tm.chat <= 0) {
      tm.chat = r.range(12, 16);
      this.events.push({ t: 'chat', from: MOCK_NAMES[6], text: r.pick(['谁是内奸？', '别打我，我是忠臣！', 'gg', '桃给我一个']) });
    }
  }

  entities(): readonly ViewEntity[] {
    return this.list;
  }
  get(id: EntityId): ViewEntity | undefined {
    return this.ents.get(id);
  }
  localId(): EntityId | null {
    return this.myId;
  }
  local(): PrivateHeroView | null {
    return this.me;
  }
  zone(): ZoneView {
    return this.zoneV;
  }
  players(): readonly PublicPlayerView[] {
    return this.playerList;
  }
  drainEvents(): GameEvent[] {
    return this.events.splice(0, this.events.length);
  }
  viewTick(): number {
    return this.tick;
  }
  elapsed(): number {
    return this.t;
  }
  result(): GameResult | null {
    return this.resultV;
  }
  pushInput(frame: InputFrame): void {
    this.lastInput = frame;
  }
  setResult(r: GameResult | null): void {
    this.resultV = r;
  }
  /** Push an event (harness buttons / tests). */
  emit(ev: GameEvent): void {
    this.events.push(ev);
  }
}

// ── Mock GameSession ─────────────────────────────────────────────────────────

export interface MockSessionOptions {
  name?: string;
  isHost?: boolean;
  online?: boolean;
  /** advance phases automatically after start() */
  auto?: boolean;
  role?: RoleId;
  state?: MockHeroState;
  freePick?: boolean;
  /** you are the lord (seat 0) */
  asLord?: boolean;
  /** passed through to the MockView */
  view?: Pick<MockViewOptions, 'weaponId' | 'ads' | 'outside'>;
  roomCode?: string;
}

type Listener = (payload: never) => void;

export class MockSession implements GameSession {
  readonly isHost: boolean;
  readonly myId: PlayerId = 'local';
  phase: MatchPhase = 'lobby';
  lobby: LobbyState | null;
  roles: RoleDealView | null = null;
  heroSelect: HeroSelectView | null = null;
  view: MockView | null = null;
  result: GameResult | null = null;
  readonly calls: string[] = [];
  private readonly listeners = new Map<SessionEvent, Set<Listener>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private left = false;
  private readonly opts: MockSessionOptions;
  private botN = 0;

  constructor(opts: MockSessionOptions = {}) {
    this.opts = opts;
    this.isHost = opts.isHost !== false;
    const settings: MatchSettings = { ...defaultSettings(), playerCount: 8, freePick: !!opts.freePick };
    const mySeat = opts.asLord ? 0 : 2;
    const seats: LobbySeat[] = [];
    const humans = opts.online ? [0, mySeat, 4].filter((v, i, a) => a.indexOf(v) === i) : [mySeat];
    for (let s = 0; s < (opts.online ? 6 : settings.playerCount); s++) {
      const human = humans.includes(s);
      seats.push({
        seat: s,
        playerId: s === mySeat ? this.myId : human ? `peer-${s}` : `bot-${s}`,
        name: s === mySeat ? opts.name ?? MOCK_NAMES[2] : human ? MOCK_NAMES[s] : `AI·${MOCK_NAMES[s]}`,
        isBot: !human,
        isHost: opts.online ? (this.isHost ? s === mySeat : s === 0) : s === mySeat,
        ready: human && s !== 4 && s !== mySeat,
      });
    }
    this.lobby = { roomCode: opts.online ? opts.roomCode ?? 'KX7QD' : '', hostId: this.isHost ? this.myId : 'peer-0', settings, seats };
  }

  on<K extends SessionEvent>(ev: K, cb: (payload: SessionEventMap[K]) => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) {
      set = new Set();
      this.listeners.set(ev, set);
    }
    set.add(cb as Listener);
    return () => set?.delete(cb as Listener);
  }

  private emit<K extends SessionEvent>(ev: K, payload: SessionEventMap[K]): void {
    for (const cb of [...(this.listeners.get(ev) ?? [])]) (cb as (p: SessionEventMap[K]) => void)(payload);
  }

  private later(ms: number, fn: () => void): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.left) fn();
    }, ms);
    this.timers.add(id);
  }

  private setPhase(p: MatchPhase): void {
    this.phase = p;
    this.emit('phase', p);
  }

  private mySeat(): number {
    return this.lobby?.seats.find((s) => s.playerId === this.myId)?.seat ?? 2;
  }

  private emitLobby(): void {
    if (this.lobby) this.emit('lobby', { ...this.lobby, seats: this.lobby.seats.map((s) => ({ ...s })) });
  }

  // everyone
  setName(name: string): void {
    this.calls.push(`setName:${name}`);
    const s = this.lobby?.seats.find((x) => x.playerId === this.myId);
    if (s) s.name = name;
    this.emitLobby();
  }
  setReady(ready: boolean): void {
    this.calls.push(`setReady:${ready}`);
    const s = this.lobby?.seats.find((x) => x.playerId === this.myId);
    if (s) s.ready = ready;
    this.emitLobby();
  }
  pickHero(heroId: string): void {
    this.calls.push(`pickHero:${heroId}`);
    const v = this.heroSelect;
    if (!v) return;
    this.heroSelect = { ...v, picks: { ...v.picks, [this.mySeat()]: heroId } };
    this.emit('heroSelect', this.heroSelect);
    if (!this.opts.auto) return;
    if (v.lordPhase) this.later(900, () => this.othersPhase());
    else this.later(1200, () => this.finishSelect());
  }
  sendChat(text: string): void {
    this.calls.push(`chat:${text}`);
    const me = this.lobby?.seats.find((x) => x.playerId === this.myId);
    this.emit('chat', { from: me?.name ?? '你', text });
    if (this.phase === 'lobby') this.later(900, () => this.emit('chat', { from: MOCK_NAMES[4], text: '收到！' }));
  }
  leave(): void {
    this.calls.push('leave');
    this.left = true;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  // host only
  updateSettings(patch: Partial<MatchSettings>): void {
    this.calls.push(`updateSettings:${JSON.stringify(patch)}`);
    if (!this.lobby) return;
    this.lobby = { ...this.lobby, settings: { ...this.lobby.settings, ...patch } };
    this.emitLobby();
  }
  addBot(): void {
    this.calls.push('addBot');
    if (!this.lobby) return;
    const used = new Set(this.lobby.seats.map((s) => s.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    this.botN++;
    this.lobby.seats.push({ seat, playerId: `bot-x${this.botN}`, name: `AI·${MOCK_NAMES[seat % MOCK_NAMES.length]}`, isBot: true, isHost: false, ready: true });
    this.emitLobby();
  }
  removeBot(seat: number): void {
    this.calls.push(`removeBot:${seat}`);
    if (!this.lobby) return;
    this.lobby.seats = this.lobby.seats.filter((s) => !(s.seat === seat && s.isBot));
    this.emitLobby();
  }
  kick(seat: number): void {
    this.calls.push(`kick:${seat}`);
    if (!this.lobby) return;
    this.lobby.seats = this.lobby.seats.filter((s) => s.seat !== seat);
    this.emitLobby();
  }
  start(): void {
    this.calls.push('start');
    if (!this.lobby) return;
    // fill empty seats with bots up to the player count
    const count = this.lobby.settings.playerCount;
    const used = new Set(this.lobby.seats.map((s) => s.seat));
    for (let s = 0; s < count; s++) {
      if (!used.has(s)) this.lobby.seats.push({ seat: s, playerId: `bot-${s}`, name: `AI·${MOCK_NAMES[s % MOCK_NAMES.length]}`, isBot: true, isHost: false, ready: true });
    }
    this.lobby.seats = this.lobby.seats.filter((s) => s.seat < count || !s.isBot).sort((a, b) => a.seat - b.seat);
    this.dealRoles();
    if (this.opts.auto) this.later(3600, () => this.lordPhase());
  }
  returnToLobby(): void {
    this.calls.push('returnToLobby');
    this.view = null;
    this.result = null;
    this.roles = null;
    this.heroSelect = null;
    this.setPhase('lobby');
    this.emitLobby();
  }

  // ── flow ──
  private dealRoles(): void {
    const lobby = this.lobby;
    if (!lobby) return;
    const count = lobby.settings.playerCount;
    const mode = lobby.settings.mode;
    const dist = ROLE_DISTRIBUTION[mode][count][0];
    const mine = this.mySeat();
    const yourRole: RoleId = this.opts.role ?? (mine === 0 ? 'lord' : dist[mine] ?? 'loyalist');
    const publicRoles: Record<number, RoleId> = { 0: 'lord' };
    const dbl = dist.indexOf('double');
    if (dbl > 0) publicRoles[dbl] = 'double';
    this.roles = { yourRole, publicRoles, bountySeat: yourRole === 'bounty' ? 5 : undefined };
    this.emit('roles', this.roles);
    this.setPhase('roles');
  }

  private lordPhase(): void {
    const lordIds = (LORD_CANDIDATE_IDS?.length ? LORD_CANDIDATE_IDS : HEROES.slice(0, 5).map((h) => h.id)).slice(0, 5);
    const extra = HEROES.map((h) => h.id).filter((id) => !lordIds.includes(id)).slice(0, 3);
    const iAmLord = this.mySeat() === 0;
    this.heroSelect = { options: iAmLord ? [...lordIds, ...extra] : [], deadline: 15, picks: {}, lordSeat: 0, lordPhase: true };
    this.emit('heroSelect', this.heroSelect);
    this.setPhase('heroSelect');
    if (!iAmLord && this.opts.auto) this.later(2500, () => {
      if (!this.heroSelect) return;
      this.heroSelect = { ...this.heroSelect, picks: { 0: lordIds[0] ?? heroIdAt(0) } };
      this.emit('heroSelect', this.heroSelect);
      this.later(1200, () => this.othersPhase());
    });
  }

  /** everyone else picks (exposed for the harness) */
  othersPhase(): void {
    const prev = this.heroSelect;
    const lordPick = prev?.picks[0] ?? LORD_CANDIDATE_IDS?.[0] ?? heroIdAt(0);
    const all = HEROES.map((h) => h.id).filter((id) => id !== lordPick);
    const free = !!this.lobby?.settings.freePick;
    const offset = 5;
    const options = free ? all : all.slice(offset, offset + 3).length ? all.slice(offset, offset + 3) : all.slice(0, 3);
    const picks: Record<number, string> = { ...(prev?.picks ?? {}), 0: lordPick };
    this.heroSelect = { options, deadline: 20, picks, lordSeat: 0, lordPhase: false };
    this.emit('heroSelect', this.heroSelect);
    if (this.phase !== 'heroSelect') this.setPhase('heroSelect');
    if (!this.opts.auto) return;
    // bots pick one by one
    const seats = this.lobby?.seats.filter((s) => s.seat !== 0 && s.playerId !== this.myId) ?? [];
    seats.forEach((s, i) => {
      this.later(700 + i * 450, () => {
        if (!this.heroSelect || this.heroSelect.lordPhase) return;
        const taken = new Set(Object.values(this.heroSelect.picks));
        // bots leave your offered heroes alone (unless everything is on offer)
        const pool = free ? [...all].reverse() : all.filter((id) => !options.includes(id));
        const hero = pool.find((id) => !taken.has(id)) ?? all[i % all.length];
        this.heroSelect = { ...this.heroSelect, picks: { ...this.heroSelect.picks, [s.seat]: hero } };
        this.emit('heroSelect', this.heroSelect);
      });
    });
  }

  private finishSelect(): void {
    this.setPhase('loading');
    this.later(1600, () => this.startMatch());
  }

  private startMatch(): void {
    const mine = this.mySeat();
    const hero = this.heroSelect?.picks[mine] ?? heroIdAt(1);
    this.view = new MockView({
      heroId: hero,
      role: this.roles?.yourRole ?? 'loyalist',
      state: this.opts.state,
      myName: this.lobby?.seats.find((s) => s.seat === mine)?.name,
      playerCount: this.lobby?.settings.playerCount ?? 8,
      ...this.opts.view,
    });
    this.emit('matchStart', this.view);
    this.setPhase('playing');
  }

  /** Harness: jump straight into a phase with fake data (no auto-advance). */
  jumpTo(phase: MatchPhase, extra: { lordPhase?: boolean } = {}): void {
    switch (phase) {
      case 'lobby':
        this.setPhase('lobby');
        this.emitLobby();
        break;
      case 'roles':
        this.dealRoles();
        break;
      case 'heroSelect':
        this.dealRoles();
        if (extra.lordPhase) this.lordPhase();
        else this.othersPhase();
        break;
      case 'loading':
        this.dealRoles();
        this.othersPhase();
        if (this.heroSelect) this.heroSelect.picks[this.mySeat()] = this.heroSelect.options[0];
        this.setPhase('loading');
        break;
      case 'playing':
        this.dealRoles();
        this.othersPhase();
        if (this.heroSelect) this.heroSelect.picks[this.mySeat()] = this.heroSelect.options[0] ?? heroIdAt(1);
        this.startMatch();
        break;
      case 'gameOver':
        this.jumpTo('playing');
        this.finish();
        break;
    }
  }

  /** Harness: end the match with a fake result. */
  finish(winner: GameResult['winner'] = 'lord'): void {
    const view = this.view;
    const roles: Record<EntityId, RoleId> = {};
    const lordSide = new Set<RoleId>(['lord', 'loyalist', 'double']);
    const winners: EntityId[] = [];
    const order: RoleId[] = ['lord', 'rebel', this.roles?.yourRole ?? 'loyalist', 'loyalist', 'rebel', 'rebel', 'traitor', 'rebel'];
    (view?.players() ?? []).forEach((p, i) => {
      const r = order[i % order.length];
      roles[p.entityId] = r;
      if ((winner === 'lord' && lordSide.has(r)) || (winner === 'rebel' && r === 'rebel') || (winner === 'traitor' && r === 'traitor')) winners.push(p.entityId);
    });
    this.result = {
      winner,
      winners,
      roles,
      mvp: view?.players()[0]?.entityId,
      reasonZh: winner === 'lord' ? '反贼与内奸已全部伏诛，主公平定天下！' : winner === 'rebel' ? '主公阵亡，反贼推翻了朝廷！' : '内奸笑到了最后。',
      reasonEn: winner === 'lord' ? 'Every Rebel and the Traitor has fallen — the Lord unites the realm!' : winner === 'rebel' ? 'The Lord has fallen — the Rebels overthrow the court!' : 'The Traitor stands alone at the end.',
      durationSec: 548,
    };
    view?.setResult(this.result);
    this.emit('gameOver', this.result);
    this.setPhase('gameOver');
  }

  /** Harness: emit an error event. */
  fail(code: string, zh: string, en: string): void {
    this.emit('error', { code, zh, en });
  }

  /** Harness: emit a status line. */
  status(zh: string, en: string): void {
    this.emit('status', { zh, en });
  }
}
