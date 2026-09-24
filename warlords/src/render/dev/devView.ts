// Dev-only ViewSource: a synthetic battlefield for the renderer harness.
// Every hero visual lined up (cycling animation states), every troop type,
// a mounted hero, projectiles, loot / crates / airdrop / turret, hazards, a
// shrinking zone and periodic synthetic GameEvents. The local hero is driven
// by pushInput() with simple kinematics so the TPS camera can be tested.
import type { MapData } from '../../core/map';
import { terrainHeight } from '../../core/map';
import { forwardFromYaw, rightFromYaw, type Vec3 } from '../../core/math';
import type {
  EntityId,
  GameEvent,
  GameResult,
  InputFrame,
  PrivateHeroView,
  PublicPlayerView,
  ViewEntity,
  ZoneView,
} from '../../core/types';
import {
  BTN_ADS,
  BTN_FIRE,
  BTN_SPRINT,
  VF_ADS,
  VF_AIRBORNE,
  VF_BOOSTED,
  VF_BURNING,
  VF_CHANNELING,
  VF_CHARMED,
  VF_DANCING,
  VF_DEAD,
  VF_DODGING,
  VF_DOWNED,
  VF_EXPOSED,
  VF_FIRING,
  VF_FROZEN,
  VF_HASTE,
  VF_INVULN,
  VF_LORD,
  VF_MARKED,
  VF_MOUNTED,
  VF_OPENED,
  VF_RELOADING,
  VF_ROOTED,
  VF_SHIELDED,
  VF_SLOWED,
  VF_SPRINTING,
  VF_STEALTH,
  VF_STUNNED,
} from '../../core/types';
import { HEROES, TROOPS, WEAPONS, ITEMS, ARMORS, MOUNTS, HERO_BY_ID, WEAPON_BY_ID } from '../../data';
import type { ViewSource } from '../view';
import { makeRand } from '../core/noise';

interface Actor {
  e: ViewEntity;
  home: Vec3;
  mode: 'idle' | 'walk' | 'circle' | 'state';
  stateFlags: number;
  phase: number;
}

const DEMO_FLAGS = [
  0,
  VF_ADS,
  VF_RELOADING,
  VF_SPRINTING,
  VF_DANCING,
  VF_STUNNED,
  VF_DOWNED,
  VF_DEAD,
  VF_FIRING | VF_ADS,
  VF_SHIELDED,
  VF_INVULN,
  VF_BURNING,
  VF_FROZEN,
  VF_CHARMED,
  VF_BOOSTED,
  VF_MARKED,
  VF_CHANNELING,
  VF_HASTE,
  VF_SLOWED,
  VF_ROOTED,
  VF_EXPOSED,
  VF_STEALTH,
];

export interface DevViewOptions {
  heroId: string;
  map: MapData;
  /** lineup origin (world x/z), facing −Z towards the lineup */
  origin: { x: number; z: number };
  seed?: number;
}

export class DevView implements ViewSource {
  readonly map: MapData;
  private readonly actors: Actor[] = [];
  private readonly byId = new Map<EntityId, ViewEntity>();
  private list: ViewEntity[] = [];
  private events: GameEvent[] = [];
  private t = 0;
  private tick = 0;
  private nextId = 1;
  private readonly rand: () => number;
  private readonly localEnt: ViewEntity;
  private privateView: PrivateHeroView;
  private input: InputFrame | null = null;
  private readonly origin: { x: number; z: number };
  private shotTimer = 0;
  private boomTimer = 1;
  private abilityTimer = 0.5;
  private projTimer = 0;
  private statusTimer = 2;
  private projectiles: { e: ViewEntity; vel: Vec3; life: number; kind: string }[] = [];
  private airdrop: ViewEntity | null = null;
  private airdropT = 0;
  private crateOpen: ViewEntity | null = null;
  private zoneV: ZoneView;
  private vy = 0;
  private fireCd = 0;
  readonly heroIds: string[];

