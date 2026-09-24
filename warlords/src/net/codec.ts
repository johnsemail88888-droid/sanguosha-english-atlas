// Wire codecs.
//  - Control messages: JSON text (encodeJson / decodeJson).
//  - Snapshot: compact binary. Positions quantized to cm (i16, ±327 m), angles to
//    16 bit, hp u16, flags varuint (u32 range), string ids through a per-match
//    StringTable (sent once in 'matchStart'); strings missing from the table are
//    sent inline. Consecutive entities sharing the same static fields (squad
//    mates, camp bandits…) are delta-flagged so they cost ~15 bytes each.
//  - Snapshot deltas: with a baseline (a snapshot the client has acknowledged
//    receiving), only entities whose *quantized* state differs from the
//    baseline are sent, plus the ids that disappeared; unchanged entities
//    (loot, crates, idle camps — most of a typical world) cost nothing.
//    Zone / private view / players are always sent in full.
//  - InputFrame: compact binary with the previous frames' edge actions attached
//    (and the newest snapshot tick the client holds, for delta baselines).
//
// Decoded snapshots are equal to the input up to quantization, except that
// `ents` is re-ordered (grouped by kind/owner/type) — consumers index by id.
// Entities copied from a delta baseline are the baseline's own objects:
// decoded snapshots must be treated as immutable.
import { HERO_BY_ID, HEROES } from '../data/heroes';
import { ARMORS, ITEMS, MOUNTS } from '../data/items';
import { ROLES } from '../data/roles';
import { TROOPS } from '../data/troops';
import { WEAPONS } from '../data/weapons';
import { wrapAngle } from '../core/math';
import type { Vec3 } from '../core/math';
import type {
  AbilitySlot,
  ChannelState,
  EntityId,
  EntityKind,
  InputAction,
  InputFrame,
  Kingdom,
  PrivateHeroView,
  PublicPlayerView,
  RoleId,
  Snapshot,
  SquadOrderKind,
  StatusId,
  ViewEntity,
  ZoneView,
} from '../core/types';
import { ByteReader, ByteWriter } from './binary';
import { BIN_INPUT, BIN_SNAPSHOT, type InputPacket } from './protocol';

// ── enums ────────────────────────────────────────────────────────────────────
const KINDS: readonly EntityKind[] = ['hero', 'troop', 'npc', 'projectile', 'loot', 'crate', 'airdrop', 'turret', 'hazard'];
const KINGDOMS: readonly Kingdom[] = ['wei', 'shu', 'wu', 'qun', 'god'];
const ROLE_IDS: readonly RoleId[] = ['lord', 'loyalist', 'rebel', 'traitor', 'double', 'opportunist', 'bounty'];
const CHANNEL_KINDS: readonly ChannelState['kind'][] = ['item', 'revive', 'open', 'ability', 'recruit'];
const ORDER_KINDS: readonly SquadOrderKind[] = ['follow', 'hold', 'attack', 'charge'];
const ABILITY_SLOTS: readonly AbilitySlot[] = ['q', 'e', 'lord'];

// Exhaustive at compile time: adding a StatusId without listing it here fails tsc.
const STATUS_SET: Record<StatusId, true> = {
  stun: true, root: true, slow: true, haste: true, burn: true, freeze: true, poison: true, stealth: true,
  invuln: true, untargetable: true, dmgBoost: true, dmgTakenUp: true, dmgTakenDown: true, noReload: true,
  fireRateUp: true, reveal: true, charm: true, silence: true, disarm: true, dance: true, nullify: true,
  chained: true, marked: true, dodgeChance: true, regen: true, lifesteal: true, reflect: true, thorns: true,
  undodgeable: true, pierce: true, shield: true, drunk: true,
};
export const STATUS_IDS = Object.keys(STATUS_SET) as StatusId[];

/** Kinds invented by sim/abilities that are likely to show up in `sub`. */
const COMMON_KINDS = [
  'bullet', 'rocket', 'grenade', 'arrow', 'fireball', 'bolt', 'fire', 'lightningCloud', 'trapDance', 'trapRoot',
  'smoke', 'healZone', 'arrowRain', 'napalm', 'frost', 'fireShip', 'formation', 'banner', 'gas', 'storm',
  'turret', 'muniu', 'supply', 'airdrop', '1', '2', '3',
];

// ── string table ─────────────────────────────────────────────────────────────
export class StringTable {
  private readonly list: string[] = [];
  private readonly index = new Map<string, number>();

  constructor(strings: readonly string[] = []) {
    for (const s of strings) {
      if (typeof s !== 'string' || this.index.has(s)) continue;
      this.index.set(s, this.list.length);
      this.list.push(s);
    }
  }

  get strings(): readonly string[] {
    return this.list;
  }

  indexOf(s: string): number {
    return this.index.get(s) ?? -1;
  }

  at(i: number): string | undefined {
    return this.list[i];
  }
}

/**
 * Build the per-match string table: every content id (heroes, abilities,
 * weapons, items, armor, mounts, troops, statuses, roles), common projectile /
 * hazard kinds, plus `extra` (player ids and names).
 */
