// Basic but playable bot hero brain (wave 2 replaces it with a role-aware AI).
// Uses only public knowledge (known roles, claims, who attacked whom) — never
// the hidden roles of other players.
//  - fights: whoever is hostile per sim.isHostileTo, whoever shot it, (lord
//    side) whoever shot a crown bearer, (traitor) the lord in the endgame
//  - roams: stays in the zone, opens crates / grabs better gear, rebels hunt
//    the lord, loyalists escort the lord and revive a downed crown bearer
//  - uses 桃 when low, 酒 when downed, other items via ItemImplEx.botShouldUse,
//    Q/E/G per AbilityDef.aiHint, commands its squad to attack its target
import type { Vec3 } from '../../core/math';
import { Rng } from '../../core/rng';
import type { AbilitySlot, BotDifficulty, Entity, EntityId, InputFrame, RoleId } from '../../core/types';
import { BTN_ADS, BTN_FIRE, BTN_INTERACT, BTN_SPRINT, ITEM_SLOTS, emptyInput } from '../../core/types';
import { WEAPON_BY_ID } from '../../data';
import type { Rarity } from '../../data/types';
import type { BotBrain, SimApi } from '../api';
import { getAbility } from '../abilities/registry';
import { aimAnglesFor } from '../aim';
import { itemDef, lootKindOf } from '../defs';
import { ext } from '../ext';
import type { ItemImplEx } from '../ext';
import { getItem } from '../items/registry';
import { aimPointOf, dist2d, hasLineOfSight, isTargetable, pickTarget } from './perception';
import { steerTo } from './steer';
import { newIntent, resetIntent } from './types';

interface DiffCfg {
  /** seconds of looting before the bot starts hunting known-hostile roles (it always shoots back) */
  calm: number;
  aimErr: number;
  reaction: number;
  scan: number;
  abilityEvery: number;
  dodgeChance: number;
  headBias: number;
}

const DIFFICULTY: Record<BotDifficulty, DiffCfg> = {
  easy: { calm: 100, aimErr: 1.5, reaction: 0.6, scan: 0.5, abilityEvery: 6, dodgeChance: 0.1, headBias: 0 },
  normal: { calm: 75, aimErr: 0.8, reaction: 0.3, scan: 0.35, abilityEvery: 3.5, dodgeChance: 0.25, headBias: 0.1 },
  hard: { calm: 50, aimErr: 0.45, reaction: 0.18, scan: 0.25, abilityEvery: 2, dodgeChance: 0.45, headBias: 0.2 },
};

const RARITY_RANK: Record<Rarity, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };
const LORD_SIDE: ReadonlySet<RoleId> = new Set<RoleId>(['lord', 'loyalist', 'double']);
const SLOTS: AbilitySlot[] = ['q', 'e', 'lord'];

function toLocal(yaw: number, dx: number, dz: number): { mx: number; mz: number } {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return { mx: dx * rx + dz * rz, mz: dx * fx + dz * fz };
}

export class BasicBot implements BotBrain {
  private readonly rng: Rng;
  private readonly cfg: DiffCfg;
  private seq = 0;
  private readonly mem: Record<string, number> = {};
  private readonly intent = newIntent();
  private targetId?: EntityId;
  private targetSince = 0;
  private nextScan = 0;
  private goal: Vec3 | null = null;
  private goalUntil = 0;
  private aimErr: Vec3 = { x: 0, y: 0, z: 0 };
  private aimErrUntil = 0;
  private strafe = 1;
  private strafeUntil = 0;
  private nextAbilityAt: number;
  private nextItemAt = 0;
  private nextDodgeAt = 0;
  private nextLootScan = 0;
  private lootId?: EntityId;
  private lootSince = 0;
  /** loot we gave up on (unreachable / took too long) → until when */
  private readonly lootBlacklist = new Map<EntityId, number>();
  private lastHp = -1;
  private commandedTarget?: EntityId;
  private lastCommandAt = -99;
  private followOrdered = false;
  private nextClaimAt: number;
  private claimed = false;
  private firePulse = false;
  private interactPulse = 0;

  constructor(
    readonly seat: number,
    readonly difficulty: BotDifficulty,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.cfg = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
    this.nextAbilityAt = 2 + this.rng.next() * 3;
    this.nextClaimAt = 20 + this.rng.next() * 40;
  }