  constructor(opts: DevViewOptions) {
    this.map = opts.map;
    this.origin = opts.origin;
    this.rand = makeRand(opts.seed ?? 7);
    this.heroIds = HEROES.map((h) => h.id);
    const ox = opts.origin.x;
    const oz = opts.origin.z;
    // local hero
    const lh = HERO_BY_ID[opts.heroId] ? opts.heroId : (HEROES[0]?.id ?? 'guanyu');
    this.localEnt = this.makeHero(lh, ox, oz + 14, Math.PI * 0);
    this.localEnt.name = '你';
    this.localEnt.role = 'lord';
    this.localEnt.flags |= VF_LORD;
    // hero lineup: rows of 10 facing +Z (towards the local hero)
    HEROES.forEach((h, i) => {
      const row = Math.floor(i / 10);
      const col = i % 10;
      const x = ox + (col - 4.5) * 2.6;
      const z = oz - row * 4.5;
      const e = this.makeHero(h.id, x, z, Math.PI);
      e.name = `Bot${i + 1}`;
      if (i % 7 === 3) e.claim = 'loyalist';
      if (i % 11 === 5) e.role = 'rebel';
      const flags = DEMO_FLAGS[i % DEMO_FLAGS.length];
      this.actors.push({ e, home: { x, y: e.y, z }, mode: i % 6 === 2 ? 'walk' : 'state', stateFlags: flags, phase: i * 0.7 });
    });
    // mounted hero riding a circle + walking heroes circle
    const rider = this.makeHero(HERO_BY_ID.machao ? 'machao' : lh, ox + 18, oz + 4, 0);
    rider.flags |= VF_MOUNTED;
    rider.mount = MOUNTS[0]?.id;
    this.actors.push({ e: rider, home: { x: ox + 18, y: rider.y, z: oz + 4 }, mode: 'circle', stateFlags: VF_MOUNTED, phase: 0 });
    // troops lineup (left side)
    TROOPS.forEach((t, i) => {
      const x = ox - 20 - (i % 4) * 2.4;
      const z = oz + 6 - Math.floor(i / 4) * 3.2;
      const e = this.makeEntity('troop', t.id, x, z, Math.PI / 2);
      e.kingdom = t.kingdom === 'neutral' ? undefined : t.kingdom;
      e.weapon = t.weapon;
      e.maxHp = t.hp;
      e.hp = i % 3 === 0 ? t.hp * 0.45 : t.hp;
      if (t.visual.mountedOn) e.flags |= VF_MOUNTED;
      this.actors.push({ e, home: { x, y: e.y, z }, mode: i % 3 === 1 ? 'walk' : 'idle', stateFlags: 0, phase: i });
    });
    // local squad (troops following the local hero)
    const squadIds: EntityId[] = [];
    const squadType = TROOPS.find((t) => t.kingdom === this.localEnt.kingdom)?.id ?? TROOPS[0]?.id;
    for (let i = 0; i < 3 && squadType; i++) {
      const e = this.makeEntity('troop', squadType, ox + (i - 1) * 1.5, oz + 17, 0);
      e.kingdom = this.localEnt.kingdom;
      e.owner = this.localEnt.id;
      e.weapon = TROOPS.find((t) => t.id === squadType)?.weapon;
      e.hp = i === 0 ? e.maxHp * 0.6 : e.maxHp;
      squadIds.push(e.id);
      this.actors.push({ e, home: { x: ox + (i - 1) * 1.5, y: e.y, z: oz + 17 }, mode: 'idle', stateFlags: 0, phase: i });
    }
    // loot row (right side): weapons + items + armor + mounts
    const lootIds = [...WEAPONS.filter((w) => w.lootable).map((w) => w.id).slice(0, 8), ...ITEMS.slice(0, 6).map((i) => i.id), ...ARMORS.slice(0, 2).map((a) => a.id), ...MOUNTS.slice(0, 2).map((m) => m.id)];
    lootIds.forEach((id, i) => this.makeEntity('loot', id, ox + 16 + (i % 6) * 1.6, oz + 12 - Math.floor(i / 6) * 1.8, 0));
    // crates (tier 1..3 + one that toggles open)
    [1, 2, 3].forEach((tier, i) => this.makeEntity('crate', String(tier), ox + 16 + i * 2.2, oz + 18, 0.3));
    this.crateOpen = this.makeEntity('crate', '2', ox + 22.6, oz + 18, -0.3);
    // turret
    const tur = this.makeEntity('turret', 'muniu', ox - 8, oz + 12, 0);
    tur.kingdom = 'shu';
    tur.weapon = WEAPON_BY_ID.turret_smg ? 'turret_smg' : 'smg';
    // hazards
    const hz: [string, number, number, number][] = [
      ['fire', ox - 12, oz - 16, 3.5],
      ['lightningCloud', ox + 4, oz - 18, 4],
      ['trapDance', ox - 4, oz + 20, 1.6],
      ['healZone', ox + 10, oz + 22, 3],
      ['frost', ox - 16, oz + 22, 3],
      ['smoke', ox + 28, oz - 6, 4],
      ['arrowRain', ox + 26, oz + 8, 3.5],
      ['bazhen', ox - 26, oz - 12, 5],
    ];
    for (const [k, x, z, r] of hz) {
      const e = this.makeEntity('hazard', k, x, z, 0);
      e.radius = r;
      e.kingdom = 'shu';
    }
    // zone centred on the lineup
    this.zoneV = {
      phase: 1,
      center: { x: ox, y: 0, z: oz },
      radius: 60,
      targetCenter: { x: ox + 6, y: 0, z: oz - 4 },
      targetRadius: 30,
      shrinkStart: 0,
      shrinkEnd: 60,
      dps: 4,
    };
    const sig = HERO_BY_ID[lh]?.signatureWeapon ?? 'carbine';
    const sigDef = WEAPON_BY_ID[sig];
    this.privateView = {
      entityId: this.localEnt.id,
      heroId: lh,
      role: 'lord',
      hp: this.localEnt.hp,
      maxHp: this.localEnt.maxHp,
      shield: 0,
      weapons: [
        { id: sig, mag: sigDef?.magSize ?? 30, reserve: 120 },
        { id: 'pistol', mag: 12, reserve: 48 },
      ],
      activeSlot: 0,
      items: [null, null, null, null],
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
      dead: false,
      statuses: [],
      squad: squadIds.map((id) => ({ id, hp: 100, maxHp: 100 })),
      order: { kind: 'follow' },
      stats: { kills: 0, damage: 0, healing: 0, rescues: 0 },
    };
    this.rebuildList();
  }

