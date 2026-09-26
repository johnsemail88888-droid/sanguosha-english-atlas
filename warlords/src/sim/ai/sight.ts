// Per-bot "last seen" memory of the other heroes. A bot only knows where a
// hero is (and how hurt it is) the way a human in its seat would:
//  - eye:  the hero is not hidden by stealth (SimExt.canSee), within the bot's
//          vision range and in line of sight → position + HP (nameplate);
//  - map:  the hero is drawn on the minimap (ui/hud/minimap.ts drawMarkers):
//          crowns, heroes whose role this seat knows (the dead / the lord's
//          影武者), marked heroes and exposed (revealed to everyone, or
//          privately to this bot) heroes — unless stealth hides them → position;
//  - felt: it just hit this bot and is not hidden (the HUD's damage-direction
//          indicator) → position.
// Everything the AI asks about another hero's position or HP goes through
// here (BotView.posOf / hpFrac / seesNow); nothing reads sim.heroes()
// positions directly. Refreshed on the bot's scan cadence (a handful of LOS
// rays per bot per refresh).
import type { Vec3 } from '../../core/math';
import type { Entity, EntityId } from '../../core/types';
import type { SimApi } from '../api';
import { ext } from '../ext';
import { revealedTo } from '../status';
import { roleKnownTo, wearsCrown } from './knowledge';
import { aimPointOf } from './perception';

export interface Sighting {
  /** last known position (a copy) */
  pos: Vec3;
  /** sim time the position was last known (eye, map or felt) */
  posAt: number;
  /** last HP / max HP seen on the nameplate (eye only) */
  hp: number;
  maxHp: number;
  /** sim time HP was last seen (-Infinity: never) */
  hpAt: number;
  /** sim time the hero was last seen with the eyes (-Infinity: never) */
  eyeAt: number;
  /** sim time the hero was last on this bot's minimap (-Infinity: never) */
  mapAt: number;
}

/** How long a "seen now" answer stays valid after a refresh (s). */
const NOW_SLACK = 0.25;
/** Attackers within this window reveal their position through the damage indicator. */
const FELT_WINDOW = 1;

export class Sight {
  private readonly mem = new Map<EntityId, Sighting>();
  private nextAt = 0;
  private every = 0.33;
  private now = 0;

  /** Refresh on a cadence (`every` s); `force` refreshes immediately. */
  refresh(sim: SimApi, self: Entity, visionRange: number, every: number, force = false): void {
    const now = sim.time;
    this.now = now;
    this.every = every;
    if (!force && now < this.nextAt) return;
    this.nextAt = now + every;
    const x = ext(sim);
    const eye = sim.eyePos(self);
    const felt = new Set<EntityId>();
    for (const a of x.recentAttackers(self.id, FELT_WINDOW)) {
      const c = x.creditOf(a);
      if (c !== undefined) felt.add(c);
    }
    for (const e of sim.heroes()) {
      if (e === self || !e.hero) continue;
      if (e.hero.dead) {
        // deaths are public (kill feed); the body tells nothing more
        this.mem.delete(e.id);
        continue;
      }
      const notHidden = x.canSee(self, e);
      const stealthed = sim.hasStatus(e.id, 'stealth') && !sim.isOwnSide(self, e) && !revealedTo(e, self.id, now);
      const onMap =
        !stealthed &&
        (wearsCrown(sim, e) || roleKnownTo(sim, self, e) !== undefined || sim.hasStatus(e.id, 'marked') || revealedTo(e, self.id, now));
      let byEye = false;
      if (notHidden) {
        const dx = e.pos.x - self.pos.x;
        const dy = e.pos.y - self.pos.y;
        const dz = e.pos.z - self.pos.z;
        if (dx * dx + dy * dy + dz * dz <= visionRange * visionRange) {
          byEye = sim.lineOfSight(eye, aimPointOf(e)) || sim.lineOfSight(eye, sim.eyePos(e));
        }
      }
      const byFeel = notHidden && felt.has(e.id);
      if (byEye) this.noteEye(e, now);
      else if (onMap || byFeel) this.notePos(e, now);
      if (onMap) this.mem.get(e.id)!.mapAt = now;
    }
  }

  /** Record a hero seen with the eyes right now (position + HP). */
  noteEye(e: Entity, now: number): void {
    const s = this.notePos(e, now);
    s.hp = e.hp;
    s.maxHp = Math.max(1, e.maxHp);
    s.hpAt = now;
    s.eyeAt = now;
  }

  private notePos(e: Entity, now: number): Sighting {
    let s = this.mem.get(e.id);
    if (!s) {
      s = { pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z }, posAt: now, hp: e.maxHp, maxHp: Math.max(1, e.maxHp), hpAt: -Infinity, eyeAt: -Infinity, mapAt: -Infinity };
      this.mem.set(e.id, s);
    } else {
      s.pos.x = e.pos.x;
      s.pos.y = e.pos.y;
      s.pos.z = e.pos.z;
      s.posAt = now;
    }
    return s;
  }

  /** Everything this bot remembers about hero `id` (undefined: never seen). */
  get(id: EntityId): Sighting | undefined {
    return this.mem.get(id);
  }

  /** Seen with the eyes at the latest refresh. */
  seesNow(id: EntityId): boolean {
    const s = this.mem.get(id);
    return !!s && this.now - s.eyeAt <= this.every + NOW_SLACK;
  }

  /** Seen with the eyes within `maxAge` seconds. */
  seenWithin(id: EntityId, maxAge: number): boolean {
    const s = this.mem.get(id);
    return !!s && this.now - s.eyeAt <= maxAge;
  }

  /** Position known (eye / map / felt) at the latest refresh. */
  locatedNow(id: EntityId): boolean {
    const s = this.mem.get(id);
    return !!s && this.now - s.posAt <= this.every + NOW_SLACK;
  }

  /** Last known position if it is at most `maxAge` seconds old. */
  lastPos(id: EntityId, maxAge = Infinity): Vec3 | undefined {
    const s = this.mem.get(id);
    return s && this.now - s.posAt <= maxAge ? s.pos : undefined;
  }

  /** Seconds since the position of `id` was last known (Infinity: never). */
  posAge(id: EntityId): number {
    const s = this.mem.get(id);
    return s ? this.now - s.posAt : Infinity;
  }

  /** Last HP fraction seen on the nameplate (1 when never seen: assume healthy). */
  hpFrac(id: EntityId): number {
    const s = this.mem.get(id);
    return s && s.hpAt > -Infinity ? s.hp / s.maxHp : 1;
  }
}
