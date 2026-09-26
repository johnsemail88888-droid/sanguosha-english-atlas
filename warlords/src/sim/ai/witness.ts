// What ONE bot has witnessed. The shared WorldObserver logs every public
// observation of the world; a Witness keeps only the ones a human in this
// bot's seat would have noticed:
//  - public by nature: the kill feed (death + revealed role), claims and
//    quick-chat (chat log), lord-skill casts it saw;
//  - its own fights: hits on itself or its squad (by an attacker that is not
//    hidden by stealth — the HUD's damage direction), hits it dealt;
//  - everything else only when it saw the acting hero with its own eyes
//    (Sight: vision range + line of sight + not stealthed) at that moment.
// From the kept events it maintains the per-pair memories the strategies ask
// about (who has been hurting whom recently, who shot whom last) and the recent
// quick-chat lines (集火此人 / 需要桃 / 保护主公 / 跟我来 …).
import type { EntityId } from '../../core/types';
import type { SimApi } from '../api';
import { ext } from '../ext';
import type { ObsEvent, WorldObserver } from './observer';
import type { Sight } from './sight';

/** decay time constant (s) of the per-pair damage memory */
const PAIR_DECAY = 4;
/** an actor seen this recently counts as seen acting */
const ACT_SEEN = 0.7;
const CHAT_MEMORY = 20;

export interface ChatLine {
  who: EntityId;
  id: string;
  time: number;
}

export class Witness {
  private cursor = 0;
  private readonly lastAttack = new Map<number, number>();
  private readonly pairDmg = new Map<number, { v: number; n: number; t: number }>();
  private readonly chats: ChatLine[] = [];
  private readonly perceived: ObsEvent[] = [];

  /**
   * Consume the observer's new events and keep the perceived ones (returned,
   * oldest first; the array is reused — copy it to keep it).
   */
  consume(sim: SimApi, selfId: EntityId, obs: WorldObserver, sight: Sight): readonly ObsEvent[] {
    const out = this.perceived;
    out.length = 0;
    const events = obs.since(this.cursor);
    if (events.length === 0) return out;
    this.cursor = events[events.length - 1].seq;
    const x = ext(sim);
    const self = sim.get(selfId);
    for (const ev of events) {
      if (!this.perceives(sim, x, self, selfId, ev, sight)) continue;
      out.push(ev);
      this.remember(ev);
    }
    return out;
  }

  private perceives(sim: SimApi, x: ReturnType<typeof ext>, self: ReturnType<SimApi['get']>, selfId: EntityId, ev: ObsEvent, sight: Sight): boolean {
    if (ev.public) return true;
    if (ev.actor === selfId) return true;
    if (ev.target === selfId) {
      // hit / healed / revived by someone: known unless the actor is hidden in stealth
      if (ev.actor === undefined) return true;
      const a = sim.get(ev.actor);
      return !a || !self || x.canSee(self, a);
    }
    if (ev.actor === undefined) return false;
    return sight.seenWithin(ev.actor, ACT_SEEN);
  }

  private remember(ev: ObsEvent): void {
    if (ev.kind === 'quickchat' && ev.actor !== undefined && ev.chat) {
      this.chats.push({ who: ev.actor, id: ev.chat, time: ev.time });
      while (this.chats.length > 0 && ev.time - this.chats[0].time > CHAT_MEMORY) this.chats.shift();
      return;
    }
    if (ev.kind !== 'attack' || ev.actor === undefined || ev.field) return;
    // squad fire counts half (soldiers pick fights through the world's hostility rules); a
    // blocked hit is intent without damage
    const amount = ev.blocked ? 0 : ev.viaSquad ? ev.amount * 0.5 : ev.amount;
    const key = ev.actor * 65536 + ev.target;
    this.lastAttack.set(key, ev.time);
    const p = this.pairDmg.get(key);
    if (p) {
      const k = Math.exp(-(ev.time - p.t) / PAIR_DECAY);
      p.v = p.v * k + amount;
      p.n = p.n * k + (ev.blocked ? 0.5 : 1);
      p.t = ev.time;
    } else {
      this.pairDmg.set(key, { v: amount, n: ev.blocked ? 0.5 : 1, t: ev.time });
    }
  }

  /** Recent damage `actor` was seen dealing to `target` (decaying, ~4 s memory). */
  recentDamage(sim: SimApi, actor: EntityId, target: EntityId): number {
    const p = this.pairDmg.get(actor * 65536 + target);
    return p ? p.v * Math.exp(-(sim.time - p.t) / PAIR_DECAY) : 0;
  }

  /** Recent number of separate hits `actor` was seen landing on `target` (decaying like recentDamage). */
  recentHits(sim: SimApi, actor: EntityId, target: EntityId): number {
    const p = this.pairDmg.get(actor * 65536 + target);
    return p ? p.n * Math.exp(-(sim.time - p.t) / PAIR_DECAY) : 0;
  }

  /** Seconds since `actor` was last seen hurting `target` (Infinity if never). */
  sinceAttack(sim: SimApi, actor: EntityId, target: EntityId): number {
    const t = this.lastAttack.get(actor * 65536 + target);
    return t === undefined ? Infinity : sim.time - t;
  }

  /** The latest quick-chat line `id` heard within `maxAge` s (optionally from `who`). */
  heard(sim: SimApi, id: string, maxAge: number, who?: EntityId): ChatLine | undefined {
    for (let i = this.chats.length - 1; i >= 0; i--) {
      const c = this.chats[i];
      if (sim.time - c.time > maxAge) break;
      if (c.id === id && (who === undefined || c.who === who)) return c;
    }
    return undefined;
  }

  /** Recent quick-chat lines (oldest first). */
  recentChats(): readonly ChatLine[] {
    return this.chats;
  }
}