  // ── construction helpers ─────────────────────────────────────────────────
  private ground(x: number, z: number): number {
    return Math.max(terrainHeight(this.map, x, z), this.map.waterLevel - 0.6);
  }

  private makeEntity(kind: ViewEntity['kind'], sub: string, x: number, z: number, yaw: number): ViewEntity {
    const e: ViewEntity = {
      id: this.nextId++,
      kind,
      sub,
      x,
      y: this.ground(x, z),
      z,
      yaw,
      pitch: 0,
      speed: 0,
      hp: 100,
      maxHp: 100,
      shield: 0,
      flags: 0,
    };
    this.byId.set(e.id, e);
    return e;
  }

  private makeHero(heroId: string, x: number, z: number, yaw: number): ViewEntity {
    const def = HERO_BY_ID[heroId];
    const e = this.makeEntity('hero', heroId, x, z, yaw);
    e.kingdom = def?.kingdom ?? 'qun';
    e.maxHp = def?.maxHp ?? 400;
    e.hp = e.maxHp * (0.4 + ((e.id * 37) % 60) / 100);
    e.weapon = def?.signatureWeapon ?? 'carbine';
    if (def?.lordCandidate && e.id % 2 === 0) e.flags |= VF_LORD;
    return e;
  }

  private rebuildList(): void {
    this.list = [...this.byId.values()];
  }