  think(sim: SimApi, self: Entity, dt: number): InputFrame {
    const f = emptyInput(++this.seq);
    f.actions = [];
    f.yaw = self.yaw;
    f.pitch = self.pitch;
    const h = self.hero;
    if (!h || h.dead) return f;
    const now = sim.time;

    if (h.downed) {
      this.downedThink(sim, self, f);
      return f;
    }
    const hurt = this.lastHp >= 0 && self.hp < this.lastHp - 0.5;
    this.lastHp = self.hp;

    // target acquisition
    const cur = this.targetId !== undefined ? sim.get(this.targetId) : undefined;
    if (now >= this.nextScan || !cur || !isTargetable(sim, self, cur)) {
      this.nextScan = now + this.cfg.scan;
      const t = this.pickTarget(sim, self);
      if (t?.id !== this.targetId) {
        this.targetId = t?.id;
        this.targetSince = now;
      }
    }
    const target = this.targetId !== undefined ? sim.get(this.targetId) : undefined;

    this.maybeClaim(sim, self, f);
    if (target && isTargetable(sim, self, target)) this.fight(sim, self, target, f, hurt);
    else {
      this.targetId = undefined;
      this.roam(sim, self, f);
    }
    this.useItems(sim, self, f, target);
    void dt;
    return f;
  }

  // ── perception ──────────────────────────────────────────────────────────
  private pickTarget(sim: SimApi, self: Entity): Entity | undefined {
    const x = ext(sim);
    const h = self.hero!;
    const attackers = new Set(x.recentAttackers(self.id, 8));
    const crowns = sim.heroes().filter((e) => !e.hero!.dead && sim.knownRole(e) === 'lord' && e !== self);
    const defendLord = LORD_SIDE.has(h.role) || (h.role === 'traitor' && this.aliveHeroes(sim) > 2);
    const lordAttackers = new Set<EntityId>();
    if (defendLord) for (const c of crowns) for (const a of x.recentAttackers(c.id, 8)) lordAttackers.add(a);
    if (h.role === 'lord') for (const a of x.recentAttackers(self.id, 10)) lordAttackers.add(a);
    const traitorEndgame = h.role === 'traitor' && this.aliveHeroes(sim) <= 2;
    const calm = sim.time < this.cfg.calm;
    const accept = (c: Entity): boolean => {
      if (sim.isOwnSide(self, c)) return false;
      const credit = x.creditOf(c.id);
      // early game: gear up; only fight whoever picks a fight (or aggressive NPCs)
      const provoked = attackers.has(c.id) || (credit !== undefined && attackers.has(credit)) || c.kind === 'npc';
      if (sim.isHostileTo(self, c) && (!calm || provoked)) return true;
      if (attackers.has(c.id) || (credit !== undefined && attackers.has(credit))) return true;
      if (lordAttackers.has(c.id) || (credit !== undefined && lordAttackers.has(credit))) {
        // never turn on a crown bearer we are defending
        return !(defendLord && crowns.includes(c));
      }
      if (traitorEndgame && c.kind === 'hero' && sim.knownRole(c) === 'lord') return true;
      if (c.kind === 'npc' && c.npc?.targetId === self.id) return true;
      if (c.kind === 'hero' && c.hero?.claim) {
        const claim = c.hero.claim;
        if (LORD_SIDE.has(h.role) && claim === 'rebel') return true;
        if (h.role === 'rebel' && (claim === 'loyalist' || claim === 'lord')) return true;
      }
      return false;
    };
    return pickTarget(
      sim,
      self,
      70,
      accept,
      (c) => (c.kind === 'hero' ? 6 : 0) + (attackers.has(c.id) ? 15 : 0) + (c.hp < c.maxHp * 0.3 ? 5 : 0),
      5,
    );
  }

  private aliveHeroes(sim: SimApi): number {
    let n = 0;
    for (const e of sim.heroes()) if (!e.hero!.dead) n++;
    return n;
  }