export function buildMatchStrings(extra: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const h of HEROES) {
    out.push(h.id);
    for (const a of h.abilities) out.push(a.id);
  }
  for (const w of WEAPONS) out.push(w.id);
  for (const i of ITEMS) out.push(i.id);
  for (const a of ARMORS) out.push(a.id);
  for (const m of MOUNTS) out.push(m.id);
  for (const t of TROOPS) out.push(t.id);
  for (const r of ROLES) out.push(r.id);
  out.push(...STATUS_IDS, ...COMMON_KINDS, ...extra);
  return [...new Set(out)];
}

// strref: varuint 0 = absent, 1 = inline string, n >= 2 → table[n - 2]
function writeStr(w: ByteWriter, st: StringTable, s: string | null | undefined): void {
  if (s === undefined || s === null) {
    w.varuint(0);
    return;
  }
  const i = st.indexOf(s);
  if (i >= 0) w.varuint(i + 2);
  else w.varuint(1).str(s);
}

function readStr(r: ByteReader, st: StringTable): string | undefined {
  const v = r.varuint();
  if (v === 0) return undefined;
  if (v === 1) return r.str();
  const s = st.at(v - 2);
  if (s === undefined) throw new RangeError(`codec: string index ${v - 2} not in table`);
  return s;
}

function writeEnum<T extends string>(w: ByteWriter, list: readonly T[], v: T): void {
  const i = list.indexOf(v);
  if (i >= 0) w.u8(i);
  else w.u8(255).str(String(v));
}

function readEnum<T extends string>(r: ByteReader, list: readonly T[]): T {
  const i = r.u8();
  if (i === 255) return r.str() as T;
  const v = list[i];
  if (v === undefined) throw new RangeError(`codec: enum index ${i} out of range`);
  return v;
}

// ── quantization ─────────────────────────────────────────────────────────────
const TWO_PI = Math.PI * 2;
const cm = (v: number): number => Math.round(v * 100);
const fromCm = (v: number): number => v / 100;
const yawQ = (a: number): number => Math.round((wrapAngle(a) / TWO_PI) * 65536) & 0xffff;
const yawDQ = (v: number): number => wrapAngle((v / 65536) * TWO_PI);
const PITCH_SCALE = 32767 / Math.PI;
const hpQ = (v: number): number => (v > 0 && v < 1 ? 1 : Math.round(v));
/** seconds → centiseconds u16; 0xffff = Infinity / "until consumed" */
const csQ = (s: number): number => (!Number.isFinite(s) ? 0xffff : Math.min(0xfffe, Math.max(0, Math.round(s * 100))));
const csDQ = (v: number): number => (v === 0xffff ? Infinity : v / 100);

function writeVec(w: ByteWriter, v: Vec3): void {
  w.i16(cm(v.x)).i16(cm(v.y)).i16(cm(v.z));
}
function readVec(r: ByteReader): Vec3 {
  return { x: fromCm(r.i16()), y: fromCm(r.i16()), z: fromCm(r.i16()) };
}

// ── entities ─────────────────────────────────────────────────────────────────
const S_KINGDOM = 1;
const S_OWNER = 2;
const S_WEAPON = 4;
const S_ARMOR = 8;
const S_MOUNT = 16;
const S_RADIUS = 32;
const S_ROLE = 64;
const S_CLAIM = 128;
const S_NAME = 256;

const H_SAME = 0x10;
const H_PITCH = 0x20;
const H_SHIELD = 0x40;
const H_SPEED = 0x80;

function sameStatic(a: ViewEntity, b: ViewEntity): boolean {
  return (
    a.kind === b.kind &&
    a.sub === b.sub &&
    hpQ(a.maxHp) === hpQ(b.maxHp) &&
    a.kingdom === b.kingdom &&
    a.owner === b.owner &&
    a.weapon === b.weapon &&
    a.armor === b.armor &&
    a.mount === b.mount &&
    (a.radius === undefined ? b.radius === undefined : b.radius !== undefined && cm(a.radius) === cm(b.radius)) &&
    a.role === b.role &&
    a.claim === b.claim &&
    a.name === b.name
  );
}

const kindOrder = (k: EntityKind): number => {
  const i = KINDS.indexOf(k);
  return i < 0 ? 99 : i;
};

function entityOrder(a: ViewEntity, b: ViewEntity): number {
  return (
    kindOrder(a.kind) - kindOrder(b.kind) ||
    (a.owner ?? -1) - (b.owner ?? -1) ||
    (a.sub < b.sub ? -1 : a.sub > b.sub ? 1 : 0) ||
    hpQ(a.maxHp) - hpQ(b.maxHp) ||
    a.id - b.id
  );
}

const pitchQ = (p: number): number => Math.round(p * PITCH_SCALE);
const speedQ = (v: number): number => Math.min(255, Math.max(0, Math.round(v * 5)));

/**
 * True when `a` and `b` encode to exactly the same entity record (every field
 * as quantized on the wire) — the delta encoder may then skip `b`.
 */
export function sameQuantized(a: ViewEntity, b: ViewEntity): boolean {
  return (
    a.id === b.id &&
    cm(a.x) === cm(b.x) &&
    cm(a.y) === cm(b.y) &&
    cm(a.z) === cm(b.z) &&
    yawQ(a.yaw) === yawQ(b.yaw) &&
    pitchQ(a.pitch) === pitchQ(b.pitch) &&
    hpQ(a.hp) === hpQ(b.hp) &&
    hpQ(a.shield) === hpQ(b.shield) &&
    speedQ(a.speed) === speedQ(b.speed) &&
    a.flags >>> 0 === b.flags >>> 0 &&
    sameStatic(a, b)
  );
}