  // ── ViewSource ───────────────────────────────────────────────────────────
  update(dt: number): void {
    const d = Math.min(0.1, dt);
    this.t += d;
    this.tick = Math.floor(this.t * 30);
    this.updateLocal(d);
    this.updateActors(d);
    this.updateProjectiles(d);
    this.updateAirdrop(d);
    this.updateEvents(d);
    this.updateZone();
    if (this.crateOpen) {
      const open = Math.floor(this.t / 4) % 2 === 1;
      this.crateOpen.flags = open ? VF_OPENED : 0;
    }
  }

  entities(): readonly ViewEntity[] {
    return this.list;
  }
  get(id: EntityId): ViewEntity | undefined {
    return this.byId.get(id);
  }
  localId(): EntityId | null {
    return this.localEnt.id;
  }
  local(): PrivateHeroView | null {
    return this.privateView;
  }
  zone(): ZoneView {
    return this.zoneV;
  }
  players(): readonly PublicPlayerView[] {
    return [];
  }
  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
  viewTick(): number {
    return this.tick;
  }
  elapsed(): number {
    return this.t;
  }
  result(): GameResult | null {
    return null;
  }
  pushInput(frame: InputFrame): void {
    this.input = frame;
  }

  /** Hero ids in lineup order (for the spectate test). */
  actorIds(): EntityId[] {
    return this.actors.map((a) => a.e.id);
  }

