// Scans everything a client received for hidden-role leaks (GAME_SPEC §11:
// "snapshots never contain another player's role unless it is public").
//
// A role string is legitimate when it is:
//  - the receiver's own role (role card, private HUD view, own entity / player row,
//    the receiver's own bounty reward);
//  - the role of an entity that is public by now: dead, or flagged VF_REVEALED in
//    the snapshot carrying it, or announced by a 'death' event earlier in the log;
//  - a public claim (跳身份 — may be a lie, but it is what the player said);
//  - 'double' shown to the lord (the lord knows its decoy).
// Everything after 'gameOver' is ignored: all roles are revealed at the end.
import type { HostMsg } from '../../../src/net/protocol';
import { BIN_SNAPSHOT } from '../../../src/net/protocol';
import { SnapshotReceiver, StringTable } from '../../../src/net/codec';
import { VF_DEAD, VF_REVEALED, type RoleId, type Snapshot } from '../../../src/core/types';
import type { Payload } from '../../../src/net/transport';
import { HIDDEN_ROLES } from './fixtures';

type Obj = Record<string, unknown>;

/** Decode everything a client received and report any hidden role that is not its own or public. */
export function scanForLeaks(log: Payload[], myRole: RoleId, myId: string): string[] {
  const out: string[] = [];
  let rx: SnapshotReceiver | null = null;
  let myEntity: number | null = null;
  /** entities whose role became public (death / reveal) */
  const revealed = new Set<number>();

  /** the object describes the receiver's own hero / player row */
  const isOwn = (parent: Obj | null): boolean =>
    !!parent && ((myEntity !== null && (parent.id === myEntity || parent.entityId === myEntity)) || parent.playerId === myId);

  /** the object describes a hero whose role is public by now */
  const isPublicRoleHolder = (parent: Obj | null): boolean => {
    if (!parent) return false;
    // snapshot entity whose role is public
    if (typeof parent.id === 'number' && typeof parent.kind === 'string' && typeof parent.flags === 'number') {
      if ((parent.flags & (VF_DEAD | VF_REVEALED)) !== 0 || revealed.has(parent.id)) return true;
    }
    // public player row of a dead / revealed hero
    if (typeof parent.entityId === 'number' && typeof parent.playerId === 'string') {
      if (parent.alive === false || revealed.has(parent.entityId)) return true;
    }
    // death events reveal the victim's role by design
    if (parent.t === 'death') return true;
    return false;
  };

  const visit = (v: unknown, path: string, parent: Obj | null, key: string): void => {
    if (typeof v === 'string') {
      if (!(HIDDEN_ROLES as string[]).includes(v)) return;
      if (v === myRole && (key === 'yourRole' || path.startsWith('you.'))) return;
      if (key === 'claim' || (parent?.t === 'claim' && key === 'role')) return; // public claim
      if (v === 'double' && myRole === 'lord') return; // the lord knows its decoy
      if (key === 'role' && (isOwn(parent) ? v === myRole : isPublicRoleHolder(parent))) return;
      // your own bounty reward (anyone else seeing it learns who the hunter is)
      if (parent?.t === 'reward' && key === 'kind' && v === 'bounty' && myRole === 'bounty' && parent.who === myEntity) return;
      out.push(`${path}=${v}`);
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${path}[${i}]`, parent, key));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) visit(x, path ? `${path}.${k}` : k, v as Obj, k);
    }
  };

  const noteSnapshot = (s: Snapshot): void => {
    for (const e of s.ents) if (e.kind === 'hero' && (e.flags & VF_DEAD) !== 0) revealed.add(e.id);
    for (const p of s.players) if (!p.alive) revealed.add(p.entityId);
  };

  for (const p of log) {
    if (typeof p === 'string') {
      const m = JSON.parse(p) as HostMsg;
      if (m.t === 'gameOver') break; // roles are revealed at the end by design
      if (m.t === 'matchStart') {
        rx = new SnapshotReceiver(new StringTable(m.strings));
        myEntity = m.you;
        // the string table is a dictionary of every content id, not an assignment
        visit({ ...m, strings: undefined }, '', null, '');
        continue;
      }
      if (m.t === 'events') {
        // quickchat / announce text is free-form; only structured fields matter
        visit(
          m.events.map((e) => ({ ...e, zh: undefined, en: undefined })),
          'events',
          null,
          '',
        );
        for (const e of m.events) if (e.t === 'death') revealed.add(e.target);
        continue;
      }
      visit(m, '', null, '');
    } else if (p[0] === BIN_SNAPSHOT && rx) {
      // deltas decode against earlier snapshots, exactly like the client does
      const got = rx.receive(p);
      if (!got) continue;
      visit(got.snap, '', null, '');
      noteSnapshot(got.snap);
    }
  }
  return out;
}

/** Every event object a client received over the wire (JSON 'events' messages), in order. */
export function receivedEvents(log: Payload[]): Obj[] {
  const out: Obj[] = [];
  for (const p of log) {
    if (typeof p !== 'string') continue;
    const m = JSON.parse(p) as HostMsg;
    if (m.t === 'events') out.push(...(m.events as unknown as Obj[]));
  }
  return out;
}