  // ── combat ──────────────────────────────────────────────────────────────
  private fight(sim: SimApi, self: Entity, target: Entity, f: InputFrame, hurt: boolean): void {
    const now = sim.time;
    const h = self.hero!;
    const x = ext(sim);
    const d = dist2d(self.pos, target.pos);
    const tp = aimPointOf(target);
    if (target.kind === 'hero' && !target.hero?.downed) tp.y += this.cfg.headBias * 1.2;
    if (now >= this.aimErrUntil) {
      const e = this.cfg.aimErr * (0.35 + d / 30);
      this.aimErr = { x: (this.rng.next() - 0.5) * 2 * e, y: (this.rng.next() - 0.5) * e, z: (this.rng.next() - 0.5) * 2 * e };
      this.aimErrUntil = now + 0.35 + this.rng.next() * 0.3;
    }
    const ap = { x: tp.x + this.aimErr.x, y: tp.y + this.aimErr.y, z: tp.z + this.aimErr.z };
    const ang = aimAnglesFor(self.pos, ap);
    f.yaw = ang.yaw;
    f.pitch = ang.pitch;
    f.aimPoint = ap;
    f.aimTargetId = target.id;

    // weapon management
    let w = x.activeWeapon(self.id);
    if (w && w.def.magSize > 0 && !w.def.melee && w.inst.mag <= 0 && w.inst.reserve <= 0) {
      const other = h.weapons.findIndex((wi, i) => i !== h.activeSlot && !!wi && (wi.mag > 0 || wi.reserve > 0));
      if (other >= 0) f.actions.push({ a: 'weapon', slot: other });
    }
    w = x.activeWeapon(self.id);
    const def = w?.def;
    const melee = !!def?.melee;
    const ideal = melee ? 1.4 : Math.max(6, Math.min(32, (def?.falloffStart ?? 20) * 0.9));
    const los = hasLineOfSight(sim, self, target);

    // movement: approach / keep distance / strafe
    resetIntent(this.intent);
    let mvx = 0;
    let mvz = 0;
    if (d > ideal + 4 || !los) {
      steerTo(sim, self, target.pos, this.mem, this.intent, melee ? 1 : 2);
      mvx = this.intent.moveX;
      mvz = this.intent.moveZ;
    } else if (d < ideal - 4 && !melee) {
      mvx = (self.pos.x - target.pos.x) / Math.max(1e-3, d);
      mvz = (self.pos.z - target.pos.z) / Math.max(1e-3, d);
    }
    if (now >= this.strafeUntil) {
      this.strafe = this.rng.next() < 0.5 ? -1 : 1;
      this.strafeUntil = now + 0.7 + this.rng.next() * 1.1;
    }
    if (!melee && los) {
      const px = -(target.pos.z - self.pos.z) / Math.max(1e-3, d);
      const pz = (target.pos.x - self.pos.x) / Math.max(1e-3, d);
      mvx += px * this.strafe * 0.8;
      mvz += pz * this.strafe * 0.8;
    }
    const ml = Math.hypot(mvx, mvz);
    if (ml > 1) {
      mvx /= ml;
      mvz /= ml;
    }
    const loc = toLocal(f.yaw, mvx, mvz);
    f.moveX = loc.mx;
    f.moveZ = loc.mz;
    if (this.intent.jump) f.actions.push({ a: 'jump' });

    // fire / reload / ADS
    if (w && w.def.magSize > 0 && !melee && w.inst.mag <= 0 && w.inst.reserve > 0) f.actions.push({ a: 'reload' });
    const inRange = def ? d <= (melee ? (def.melee?.range ?? 2) + 1 : def.maxRange * 1.05) : false;
    if (los && inRange && now - this.targetSince >= this.cfg.reaction && !h.channel) {
      if (def?.auto) f.buttons |= BTN_FIRE;
      else {
        this.firePulse = !this.firePulse;
        if (this.firePulse) f.buttons |= BTN_FIRE;
      }
    }
    if (los && d > 22 && !melee && this.difficulty !== 'easy') f.buttons |= BTN_ADS;

    // dodge when taking fire
    if (hurt && h.dodgeCharges > 0 && now >= this.nextDodgeAt && this.rng.chance(this.cfg.dodgeChance)) {
      f.actions.push({ a: 'dodge' });
      this.nextDodgeAt = now + 2.5;
    }
    // abilities
    if (now >= this.nextAbilityAt) {
      this.nextAbilityAt = now + this.cfg.abilityEvery * (0.6 + this.rng.next() * 0.8);
      this.tryAbility(sim, self, f, target, d, los, hurt);
    }
    // squad: attack my target
    if (h.squad.length > 0 && this.commandedTarget !== target.id && now - this.lastCommandAt > 1.5) {
      this.commandedTarget = target.id;
      this.lastCommandAt = now;
      this.followOrdered = false;
      f.actions.push({ a: 'command', order: 'attack' });
    }
  }