  // ── simulation ───────────────────────────────────────────────────────────
  private updateLocal(dt: number): void {
    const e = this.localEnt;
    const f = this.input;
    if (!f) {
      e.speed = 0;
      return;
    }
    e.yaw = f.yaw;
    e.pitch = f.pitch;
    const sprint = (f.buttons & BTN_SPRINT) !== 0 && f.moveZ > 0.1;
    const ads = (f.buttons & BTN_ADS) !== 0;
    const speed = (sprint ? 7.2 : ads ? 3 : 5) * Math.min(1, Math.hypot(f.moveX, f.moveZ));
    const fw = forwardFromYaw(f.yaw);
    const rt = rightFromYaw(f.yaw);
    const len = Math.hypot(f.moveX, f.moveZ) || 1;
    const vx = ((fw.x * f.moveZ + rt.x * f.moveX) / len) * speed;
    const vz = ((fw.z * f.moveZ + rt.z * f.moveX) / len) * speed;
    e.x += vx * dt;
    e.z += vz * dt;
    const g = this.ground(e.x, e.z);
    for (const a of f.actions) {
      if (a.a === 'jump' && e.y <= g + 0.01) this.vy = 5.5;
      if (a.a === 'dodge') e.flags |= VF_DODGING;
      if (a.a === 'reload') this.privateView.reloading = 1.6;
      if (a.a === 'weapon') this.privateView.activeSlot = a.slot;
      if (a.a === 'ability') this.events.push({ t: 'ability', src: e.id, ability: `${e.sub}_${a.slot}`, pos: f.aimPoint, dir: fw });
    }
    this.vy -= 18 * dt;
    e.y = Math.max(g, e.y + this.vy * dt);
    if (e.y <= g) this.vy = 0;
    e.speed = Math.hypot(vx, vz);
    let flags = e.flags & (VF_LORD | VF_DODGING);
    if (this.t % 3 < dt * 1.5) flags &= ~VF_DODGING;
    if (ads) flags |= VF_ADS;
    if (sprint) flags |= VF_SPRINTING;
    if (e.y > g + 0.05) flags |= VF_AIRBORNE;
    if ((f.buttons & BTN_FIRE) !== 0) flags |= VF_FIRING;
    // reload / mag simulation for local fire feedback
    const pv = this.privateView;
    if (pv.reloading > 0) {
      pv.reloading = Math.max(0, pv.reloading - dt);
      flags |= VF_RELOADING;
      if (pv.reloading === 0) {
        const w = pv.weapons[pv.activeSlot];
        if (w) w.mag = WEAPON_BY_ID[w.id]?.magSize ?? 30;
      }
    }
    const w = pv.weapons[pv.activeSlot];
    this.fireCd = Math.max(0, this.fireCd - dt);
    if (w && (f.buttons & BTN_FIRE) && pv.reloading === 0 && w.mag > 0 && this.fireCd === 0) {
      const def = WEAPON_BY_ID[w.id];
      this.fireCd = 1 / (def?.fireRate ?? 8);
      w.mag--;
      const from = { x: e.x, y: e.y + 1.45, z: e.z };
      const to = f.aimPoint ?? { x: from.x + fw.x * 50, y: from.y, z: from.z + fw.z * 50 };
      this.events.push({ t: 'shot', src: e.id, weapon: w.id, from, to, hit: f.aimTargetId });
      if (f.aimTargetId !== undefined) this.events.push({ t: 'hit', target: f.aimTargetId, src: e.id, amount: def?.damage ?? 25, dtype: 'normal', pos: to });
      if (w.mag === 0) pv.reloading = def?.reloadTime ?? 2;
    }
    e.weapon = pv.weapons[pv.activeSlot]?.id;
    // clear dodge after its duration
    if (flags & VF_DODGING) {
      const since = (e as ViewEntity & { _dodge?: number })._dodge ?? this.t;
      (e as ViewEntity & { _dodge?: number })._dodge = since;
      if (this.t - since > 0.5) {
        flags &= ~VF_DODGING;
        (e as ViewEntity & { _dodge?: number })._dodge = undefined;
      }
    }
    e.flags = flags;
    // squad follows in a wedge
    let k = 0;
    for (const s of pv.squad) {
      const t = this.byId.get(s.id);
      if (!t) continue;
      const off = rightFromYaw(e.yaw);
      const side = (k % 2 === 0 ? 1 : -1) * (1 + Math.floor(k / 2));
      const tx = e.x - fw.x * 2.5 + off.x * side * 1.6;
      const tz = e.z - fw.z * 2.5 + off.z * side * 1.6;
      const dx = tx - t.x;
      const dz = tz - t.z;
      const dist = Math.hypot(dx, dz);
      const sp = Math.min(6, dist * 2.2);
      if (dist > 0.05) {
        t.x += (dx / dist) * sp * dt;
        t.z += (dz / dist) * sp * dt;
        t.yaw = Math.atan2(-dx, -dz);
      }
      t.speed = dist > 0.15 ? sp : 0;
      t.y = this.ground(t.x, t.z);
      k++;
    }
  }