function writeEntity(w: ByteWriter, st: StringTable, e: ViewEntity, prev: ViewEntity | null): void {
  w.varuint(e.id);
  const kindCode = KINDS.indexOf(e.kind);
  const same = prev !== null && sameStatic(e, prev);
  const pq = pitchQ(e.pitch);
  const shieldQ = hpQ(e.shield);
  const sq = speedQ(e.speed);
  let head = (kindCode < 0 ? 15 : kindCode) & 0x0f;
  if (same) head |= H_SAME;
  if (pq !== 0) head |= H_PITCH;
  if (shieldQ !== 0) head |= H_SHIELD;
  if (sq !== 0) head |= H_SPEED;
  w.u8(head);
  if (kindCode < 0) w.str(e.kind);
  if (!same) {
    let mask = 0;
    if (e.kingdom !== undefined) mask |= S_KINGDOM;
    if (e.owner !== undefined) mask |= S_OWNER;
    if (e.weapon !== undefined) mask |= S_WEAPON;
    if (e.armor !== undefined) mask |= S_ARMOR;
    if (e.mount !== undefined) mask |= S_MOUNT;
    if (e.radius !== undefined) mask |= S_RADIUS;
    if (e.role !== undefined) mask |= S_ROLE;
    if (e.claim !== undefined) mask |= S_CLAIM;
    if (e.name !== undefined) mask |= S_NAME;
    w.varuint(mask);
    writeStr(w, st, e.sub);
    w.u16(hpQ(e.maxHp));
    if (mask & S_KINGDOM) writeEnum(w, KINGDOMS, e.kingdom as Kingdom);
    if (mask & S_OWNER) w.varuint(e.owner as number);
    if (mask & S_WEAPON) writeStr(w, st, e.weapon);
    if (mask & S_ARMOR) writeStr(w, st, e.armor);
    if (mask & S_MOUNT) writeStr(w, st, e.mount);
    if (mask & S_RADIUS) w.u16(cm(e.radius as number));
    if (mask & S_ROLE) writeEnum(w, ROLE_IDS, e.role as RoleId);
    if (mask & S_CLAIM) writeEnum(w, ROLE_IDS, e.claim as RoleId);
    if (mask & S_NAME) writeStr(w, st, e.name);
  }
  w.i16(cm(e.x)).i16(cm(e.y)).i16(cm(e.z));
  w.u16(yawQ(e.yaw));
  if (head & H_PITCH) w.i16(pq);
  w.u16(hpQ(e.hp));
  if (head & H_SHIELD) w.u16(shieldQ);
  if (head & H_SPEED) w.u8(sq);
  w.varuint(e.flags >>> 0);
}

function readEntity(r: ByteReader, st: StringTable, prev: ViewEntity | null): ViewEntity {
  const id = r.varuint();
  const head = r.u8();
  const kindCode = head & 0x0f;
  const kind = kindCode === 15 ? (r.str() as EntityKind) : KINDS[kindCode];
  if (kind === undefined) throw new RangeError(`codec: bad entity kind ${kindCode}`);
  const e: ViewEntity = { id, kind, sub: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, hp: 0, maxHp: 0, shield: 0, flags: 0 };
  if (head & H_SAME) {
    if (!prev) throw new RangeError('codec: SAME flag on first entity');
    e.sub = prev.sub;
    e.maxHp = prev.maxHp;
    if (prev.kingdom !== undefined) e.kingdom = prev.kingdom;
    if (prev.owner !== undefined) e.owner = prev.owner;
    if (prev.weapon !== undefined) e.weapon = prev.weapon;
    if (prev.armor !== undefined) e.armor = prev.armor;
    if (prev.mount !== undefined) e.mount = prev.mount;
    if (prev.radius !== undefined) e.radius = prev.radius;
    if (prev.role !== undefined) e.role = prev.role;
    if (prev.claim !== undefined) e.claim = prev.claim;
    if (prev.name !== undefined) e.name = prev.name;
  } else {
    const mask = r.varuint();
    e.sub = readStr(r, st) ?? '';
    e.maxHp = r.u16();
    if (mask & S_KINGDOM) e.kingdom = readEnum(r, KINGDOMS);
    if (mask & S_OWNER) e.owner = r.varuint();
    if (mask & S_WEAPON) e.weapon = readStr(r, st);
    if (mask & S_ARMOR) e.armor = readStr(r, st);
    if (mask & S_MOUNT) e.mount = readStr(r, st);
    if (mask & S_RADIUS) e.radius = fromCm(r.u16());
    if (mask & S_ROLE) e.role = readEnum(r, ROLE_IDS);
    if (mask & S_CLAIM) e.claim = readEnum(r, ROLE_IDS);
    if (mask & S_NAME) e.name = readStr(r, st);
  }
  e.x = fromCm(r.i16());
  e.y = fromCm(r.i16());
  e.z = fromCm(r.i16());
  e.yaw = yawDQ(r.u16());
  if (head & H_PITCH) e.pitch = r.i16() / PITCH_SCALE;
  e.hp = r.u16();
  if (head & H_SHIELD) e.shield = r.u16();
  if (head & H_SPEED) e.speed = r.u8() / 5;
  e.flags = r.varuint() >>> 0;
  return e;
}