  private tryAbility(sim: SimApi, self: Entity, f: InputFrame, target: Entity | undefined, d: number, los: boolean, hurt: boolean): void {
    const h = self.hero!;
    const def = sim.heroDef(self);
    if (!def) return;
    for (const slot of SLOTS) {
      if (slot === 'lord' && h.role !== 'lord') continue;
      const ab = def.abilities.find((a) => a.slot === slot);
      if (!ab) continue;
      const impl = getAbility(ab.id);
      if (!impl?.activate) continue;
      const ready = ab.charges ? (h.charges[ab.id] ?? 0) > 0 : sim.cooldownLeft(self.id, ab.id) <= 0;
      if (!ready) continue;
      const range = ab.params.range ?? ab.params.dash ?? 25;
      let ok: boolean;
      switch (ab.aiHint) {
        case 'offense':
          ok = !!target && los && d <= Math.max(6, range + 2);
          break;
        case 'defense':
          ok = self.hp < self.maxHp * 0.55 && (!!target || hurt);
          break;
        case 'heal':
          ok = self.hp < self.maxHp * 0.6;
          break;
        case 'mobility':
          ok = (!!target && d > 15 && d < 45) || self.hp < self.maxHp * 0.3;
          break;
        case 'summon':
          ok = !!target;
          break;
        default:
          ok = !!target && this.rng.chance(0.5);
          break;
      }
      if (ok) {
        f.actions.push({ a: 'ability', slot });
        return;
      }
    }
  }

  // ── roaming ─────────────────────────────────────────────────────────────
  private roam(sim: SimApi, self: Entity, f: InputFrame): void {
    const now = sim.time;
    const h = self.hero!;
    if (h.squad.length > 0 && !this.followOrdered) {
      this.followOrdered = true;
      this.commandedTarget = undefined;
      f.actions.push({ a: 'command', order: 'follow' });
    }
    // reload while calm
    const w = ext(sim).activeWeapon(self.id);
    if (w && w.def.magSize > 0 && !w.def.melee && w.inst.mag < w.def.magSize * 0.5 && w.inst.reserve > 0 && h.reloadUntil <= now) {
      f.actions.push({ a: 'reload' });
    }

    let goal = this.reviveGoal(sim, self, f);
    let arrive = 1.2;
    if (!goal) goal = this.zoneGoal(sim, self);
    if (!goal) {
      const loot = this.lootGoal(sim, self, f);
      if (loot) {
        goal = loot;
        arrive = 0.6;
      }
    }
    if (!goal) {
      if (!this.goal || now >= this.goalUntil || dist2d(self.pos, this.goal) < 3) {
        this.goal = this.roleGoal(sim, self);
        this.goalUntil = now + 10 + this.rng.next() * 8;
      }
      goal = this.goal;
    }
    resetIntent(this.intent);
    const dist = steerTo(sim, self, goal, this.mem, this.intent, arrive);
    const mx = this.intent.moveX;
    const mz = this.intent.moveZ;
    if (Math.hypot(mx, mz) > 0.1) {
      const want = Math.atan2(-mx, -mz);
      f.yaw = turn(self.yaw, want, 0.25);
      f.pitch = 0;
      const loc = toLocal(f.yaw, mx, mz);
      f.moveX = loc.mx;
      f.moveZ = loc.mz;
      if (dist > 12 && loc.mz > 0.6) f.buttons |= BTN_SPRINT;
    }
    if (this.intent.jump) f.actions.push({ a: 'jump' });
  }