  private updateActors(dt: number): void {
    const cycle = Math.floor(this.t / 6);
    for (const a of this.actors) {
      const e = a.e;
      if (a.mode === 'circle') {
        const ang = this.t * 0.35 + a.phase;
        const r = 7;
        const x = a.home.x + Math.cos(ang) * r;
        const z = a.home.z + Math.sin(ang) * r;
        e.yaw = Math.atan2(-(-Math.sin(ang)), -Math.cos(ang));
        e.x = x;
        e.z = z;
        e.y = this.ground(x, z);
        e.speed = r * 0.35;
        e.flags = (e.flags & VF_LORD) | a.stateFlags;
        continue;
      }
      if (a.mode === 'walk') {
        // pace back and forth along X, facing the direction of travel
        const w = e.kind === 'hero' ? 1.3 : 1.0;
        const s = Math.sin(this.t * w + a.phase);
        const c = Math.cos(this.t * w + a.phase);
        e.x = a.home.x + s * 3;
        e.y = this.ground(e.x, e.z);
        const vx = c * w * 3;
        e.speed = Math.abs(vx);
        e.yaw = vx > 0 ? -Math.PI / 2 : Math.PI / 2;
        e.flags = (e.flags & VF_LORD) | (e.kind === 'hero' && e.speed > 3.2 ? VF_SPRINTING : 0);
        continue;
      }
      if (a.mode === 'state') {
        // rotate through demo states over time so every animation is visible
        const idx = (this.actors.indexOf(a) + cycle) % DEMO_FLAGS.length;
        const f = DEMO_FLAGS[idx];
        e.flags = (e.flags & VF_LORD) | f;
        e.pitch = Math.sin(this.t * 0.8 + a.phase) * 0.35;
        e.speed = 0;
        e.hp = f & VF_DEAD ? 0 : Math.max(1, e.hp);
        e.shield = f & VF_SHIELDED ? 120 : 0;
        if (f & VF_STEALTH) e.flags |= VF_STEALTH;
      } else {
        e.speed = 0;
      }
    }
  }

  private spawnProjectile(kind: string, from: Vec3, vel: Vec3, life: number): void {
    const e = this.makeEntity('projectile', kind, from.x, from.z, Math.atan2(-vel.x, -vel.z));
    e.y = from.y;
    this.projectiles.push({ e, vel, life, kind });
    this.rebuildList();
  }

  private updateProjectiles(dt: number): void {
    this.projTimer -= dt;
    if (this.projTimer <= 0) {
      this.projTimer = 1.4;
      const kinds = ['rocket', 'grenade', 'arrow', 'fireball', 'bolt', 'ice'];
      const kind = kinds[Math.floor(this.t / 1.4) % kinds.length];
      const ox = this.origin.x - 30;
      const oz = this.origin.z - 8;
      const g = this.ground(ox, oz);
      this.spawnProjectile(kind, { x: ox, y: g + 2, z: oz }, { x: 18, y: kind === 'grenade' ? 7 : 2, z: 1 }, 3.2);
    }
    let removed = false;
    this.projectiles = this.projectiles.filter((p) => {
      p.life -= dt;
      const grav = p.kind === 'grenade' || p.kind === 'arrow' ? 9.8 : 0;
      p.vel.y -= grav * dt;
      p.e.x += p.vel.x * dt;
      p.e.y += p.vel.y * dt;
      p.e.z += p.vel.z * dt;
      const g = this.ground(p.e.x, p.e.z);
      if (p.life <= 0 || p.e.y < g) {
        this.events.push({ t: 'explosion', pos: { x: p.e.x, y: Math.max(g, p.e.y), z: p.e.z }, radius: p.kind === 'rocket' ? 4 : 2.5, kind: p.kind === 'bolt' ? 'thunder' : p.kind === 'ice' ? 'ice' : p.kind === 'grenade' ? 'frag' : 'fire' });
        this.byId.delete(p.e.id);
        removed = true;
        return false;
      }
      return true;
    });
    if (removed) this.rebuildList();
  }

  private updateAirdrop(dt: number): void {
    this.airdropT += dt;
    const period = 22;
    const ph = this.airdropT % period;
    const x = this.origin.x + 26;
    const z = this.origin.z - 16;
    const g = this.ground(x, z);
    if (!this.airdrop) {
      this.airdrop = this.makeEntity('airdrop', '3', x, z, 0.4);
      this.events.push({ t: 'airdrop', pos: { x, y: g, z }, id: this.airdrop.id });
      this.rebuildList();
    }
    const fall = 12;
    this.airdrop.y = ph < fall ? g + 60 * (1 - ph / fall) : g;
    this.airdrop.flags = ph > fall + 6 ? VF_OPENED : 0;
    if (ph > period - dt) {
      this.byId.delete(this.airdrop.id);
      this.airdrop = null;
      this.rebuildList();
    }
  }