// ── zone / players / private view ───────────────────────────────────────────
function writeZone(w: ByteWriter, z: ZoneView): void {
  w.u8(z.phase);
  w.f32(z.center.x).f32(z.center.y).f32(z.center.z).f32(z.radius);
  w.f32(z.targetCenter.x).f32(z.targetCenter.y).f32(z.targetCenter.z).f32(z.targetRadius);
  w.f32(z.shrinkStart).f32(z.shrinkEnd).f32(z.dps);
}

function readZone(r: ByteReader): ZoneView {
  const phase = r.u8();
  const center = { x: r.f32(), y: r.f32(), z: r.f32() };
  const radius = r.f32();
  const targetCenter = { x: r.f32(), y: r.f32(), z: r.f32() };
  const targetRadius = r.f32();
  return { phase, center, radius, targetCenter, targetRadius, shrinkStart: r.f32(), shrinkEnd: r.f32(), dps: r.f32() };
}

const P_BOT = 1;
const P_ALIVE = 2;
const P_DOWNED = 4;
const P_ROLE = 8;
const P_CLAIM = 16;
const P_PING = 32;

function writePlayer(w: ByteWriter, st: StringTable, p: PublicPlayerView): void {
  writeStr(w, st, p.playerId);
  writeStr(w, st, p.name);
  w.u8(p.seat);
  w.varuint(p.entityId);
  writeStr(w, st, p.heroId);
  writeEnum(w, KINGDOMS, p.kingdom);
  let f = 0;
  if (p.isBot) f |= P_BOT;
  if (p.alive) f |= P_ALIVE;
  if (p.downed) f |= P_DOWNED;
  if (p.role !== undefined) f |= P_ROLE;
  if (p.claim !== undefined) f |= P_CLAIM;
  if (p.ping !== undefined) f |= P_PING;
  w.u8(f);
  if (f & P_ROLE) writeEnum(w, ROLE_IDS, p.role as RoleId);
  if (f & P_CLAIM) writeEnum(w, ROLE_IDS, p.claim as RoleId);
  w.varuint(p.kills);
  if (f & P_PING) w.u16(p.ping as number);
}

function readPlayer(r: ByteReader, st: StringTable): PublicPlayerView {
  const playerId = readStr(r, st) ?? '';
  const name = readStr(r, st) ?? '';
  const seat = r.u8();
  const entityId = r.varuint();
  const heroId = readStr(r, st) ?? '';
  const kingdom = readEnum(r, KINGDOMS);
  const f = r.u8();
  const p: PublicPlayerView = {
    playerId,
    name,
    isBot: (f & P_BOT) !== 0,
    seat,
    entityId,
    heroId,
    kingdom,
    alive: (f & P_ALIVE) !== 0,
    downed: (f & P_DOWNED) !== 0,
    kills: 0,
  };
  if (f & P_ROLE) p.role = readEnum(r, ROLE_IDS);
  if (f & P_CLAIM) p.claim = readEnum(r, ROLE_IDS);
  p.kills = r.varuint();
  if (f & P_PING) p.ping = r.u16();
  return p;
}

function writeRecord(w: ByteWriter, st: StringTable, rec: Record<string, number>, mode: 'cs' | 'f32'): void {
  const keys = Object.keys(rec);
  w.varuint(keys.length);
  for (const k of keys) {
    writeStr(w, st, k);
    if (mode === 'cs') w.u16(csQ(rec[k]));
    else w.f32(rec[k]);
  }
}

function readRecord(r: ByteReader, st: StringTable, mode: 'cs' | 'f32'): Record<string, number> {
  const n = r.varuint();
  const out: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const k = readStr(r, st) ?? '';
    out[k] = mode === 'cs' ? csDQ(r.u16()) : r.f32();
  }
  return out;
}

const Y_CHANNEL = 1;
const Y_DOWNED = 2;
const Y_DEAD = 4;
const Y_BOUNTY = 8;
const Y_ALLIES = 16;
const Y_VEL = 32;
const Y_HAS_GROUND = 64;
const Y_ON_GROUND = 128;
const Y2_MODS = 1;
const Y2_FORCED = 2;

