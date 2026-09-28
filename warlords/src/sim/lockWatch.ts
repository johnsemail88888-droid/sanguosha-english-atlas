// Homing-rocket locks as events (weapons spec C8): once per tick the world's
// projHoming table (方天画戟's rockets and whoever they home on) is compared with
// the previous tick's, and every lock that began or ended becomes a public
// { t: 'lock' } event — the locked hero's HUD shows a warning toward the shooter
// and plays a two-beep cue until the lock ends (the rocket hit, burst, expired,
// or a dodge roll cleared its homing); the shooter hears a lock tone. However
// combat.ts picks, retargets or clears locks, this sees the result.
import type { EntityId } from '../core/types';
import type { World } from './world';

interface Seen {
  src: EntityId;
  target: EntityId;
}

const seenBy = new WeakMap<World, Map<EntityId, Seen>>();

/** Emit a 'lock' event for every homing lock that started or ended since the last call. */
export function emitLockChanges(w: World): void {
  const now = w.projHoming;
  let seen = seenBy.get(w);
  if (!seen) {
    if (now.size === 0) return;
    seen = new Map();
    seenBy.set(w, seen);
  }
  if (now.size === 0 && seen.size === 0) return;
  // ended (or moved to another target)
  for (const [proj, s] of seen) {
    const cur = now.get(proj);
    if (cur && cur.targetId === s.target) continue;
    w.emit({ t: 'lock', src: s.src, target: s.target, proj, on: false });
    seen.delete(proj);
  }
  // began
  for (const [proj, h] of now) {
    if (seen.has(proj)) continue;
    const src = w.get(proj)?.ownerId;
    if (src === undefined) continue;
    seen.set(proj, { src, target: h.targetId });
    w.emit({ t: 'lock', src, target: h.targetId, proj, on: true });
  }
}