  private heroActors(): Actor[] {
    return this.actors.filter((a) => a.e.kind === 'hero' && !(a.e.flags & (VF_DEAD | VF_DOWNED)));
  }

  private updateEvents(dt: number): void {
    const heroes = this.heroActors();
    if (heroes.length < 2) return;
    const pick = (): Actor => heroes[Math.floor(this.rand() * heroes.length)];
    this.shotTimer -= dt;
    while (this.shotTimer <= 0) {
      this.shotTimer += 0.18;
      const a = pick();
      const b = pick();
      if (a === b) continue;
      const from = { x: a.e.x, y: a.e.y + 1.45, z: a.e.z };
      const hit = this.rand() < 0.6;
      const to = hit ? { x: b.e.x, y: b.e.y + 1.2 + this.rand() * 0.4, z: b.e.z } : { x: b.e.x + (this.rand() - 0.5) * 6, y: this.ground(b.e.x, b.e.z) + this.rand(), z: b.e.z - 3 - this.rand() * 4 };
      this.events.push({ t: 'shot', src: a.e.id, weapon: a.e.weapon ?? 'carbine', from, to, hit: hit ? b.e.id : undefined });
      if (hit) this.events.push({ t: 'hit', target: b.e.id, src: a.e.id, amount: 20 + this.rand() * 40, dtype: 'normal', pos: to, head: this.rand() < 0.2, blocked: this.rand() < 0.1 ? 'shield' : undefined });
    }
    this.boomTimer -= dt;
    if (this.boomTimer <= 0) {
      this.boomTimer = 2.2;
      const kinds = ['fire', 'frag', 'thunder', 'ice', 'holy', 'smoke'];
      const kind = kinds[Math.floor(this.t / 2.2) % kinds.length];
      const x = this.origin.x - 6 + (this.rand() - 0.5) * 20;
      const z = this.origin.z - 26 + (this.rand() - 0.5) * 6;
      this.events.push({ t: 'explosion', pos: { x, y: this.ground(x, z) + 0.5, z }, radius: 3 + this.rand() * 2, kind });
    }
    this.abilityTimer -= dt;
    if (this.abilityTimer <= 0) {
      this.abilityTimer = 1.1;
      const a = pick();
      const def = HERO_BY_ID[a.e.sub];
      const abil = def?.abilities.filter((x) => x.slot !== 'passive') ?? [];
      const ab = abil[Math.floor(this.rand() * abil.length)];
      const tgt = pick();
      if (ab) this.events.push({ t: 'ability', src: a.e.id, ability: ab.id, pos: { x: tgt.e.x, y: tgt.e.y, z: tgt.e.z }, target: tgt.e.id, dir: forwardFromYaw(a.e.yaw) });
      if (this.rand() < 0.5) this.events.push({ t: 'melee', src: a.e.id, pos: { x: a.e.x, y: a.e.y + 1, z: a.e.z }, dir: forwardFromYaw(a.e.yaw), range: 3, arc: 110 });
      if (this.rand() < 0.4) this.events.push({ t: 'heal', target: tgt.e.id, amount: 80 });
      if (this.rand() < 0.3) this.events.push({ t: 'quickchat', who: tgt.e.id, id: this.rand() < 0.5 ? 'protectLord' : 'needPeach' });
    }
    this.statusTimer -= dt;
    if (this.statusTimer <= 0) {
      this.statusTimer = 1.7;
      const a = pick();
      const st = (['stun', 'freeze', 'charm', 'dance', 'shield', 'invuln', 'marked', 'burn'] as const)[Math.floor(this.rand() * 8)];
      this.events.push({ t: 'status', target: a.e.id, status: st, on: true });
    }
  }

  private updateZone(): void {
    const period = 60;
    const t = (this.t % period) / period;
    this.zoneV.radius = 60 - 30 * t;
    this.zoneV.targetRadius = 24;
  }
}