function writeYou(w: ByteWriter, st: StringTable, y: PrivateHeroView): void {
  w.varuint(y.entityId);
  writeStr(w, st, y.heroId);
  writeEnum(w, ROLE_IDS, y.role);
  w.u16(hpQ(y.hp)).u16(hpQ(y.maxHp)).u16(hpQ(y.shield));
  w.u8(Math.min(255, y.weapons.length));
  for (const wi of y.weapons.slice(0, 255)) {
    if (!wi) {
      w.u8(0);
      continue;
    }
    w.u8(1);
    writeStr(w, st, wi.id);
    w.u16(wi.mag).u16(wi.reserve);
  }
  w.u8(y.activeSlot);
  w.u8(Math.min(255, y.items.length));
  for (const it of y.items.slice(0, 255)) {
    if (!it) {
      w.u8(0);
      continue;
    }
    w.u8(1);
    writeStr(w, st, it.id);
    w.u16(it.count);
  }
  writeStr(w, st, y.armor);
  writeStr(w, st, y.mount);
  writeRecord(w, st, y.cooldowns, 'cs');
  writeRecord(w, st, y.charges, 'f32');
  writeRecord(w, st, y.abilityState, 'f32');
  w.u8(y.dodgeCharges);
  w.u16(csQ(y.reloading));
  let f = 0;
  if (y.channel) f |= Y_CHANNEL;
  if (y.downed) f |= Y_DOWNED;
  if (y.dead) f |= Y_DEAD;
  if (y.bountyTargetId !== undefined) f |= Y_BOUNTY;
  if (y.knownAllies !== undefined) f |= Y_ALLIES;
  if (y.vel !== undefined) f |= Y_VEL;
  if (y.onGround !== undefined) f |= Y_HAS_GROUND | (y.onGround ? Y_ON_GROUND : 0);
  w.u8(f);
  w.u8((y.moveMods ? Y2_MODS : 0) | (y.forced ? Y2_FORCED : 0));
  if (y.channel) {
    writeEnum(w, CHANNEL_KINDS, y.channel.kind);
    w.u16(Math.round(Math.min(1, Math.max(0, y.channel.progress)) * 65535));
  }
  w.u16(csQ(y.downedRemaining));
  const statuses = y.statuses.slice(0, 255);
  w.u8(statuses.length);
  for (const s of statuses) {
    writeStr(w, st, s.id);
    w.u16(csQ(s.remaining));
  }
  const squad = y.squad.slice(0, 255);
  w.u8(squad.length);
  for (const s of squad) w.varuint(s.id).u16(hpQ(s.hp)).u16(hpQ(s.maxHp));
  writeEnum(w, ORDER_KINDS, y.order.kind);
  w.u8((y.order.point ? 1 : 0) | (y.order.targetId !== undefined ? 2 : 0));
  if (y.order.point) writeVec(w, y.order.point);
  if (y.order.targetId !== undefined) w.varuint(y.order.targetId);
  if (y.bountyTargetId !== undefined) w.varuint(y.bountyTargetId);
  if (y.knownAllies !== undefined) {
    const ka = y.knownAllies.slice(0, 255);
    w.u8(ka.length);
    for (const id of ka) w.varuint(id);
  }
  w.varuint(y.stats.kills).varuint(Math.round(y.stats.damage)).varuint(Math.round(y.stats.healing)).varuint(y.stats.rescues);
  if (y.vel) writeVec(w, y.vel);
  if (y.moveMods) {
    w.f32(y.moveMods.speedMul);
    w.u8((y.moveMods.canSprint ? 1 : 0) | (y.moveMods.canJump ? 2 : 0) | (y.moveMods.rooted ? 4 : 0));
  }
  if (y.forced) {
    writeVec(w, y.forced.vel);
    w.u16(csQ(y.forced.remaining));
  }
}

function readYou(r: ByteReader, st: StringTable): PrivateHeroView {
  const entityId = r.varuint();
  const heroId = readStr(r, st) ?? '';
  const role = readEnum(r, ROLE_IDS);
  const hp = r.u16();
  const maxHp = r.u16();
  const shield = r.u16();
  const nw = r.u8();
  const weapons: PrivateHeroView['weapons'] = [];
  for (let i = 0; i < nw; i++) {
    if (r.u8() === 0) weapons.push(null);
    else weapons.push({ id: readStr(r, st) ?? '', mag: r.u16(), reserve: r.u16() });
  }
  const activeSlot = r.u8();
  const ni = r.u8();
  const items: PrivateHeroView['items'] = [];
  for (let i = 0; i < ni; i++) {
    if (r.u8() === 0) items.push(null);
    else items.push({ id: readStr(r, st) ?? '', count: r.u16() });
  }
  const armor = readStr(r, st) ?? null;
  const mount = readStr(r, st) ?? null;
  const cooldowns = readRecord(r, st, 'cs');
  const charges = readRecord(r, st, 'f32');
  const abilityState = readRecord(r, st, 'f32');
  const dodgeCharges = r.u8();
  const reloading = csDQ(r.u16());
  const f = r.u8();
  const f2 = r.u8();
  let channel: PrivateHeroView['channel'] = null;
  if (f & Y_CHANNEL) {
    const kind = readEnum(r, CHANNEL_KINDS);
    channel = { kind, progress: r.u16() / 65535 };
  }
  const downedRemaining = csDQ(r.u16());
  const ns = r.u8();
  const statuses: PrivateHeroView['statuses'] = [];
  for (let i = 0; i < ns; i++) statuses.push({ id: (readStr(r, st) ?? 'stun') as StatusId, remaining: csDQ(r.u16()) });
  const nq = r.u8();
  const squad: PrivateHeroView['squad'] = [];
  for (let i = 0; i < nq; i++) squad.push({ id: r.varuint(), hp: r.u16(), maxHp: r.u16() });
  const order: PrivateHeroView['order'] = { kind: readEnum(r, ORDER_KINDS) };
  const of = r.u8();
  if (of & 1) order.point = readVec(r);
  if (of & 2) order.targetId = r.varuint();
  const y: PrivateHeroView = {
    entityId,
    heroId,
    role,
    hp,
    maxHp,
    shield,
    weapons,
    activeSlot,
    items,
    armor,
    mount,
    cooldowns,
    charges,
    abilityState,
    dodgeCharges,
    reloading,
    channel,
    downed: (f & Y_DOWNED) !== 0,
    downedRemaining,
    dead: (f & Y_DEAD) !== 0,
    statuses,
    squad,
    order,
    stats: { kills: 0, damage: 0, healing: 0, rescues: 0 },
  };
  if (f & Y_BOUNTY) y.bountyTargetId = r.varuint();
  if (f & Y_ALLIES) {
    const n = r.u8();
    y.knownAllies = [];
    for (let i = 0; i < n; i++) y.knownAllies.push(r.varuint());
  }
  y.stats = { kills: r.varuint(), damage: r.varuint(), healing: r.varuint(), rescues: r.varuint() };
  if (f & Y_VEL) y.vel = readVec(r);
  if (f & Y_HAS_GROUND) y.onGround = (f & Y_ON_GROUND) !== 0;
  if (f2 & Y2_MODS) {
    const speedMul = r.f32();
    const b = r.u8();
    y.moveMods = { speedMul, canSprint: (b & 1) !== 0, canJump: (b & 2) !== 0, rooted: (b & 4) !== 0 };
  }
  if (f2 & Y2_FORCED) {
    const vel = readVec(r);
    y.forced = { vel, remaining: csDQ(r.u16()) };
  }
  return y;
}

