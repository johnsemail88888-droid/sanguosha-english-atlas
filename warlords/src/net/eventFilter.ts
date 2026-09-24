// Per-recipient filtering of sim events (GAME_SPEC §11 hidden information).
//
// SimHost.drainEvents() returns every event of the tick. Most are public (they
// drive VFX / audio / kill feed for everyone), but some carry hidden
// information and may only reach the player they concern:
//   - any event with `privateTo` set (core/types EventRouting), e.g. the
//     'status' events of a private 'reveal' (诸葛亮 观星, 司马懿 狼顾);
//   - { t:'reward', kind:'bounty' } — only the 赏金猎人 can complete a bounty,
//     so anyone who saw it would learn who the hunter is. Treated as private
//     to `who` even when the sim does not set privateTo.
// Every event leaving the host (network fan-out and the host's own LocalView)
// passes through here.
import type { EntityId, GameEvent } from '../core/types';

/**
 * The only entity allowed to receive `ev`, or null when the event is public.
 * Keep this list in sync with the sim's emit() calls that carry private info.
 */
export function privateRecipient(ev: GameEvent): EntityId | null {
  if (ev.privateTo !== undefined && ev.privateTo !== null) return ev.privateTo;
  if (ev.t === 'reward' && ev.kind === 'bounty') return ev.who;
  return null;
}

/** True when some event in the batch must not be broadcast as-is. */
export const hasPrivateEvents = (events: readonly GameEvent[]): boolean => events.some((e) => privateRecipient(e) !== null);

/**
 * Events `viewer` may receive, in their original order. `viewer` null = a
 * spectator / nobody in particular: only public events.
 */
export function filterEventsFor(events: readonly GameEvent[], viewer: EntityId | null): GameEvent[] {
  const out: GameEvent[] = [];
  for (const ev of events) {
    const to = privateRecipient(ev);
    if (to === null || (viewer !== null && to === viewer)) out.push(ev);
  }
  return out;
}