  /** Lord-side bots revive a downed crown bearer they can reach. */
  private reviveGoal(sim: SimApi, self: Entity, f: InputFrame): Vec3 | null {
    const h = self.hero!;
    if (!LORD_SIDE.has(h.role)) return null;
    if (!h.items.some((s) => s?.id === 'tao')) return null;
    for (const c of sim.heroes()) {
      if (c === self || !c.hero!.downed || c.hero!.dead || sim.knownRole(c) !== 'lord') continue;
      const d = dist2d(self.pos, c.pos);
      if (d > 35) continue;
      if (d < 2.2) {
        const ang = aimAnglesFor(self.pos, aimPointOf(c));
        f.yaw = ang.yaw;
        f.pitch = ang.pitch;
        f.aimTargetId = c.id;
        f.buttons |= BTN_INTERACT;
        if (!h.channel && sim.time >= this.interactPulse) {
          this.interactPulse = sim.time + 0.5;
          f.actions.push({ a: 'interact' });
        }
      }
      return c.pos;
    }
    return null;
  }

  private zoneGoal(sim: SimApi, self: Entity): Vec3 | null {
    const z = ext(sim).zoneView();
    const soon = z.shrinkStart - sim.time < 25;
    const c = soon ? z.targetCenter : z.center;
    const r = soon ? z.targetRadius : z.radius;
    const d = dist2d(self.pos, c);
    if (d > Math.max(0, r - 6)) return { x: c.x, y: self.pos.y, z: c.z };
    return null;
  }