// ── snapshot ─────────────────────────────────────────────────────────────────
const snapshotWriter = new ByteWriter(4096);

/** A snapshot the receiver holds, used as the reference of a delta. */
export interface SnapshotBaseline {
  tick: number;
  ents: ReadonlyMap<EntityId, ViewEntity>;
}

/** Thrown by decodeSnapshotMsg when a delta's baseline is not available. */
export class MissingBaselineError extends RangeError {
  constructor(readonly baseTick: number) {
    super(`codec: delta baseline ${baseTick} not available`);
    this.name = 'MissingBaselineError';
  }
}

const SNAP_DELTA = 1;

/**
 * Encode a snapshot as a binary message (tag BIN_SNAPSHOT). With `base`, only
 * entities that changed since the baseline (plus removals) are written.
 */
export function encodeSnapshotMsg(s: Snapshot, st: StringTable, base?: SnapshotBaseline | null): Uint8Array {
  const w = snapshotWriter.reset();
  w.u8(BIN_SNAPSHOT);
  w.varuint(s.tick);
  w.u8(base ? SNAP_DELTA : 0);
  if (base) w.varuint(base.tick);
  w.f32(s.time);
  w.varuint(s.ackSeq);
  w.f32(s.elapsed);
  writeZone(w, s.zone);
  if (s.you) {
    w.u8(1);
    writeYou(w, st, s.you);
  } else {
    w.u8(0);
  }
  const players = s.players.slice(0, 255);
  w.u8(players.length);
  for (const p of players) writePlayer(w, st, p);
  let ents: ViewEntity[];
  if (base) {
    // removals: in the baseline, gone now
    const present = new Set<EntityId>();
    for (const e of s.ents) present.add(e.id);
    let removed = 0;
    for (const id of base.ents.keys()) if (!present.has(id)) removed++;
    w.varuint(removed);
    for (const id of base.ents.keys()) if (!present.has(id)) w.varuint(id);
    // changes: new entities or a different quantized state. The same object
    // on both sides cannot be compared (a sim updating views in place): send it.
    ents = [];
    for (const e of s.ents) {
      const b = base.ents.get(e.id);
      if (!b || b === e || !sameQuantized(b, e)) ents.push(e);
    }
  } else {
    ents = [...s.ents];
  }
  ents.sort(entityOrder);
  w.varuint(ents.length);
  let prev: ViewEntity | null = null;
  for (const e of ents) {
    writeEntity(w, st, e, prev);
    prev = e;
  }
  return w.finish();
}

/** Tick of a BIN_SNAPSHOT message and the baseline it depends on (null = full snapshot). */
export function peekSnapshotHeader(data: Uint8Array): { tick: number; baseTick: number | null } {
  const r = new ByteReader(data);
  if (r.u8() !== BIN_SNAPSHOT) throw new RangeError('codec: not a snapshot');
  const tick = r.varuint();
  const flags = r.u8();
  return { tick, baseTick: flags & SNAP_DELTA ? r.varuint() : null };
}

/**
 * Decode a BIN_SNAPSHOT message. A delta needs its baseline from `baselineOf`
 * (MissingBaselineError otherwise). Throws RangeError on malformed input.
 */
