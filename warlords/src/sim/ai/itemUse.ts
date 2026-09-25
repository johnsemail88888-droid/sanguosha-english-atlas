// Item (三国杀 card) use for bots. ItemImplEx.botShouldUse (when an item
// provides it) is the gate for "is this sensible for me right now"; this module
// adds the targeting (who / where to throw it) and the tactical timing the
// gate cannot know (don't channel a 桃 in the open under fire, keep a 桃 to
// revive the lord, trap a charging enemy…). Items without the hook fall back
// to ItemDef.aiHint + targeting.
import type { Vec3 } from '../../core/math';
import type { Entity } from '../../core/types';
import type { ItemDef } from '../../data/types';
import { aimAnglesFor } from '../aim';
import { itemDef } from '../defs';
import type { ItemImplEx } from '../ext';
import { getItem } from '../items/registry';
import type { BotView, ItemPlan } from './botTypes';
import { areaClear, wildSummonClear } from './abilityUse';
import { aimPointOf, dist2d } from './perception';

const FAIL_BACKOFF = 4;

export class ItemUser {
  private readonly backoff = new Map<string, number>();
  private pending: { id: string; slot: number; count: number; at: number } | null = null;
  /** items used this match (metrics) */
  used = 0;

  consider(v: BotView, opts: { reserveTao: boolean; healAt: number }): ItemPlan | null {
    const { sim, self, now } = v;
    const h = self.hero!;
    this.checkPending(v);
    if (h.channel) return null;
    if (!h.downed && (sim.hasStatus(self.id, 'silence') || sim.hasStatus(self.id, 'stun'))) return null;
    for (let slot = 0; slot < h.items.length; slot++) {
      const st = h.items[slot];
      if (!st) continue;
      if ((this.backoff.get(st.id) ?? 0) > now) continue;
      const def = itemDef(st.id);
      const impl = getItem(st.id) as ItemImplEx | undefined;
      if (!def || !impl) continue;
      if (h.downed && !impl.usableWhileDowned) continue;
      let gate: boolean | undefined;
      if (impl.botShouldUse) {
        try {
          gate = impl.botShouldUse(sim, self) === true;
        } catch {
          gate = false;
        }
      }
      const plan = this.plan(v, slot, st.id, def, gate, opts);
      if (plan) {
        this.pending = { id: st.id, slot, count: st.count, at: now };
        return plan;
      }
    }
    return null;
  }

  private checkPending(v: BotView): void {
    const p = this.pending;
    if (!p) return;
    const h = v.self.hero!;
    if (h.channel && h.channel.kind === 'item') return; // still channelling
    if (v.now - p.at < 0.15) return;
    this.pending = null;
    const st = h.items[p.slot];
    const consumed = !st || st.id !== p.id || st.count < p.count;
    if (consumed) this.used++;
    else this.backoff.set(p.id, v.now + FAIL_BACKOFF);
  }