  private lootGoal(sim: SimApi, self: Entity, f: InputFrame): Vec3 | null {
    const now = sim.time;
    const h = self.hero!;
    let loot = this.lootId !== undefined ? sim.get(this.lootId) : undefined;
    if (loot && !this.wantsLoot(sim, self, loot)) loot = undefined;
    if (loot) {
      // give up on loot we cannot reach (e.g. on a bridge deck above us) or that takes too long
      const flat = dist2d(self.pos, loot.pos);
      const stuckBelow = flat < 3 && Math.abs(loot.pos.y - self.pos.y) > 1.6;
      if (now - this.lootSince > 20 || (stuckBelow && now - this.lootSince > 4)) {
        this.lootBlacklist.set(loot.id, now + 90);
        loot = undefined;
      }
    }
    if (!loot && now >= this.nextLootScan) {
      this.nextLootScan = now + 1 + this.rng.next();
      let best: Entity | undefined;
      let bd = 40;
      for (const e of sim.queryRadius(self.pos, 40, { kinds: ['crate', 'airdrop', 'loot'] })) {
        if ((this.lootBlacklist.get(e.id) ?? 0) > now || !this.wantsLoot(sim, self, e)) continue;
        const d = dist2d(self.pos, e.pos) + Math.abs(e.pos.y - self.pos.y) * 2 - (e.kind === 'airdrop' ? 15 : 0);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      loot = best;
      if (loot) this.lootSince = now;
    }
    this.lootId = loot?.id;
    if (!loot) return null;
    const d = dist2d(self.pos, loot.pos);
    if (d < 2.3 && Math.abs(loot.pos.y - self.pos.y) < 1.6 && (loot.kind !== 'loot' || !this.isConsumable(loot))) {
      const ang = aimAnglesFor(self.pos, loot.pos);
      f.yaw = ang.yaw;
      f.pitch = ang.pitch;
      if (!h.channel && now >= this.interactPulse) {
        this.interactPulse = now + 1.2;
        f.actions.push({ a: 'interact' });
      }
    }
    return loot.pos;
  }

  private isConsumable(l: Entity): boolean {
    const id = l.loot?.itemId;
    return !!id && lootKindOf(id) === 'item';
  }

  private wantsLoot(sim: SimApi, self: Entity, e: Entity): boolean {
    if (!e.alive) return false;
    const h = self.hero!;
    if (e.kind === 'crate' || e.kind === 'airdrop') return !!e.crate && !e.crate.opened && e.onGround;
    const lo = e.loot;
    if (!lo) return false;
    if (lo.weaponId) {
      const cur = h.weapons[0];
      const nw = WEAPON_BY_ID[lo.weaponId];
      if (!nw || nw.class === 'pistol') return false;
      const cw = cur ? WEAPON_BY_ID[cur.id] : undefined;
      if (!cw) return true;
      return RARITY_RANK[nw.rarity] > RARITY_RANK[cw.rarity];
    }
    const id = lo.itemId;
    if (!id) return false;
    const kind = lootKindOf(id);
    if (kind === 'armor') return !h.armor;
    if (kind === 'mount') return !h.mount;
    if (kind !== 'item') return false;
    const max = itemDef(id)?.maxStack ?? 1;
    return h.items.some((s) => !s || (s.id === id && s.count < max));
  }

  private roleGoal(sim: SimApi, self: Entity): Vec3 {
    const h = self.hero!;
    const crowns = sim.heroes().filter((e) => e !== self && !e.hero!.dead && sim.knownRole(e) === 'lord');
    const lord = crowns[0];
    if (lord) {
      if (h.role === 'rebel' && sim.time > this.cfg.calm) return { ...lord.pos };
      if ((h.role === 'loyalist' || h.role === 'double') && dist2d(self.pos, lord.pos) > 18) return { ...lord.pos };
    }
    // wander inside the (next) zone
    const zone = ext(sim).zoneView();
    const c = zone.targetCenter;
    const r = Math.max(5, zone.targetRadius * 0.6);
    const a = this.rng.next() * Math.PI * 2;
    const d = r * Math.sqrt(this.rng.next());
    return { x: c.x + Math.cos(a) * d, y: self.pos.y, z: c.z + Math.sin(a) * d };
  }

  // ── items / downed / claims ─────────────────────────────────────────────
  private useItems(sim: SimApi, self: Entity, f: InputFrame, target: Entity | undefined): void {
    const now = sim.time;
    const h = self.hero!;
    if (now < this.nextItemAt || h.channel || sim.hasStatus(self.id, 'silence')) return;
    for (let slot = 0; slot < ITEM_SLOTS; slot++) {
      const s = h.items[slot];
      if (!s) continue;
      const impl = getItem(s.id) as ItemImplEx | undefined;
      const def = itemDef(s.id);
      if (!impl || !def) continue;
      let should: boolean;
      if (impl.botShouldUse) should = impl.botShouldUse(sim, self);
      else {
        const d = target ? dist2d(self.pos, target.pos) : Infinity;
        switch (def.aiHint) {
          case 'heal':
            should = self.hp < self.maxHp * 0.5;
            break;
          case 'offense':
            should = !!target && d <= Math.max(4, def.range) && f.aimTargetId === target.id;
            break;
          case 'defense':
            should = !!target && self.hp < self.maxHp * 0.6;
            break;
          case 'summon':
            should = !!target && d < 35;
            break;
          default:
            should = !!target && this.rng.chance(0.05);
            break;
        }
      }
      if (should) {
        // never waste a 桃 reviving the downed enemy we are aiming at
        if (impl.canRevive && f.aimTargetId !== undefined && sim.get(f.aimTargetId)?.hero?.downed) f.aimTargetId = undefined;
        f.actions.push({ a: 'item', slot });
        this.nextItemAt = now + 1.5;
        return;
      }
    }
  }

  private downedThink(sim: SimApi, self: Entity, f: InputFrame): void {
    const h = self.hero!;
    const now = sim.time;
    const jiu = h.items.findIndex((s) => s?.id === 'jiu');
    if (jiu >= 0 && now >= this.nextItemAt) {
      f.actions.push({ a: 'item', slot: jiu });
      this.nextItemAt = now + 1;
    }
    // crawl away from the nearest hostile
    const threat = pickTarget(sim, self, 30, (e) => sim.isHostileTo(self, e), undefined, 1);
    if (threat) {
      const dx = self.pos.x - threat.pos.x;
      const dz = self.pos.z - threat.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      f.yaw = Math.atan2(-dx / l, -dz / l);
      f.moveZ = 1;
    }
  }

  private maybeClaim(sim: SimApi, self: Entity, f: InputFrame): void {
    if (this.claimed || sim.time < this.nextClaimAt) return;
    this.claimed = true;
    const role = self.hero!.role;
    if (role === 'loyalist' || role === 'traitor') f.actions.push({ a: 'claim', role: 'loyalist' });
    else if (role === 'rebel' && this.rng.chance(0.5)) f.actions.push({ a: 'claim', role: 'rebel' });
  }
}

function turn(cur: number, target: number, maxStep: number): number {
  let d = (target - cur) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

/** Default BotBrainFactory. */
export function createBasicBot(seat: number, difficulty: BotDifficulty, seed: number): BotBrain {
  return new BasicBot(seat, difficulty, seed);
}