export function decodeSnapshotMsg(
  data: Uint8Array,
  st: StringTable,
  baselineOf?: (tick: number) => ReadonlyMap<EntityId, ViewEntity> | undefined,
): Snapshot {
  const r = new ByteReader(data);
  if (r.u8() !== BIN_SNAPSHOT) throw new RangeError('codec: not a snapshot');
  const tick = r.varuint();
  const flags = r.u8();
  let base: ReadonlyMap<EntityId, ViewEntity> | null = null;
  if (flags & SNAP_DELTA) {
    const baseTick = r.varuint();
    base = baselineOf?.(baseTick) ?? null;
    if (!base) throw new MissingBaselineError(baseTick);
  }
  const time = r.f32();
  const ackSeq = r.varuint();
  const elapsed = r.f32();
  const zone = readZone(r);
  const you = r.u8() === 1 ? readYou(r, st) : null;
  const np = r.u8();
  const players: PublicPlayerView[] = [];
  for (let i = 0; i < np; i++) players.push(readPlayer(r, st));
  let removed: Set<EntityId> | null = null;
  if (base) {
    const nr = r.varuint();
    if (nr > base.size) throw new RangeError('codec: more removals than baseline entities');
    removed = new Set<EntityId>();
    for (let i = 0; i < nr; i++) removed.add(r.varuint());
  }
  const ne = r.varuint();
  const ents: ViewEntity[] = [];
  let prev: ViewEntity | null = null;
  const changed = base ? new Set<EntityId>() : null;
  for (let i = 0; i < ne; i++) {
    const e = readEntity(r, st, prev);
    ents.push(e);
    changed?.add(e.id);
    prev = e;
  }
  if (base && removed && changed) {
    // unchanged entities: the baseline's (immutable) objects
    for (const [id, e] of base) if (!removed.has(id) && !changed.has(id)) ents.push(e);
  }
  return { tick, time, ackSeq, ents, zone, you, players, elapsed };
}

/**
 * Receiving side of the snapshot stream: decodes full and delta snapshots,
 * keeping the last `capacity` decoded snapshots as baselines. `newest` is the
 * tick to acknowledge to the sender.
 */
export class SnapshotReceiver {
  private readonly baselines = new Map<number, Map<EntityId, ViewEntity>>();
  /** newest decoded snapshot tick (-1 = none yet) */
  newest = -1;
  /** diagnostics: decoded full / delta snapshots, deltas skipped for a missing baseline */
  readonly stats = { full: 0, delta: 0, missing: 0 };

  constructor(
    private readonly table: StringTable,
    private readonly capacity = 64,
  ) {}

  /**
   * Decode one BIN_SNAPSHOT message. Returns null for a delta whose baseline is
   * no longer held (skip it: the acknowledgements steer the sender back to a
   * baseline we have). Throws RangeError on malformed input.
   */
  receive(data: Uint8Array): { snap: Snapshot; byId: Map<EntityId, ViewEntity> } | null {
    let snap: Snapshot;
    let delta = false;
    try {
      snap = decodeSnapshotMsg(data, this.table, (tick) => {
        delta = true;
        return this.baselines.get(tick);
      });
    } catch (err) {
      if (err instanceof MissingBaselineError) {
        this.stats.missing++;
        return null;
      }
      throw err;
    }
    if (delta) this.stats.delta++;
    else this.stats.full++;
    const byId = new Map<EntityId, ViewEntity>();
    for (const e of snap.ents) byId.set(e.id, e);
    this.baselines.delete(snap.tick);
    this.baselines.set(snap.tick, byId);
    while (this.baselines.size > this.capacity) this.baselines.delete(this.baselines.keys().next().value as number);
    if (snap.tick > this.newest) this.newest = snap.tick;
    return { snap, byId };
  }
}

// ── input ────────────────────────────────────────────────────────────────────
const I_AIM_POINT = 1;
const I_AIM_TARGET = 2;
const I_VIEW_TICK = 4;
const I_SNAP_ACK = 8;

function writeAction(w: ByteWriter, a: InputAction): void {
  switch (a.a) {
    case 'jump':
      w.u8(0);
      return;
    case 'dodge':
      w.u8(1);
      return;
    case 'reload':
      w.u8(2);
      return;
    case 'ability':
      w.u8(3);
      writeEnum(w, ABILITY_SLOTS, a.slot);
      return;
    case 'interact':
      w.u8(4);
      return;
    case 'weapon':
      w.u8(5).u8(a.slot);
      return;
    case 'item':
      w.u8(6).u8(a.slot);
      return;
    case 'drop':
      w.u8(7).u8(a.slot).u8(a.what === 'weapon' ? 1 : 0);
      return;
    case 'command':
      w.u8(8);
      writeEnum(w, ORDER_KINDS, a.order);
      return;
    case 'mark':
      w.u8(9);
      return;
    case 'claim':
      w.u8(10);
      writeEnum(w, ROLE_IDS, a.role);
      return;
    case 'quickchat':
      w.u8(11).str(a.id);
      return;
    default:
      // forward-compatible: unknown action shapes travel as JSON
      w.u8(255).str(JSON.stringify(a));
  }
}

function readAction(r: ByteReader): InputAction {
  const code = r.u8();
  switch (code) {
    case 0:
      return { a: 'jump' };
    case 1:
      return { a: 'dodge' };
    case 2:
      return { a: 'reload' };
    case 3:
      return { a: 'ability', slot: readEnum(r, ABILITY_SLOTS) };
    case 4:
      return { a: 'interact' };
    case 5:
      return { a: 'weapon', slot: r.u8() };
    case 6:
      return { a: 'item', slot: r.u8() };
    case 7: {
      const slot = r.u8();
      return { a: 'drop', slot, what: r.u8() === 1 ? 'weapon' : 'item' };
    }
    case 8:
      return { a: 'command', order: readEnum(r, ORDER_KINDS) };
    case 9:
      return { a: 'mark' };
    case 10:
      return { a: 'claim', role: readEnum(r, ROLE_IDS) };
    case 11:
      return { a: 'quickchat', id: r.str() };
    case 255:
      return JSON.parse(r.str()) as InputAction;
    default:
      throw new RangeError(`codec: unknown action code ${code}`);
  }
}