  private plan(v: BotView, slot: number, id: string, def: ItemDef, gate: boolean | undefined, opts: { reserveTao: boolean; healAt: number }): ItemPlan | null {
    const { self, sim } = v;
    const h = self.hero!;
    const hpFrac = self.hp / Math.max(1, self.maxHp);
    const t = v.target;
    const d = v.targetDist;
    const fighting = !!t && v.targetLos && d < 50;
    const base: ItemPlan = { slot, itemId: id };
    if (h.downed) {
      // 酒 (or anything usable while downed): get back up
      return gate !== false ? base : null;
    }
    if (gate === false) return null;
    // specific cards first
    switch (id) {
      case 'tao': {
        if (hpFrac >= opts.healAt) return null;
        const count = h.items.filter((s) => s?.id === 'tao').reduce((n, s) => n + s!.count, 0);
        if (opts.reserveTao && count <= 1 && hpFrac > 0.3) return null;
        // channel 1.2 s: prefer a lull, unless desperate
        const lull = v.now - v.lastHurtAt > 1.2;
        return lull || hpFrac < 0.25 ? this.selfUse(base) : null;
      }
      case 'jiu':
        return fighting && d <= (v.weapon?.falloffStart ?? 20) * 1.5 && !sim.hasStatus(self.id, 'drunk') ? base : null;
      case 'shan':
        return h.dodgeCharges < 2 && (fighting || gate === true) ? base : null;
      case 'wuxie':
        return fighting && t?.kind === 'hero' && !sim.hasStatus(self.id, 'nullify') ? base : null;
      case 'sha':
        return gate === true || (gate === undefined && this.lowAmmo(v)) ? base : null;
      case 'taoyuan': {
        if (hpFrac > 0.65) return null;
        let friends = 0;
        let foes = 0;
        const r = def.params.radius ?? 15;
        for (const e of sim.heroes()) {
          if (e === self || !e.hero || e.hero.dead || dist2d(e.pos, self.pos) > r) continue;
          if (v.allyScore(e) > 0.5) friends++;
          else if (v.hostility(e) > 0.4) foes++;
        }
        return foes <= friends ? base : null;
      }
      case 'wuzhong':
      case 'wugu':
        return !fighting && h.items.some((s) => !s) ? base : null;
      case 'zhengbing':
        // the card's own hint knows the squad cap / over-cap allowance
        return gate === true || (gate === undefined && (h.squad.length < 4 || fighting)) ? base : null;
      default:
        break;
    }
    switch (def.targeting) {
      case 'enemy': {
        if (!t || !v.targetLos || d > def.range) return null;
        // only duel when winning (unless the card's own hint already judged the fight fair)
        if (id === 'juedou' && gate !== true && hpFrac < t.hp / Math.max(1, t.maxHp) + 0.1) return null;
        if (id === 'jiedao' && (t.kind !== 'hero' || (t.hero?.squad.length ?? 0) < 2)) return null;
        return this.aimAt(v, base, t);
      }
      case 'point':
      case 'direction': {
        if (!t || !v.targetLos) return null;
        if (def.aiHint === 'defense') {
          // traps: drop them in the path of a close enemy
          if (d > 10) return null;
          const mid = { x: (self.pos.x + t.pos.x) / 2, y: t.pos.y, z: (self.pos.z + t.pos.z) / 2 };
          return this.aimPointAt(v, base, dist2d(self.pos, mid) <= def.range ? mid : t.pos);
        }
        if (d > def.range) return null;
        if (id === 'guohe' && t.kind === 'hero' && !t.hero?.armor && !t.hero?.mount && t.shield <= 0) return null;
        if (id === 'shandian' && d < 12) return null;
        if (id === 'tiesuo') {
          const r = def.params.radius ?? 6;
          const n = v.threats.filter((x) => dist2d(x.e.pos, t.pos) <= r && x.hostility >= 0.45).length;
          if (n < 2) return null;
        }
        const pt = { x: t.pos.x + t.vel.x * 0.4, y: t.pos.y, z: t.pos.z + t.vel.z * 0.4 };
        if (!areaClear(v, def.params, 'point', pt, t.id, def.range)) return null;
        if (def.aiHint === 'summon' && !wildSummonClear(v, pt, t.id)) return null;
        return this.aimPointAt(v, base, pt);
      }
      case 'ally': {
        const ally = v.allies().find((a) => a !== self && !a.hero?.downed && a.hp < a.maxHp * 0.6 && dist2d(a.pos, self.pos) <= def.range);
        if (ally) return this.aimAt(v, base, ally);
        return hpFrac < 0.6 ? base : null;
      }
      default:
        break;
    }
    // self-targeted by hint
    switch (def.aiHint) {
      case 'heal':
        return hpFrac < opts.healAt ? base : null;
      case 'defense':
        return fighting && (v.underFire > 0.08 || gate === true) ? base : null;
      case 'offense':
        return fighting ? base : null;
      case 'summon':
        return fighting || (!!t && d < 40) ? base : null;
      default:
        return gate === true || (!fighting && v.rng.next() < 0.1) ? base : null;
    }
  }

  private lowAmmo(v: BotView): boolean {
    const w = v.x.activeWeapon(v.self.id);
    if (!w || w.def.magSize <= 0) return false;
    return w.inst.reserve < w.def.magSize * 1.2;
  }

  private selfUse(base: ItemPlan): ItemPlan {
    // make sure no downed hero is under the crosshair (a 桃 would revive them)
    return { ...base, aimTargetId: undefined };
  }

  private aimAt(v: BotView, base: ItemPlan, e: Entity): ItemPlan {
    const pt = aimPointOf(e);
    const ang = aimAnglesFor(v.self.pos, pt);
    return { ...base, yaw: ang.yaw, pitch: ang.pitch, aimPoint: pt, aimTargetId: e.id };
  }

  private aimPointAt(v: BotView, base: ItemPlan, pt: Vec3): ItemPlan {
    const p = { x: pt.x, y: pt.y + 0.3, z: pt.z };
    const ang = aimAnglesFor(v.self.pos, p);
    return { ...base, yaw: ang.yaw, pitch: ang.pitch, aimPoint: p, aimTargetId: undefined };
  }
}