function writeActions(w: ByteWriter, actions: readonly InputAction[]): void {
  const list = actions.slice(0, 255);
  w.u8(list.length);
  for (const a of list) writeAction(w, a);
}

function readActions(r: ByteReader): InputAction[] {
  const n = r.u8();
  const out: InputAction[] = [];
  for (let i = 0; i < n; i++) out.push(readAction(r));
  return out;
}

const inputWriter = new ByteWriter(256);

/** Encode an InputPacket (tag BIN_INPUT). Move axes are quantized to 1/127. */
export function encodeInputMsg(p: InputPacket): Uint8Array {
  const f = p.frame;
  const w = inputWriter.reset();
  w.u8(BIN_INPUT);
  w.varuint(f.seq);
  w.i8(Math.round(Math.max(-1, Math.min(1, f.moveX)) * 127));
  w.i8(Math.round(Math.max(-1, Math.min(1, f.moveZ)) * 127));
  w.u16(yawQ(f.yaw));
  w.i16(Math.round(f.pitch * PITCH_SCALE));
  w.varuint(f.buttons >>> 0);
  let flags = 0;
  if (f.aimPoint) flags |= I_AIM_POINT;
  if (f.aimTargetId !== undefined) flags |= I_AIM_TARGET;
  if (f.viewTick !== undefined) flags |= I_VIEW_TICK;
  if (p.snapAck !== undefined && p.snapAck >= 0) flags |= I_SNAP_ACK;
  w.u8(flags);
  if (f.aimPoint) w.f32(f.aimPoint.x).f32(f.aimPoint.y).f32(f.aimPoint.z);
  if (f.aimTargetId !== undefined) w.varuint(f.aimTargetId);
  if (f.viewTick !== undefined) w.varuint(f.viewTick);
  if (flags & I_SNAP_ACK) w.varuint(p.snapAck as number);
  writeActions(w, f.actions);
  const hist = p.history.filter((h) => h.seq < f.seq && f.seq - h.seq <= 255 && h.actions.length > 0);
  w.u8(hist.length);
  for (const h of hist) {
    w.u8(f.seq - h.seq);
    writeActions(w, h.actions);
  }
  return w.finish();
}

export function decodeInputMsg(data: Uint8Array): InputPacket {
  const r = new ByteReader(data);
  if (r.u8() !== BIN_INPUT) throw new RangeError('codec: not an input frame');
  const seq = r.varuint();
  const moveX = r.i8() / 127;
  const moveZ = r.i8() / 127;
  const yaw = yawDQ(r.u16());
  const pitch = r.i16() / PITCH_SCALE;
  const buttons = r.varuint() >>> 0;
  const flags = r.u8();
  const frame: InputFrame = { seq, moveX, moveZ, yaw, pitch, buttons, actions: [] };
  if (flags & I_AIM_POINT) frame.aimPoint = { x: r.f32(), y: r.f32(), z: r.f32() };
  if (flags & I_AIM_TARGET) frame.aimTargetId = r.varuint();
  if (flags & I_VIEW_TICK) frame.viewTick = r.varuint();
  const snapAck = flags & I_SNAP_ACK ? r.varuint() : undefined;
  frame.actions = readActions(r);
  const nh = r.u8();
  const history: InputPacket['history'] = [];
  for (let i = 0; i < nh; i++) {
    const delta = r.u8();
    history.push({ seq: seq - delta, actions: readActions(r) });
  }
  const pkt: InputPacket = { frame, history };
  if (snapAck !== undefined) pkt.snapAck = snapAck;
  return pkt;
}

/** Quantize an InputFrame exactly like the wire does (client prediction must use the same values the host sees). */
export function quantizeInput(f: InputFrame): InputFrame {
  const out: InputFrame = {
    ...f,
    moveX: Math.round(Math.max(-1, Math.min(1, f.moveX)) * 127) / 127,
    moveZ: Math.round(Math.max(-1, Math.min(1, f.moveZ)) * 127) / 127,
    yaw: yawDQ(yawQ(f.yaw)),
    pitch: Math.max(-0x8000, Math.min(0x7fff, Math.round(f.pitch * PITCH_SCALE))) / PITCH_SCALE,
    buttons: f.buttons >>> 0,
  };
  // own copy: callers may reuse / mutate the source frame's aim point in place
  if (f.aimPoint) out.aimPoint = { x: f.aimPoint.x, y: f.aimPoint.y, z: f.aimPoint.z };
  return out;
}

// ── framing helpers ──────────────────────────────────────────────────────────
export const binaryTag = (data: Uint8Array): number => (data.length > 0 ? data[0] : -1);

/** Round non-integers to 1 mm: keeps event JSON small (Vec3s, amounts). */
function roundReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'number' && !Number.isInteger(v) && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v;
}

export function encodeJson<T extends { t: string }>(msg: T, opts?: { round?: boolean }): string {
  return JSON.stringify(msg, opts?.round ? roundReplacer : undefined);
}

/** Parse a JSON control message; null if malformed. */
export function decodeJson(text: string): { t: string; [k: string]: unknown } | null {
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string') return v as { t: string };
    return null;
  } catch {
    return null;
  }
}

/** Hero kingdom lookup helper for seat tables. */
export const heroKingdom = (heroId: string): Kingdom | undefined => HERO_BY_ID[heroId]?.kingdom;
