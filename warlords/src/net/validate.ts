// Host-side validation of client input. Everything decoded from a client is
// untrusted: the binary codec guarantees types for the fixed fields, but edge
// actions may arrive as forward-compatible JSON (codec action code 255) and
// counts are only bounded by the transport's max payload. The host sanitizes
// every InputPacket before it reaches SimHost.setInput.
import {
  ITEM_SLOTS,
  WEAPON_SLOTS,
  type AbilitySlot,
  type InputAction,
  type InputFrame,
  type RoleId,
  type SquadOrderKind,
} from '../core/types';
import { INPUT_REDUNDANCY, type InputPacket } from './protocol';

/** Max edge actions accepted per frame (a human cannot press more in 33 ms). */
export const MAX_ACTIONS_PER_FRAME = 12;
/** Max length of a quickchat phrase id. */
export const MAX_QUICKCHAT_ID = 32;
/** |coordinate| bound for aim points (the map is ±~300 m). */
const MAX_AIM_COORD = 5000;

// Exhaustive at compile time: a new union member without an entry fails tsc.
const ABILITY_SLOT_SET: Record<AbilitySlot, true> = { q: true, e: true, lord: true };
const ORDER_SET: Record<SquadOrderKind, true> = { follow: true, hold: true, attack: true, charge: true };
const ROLE_SET: Record<RoleId, true> = {
  lord: true,
  loyalist: true,
  rebel: true,
  traitor: true,
  double: true,
  opportunist: true,
  bounty: true,
};

const has = <K extends string>(set: Record<K, true>, v: unknown): v is K =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(set, v);

const slotIn = (v: unknown, count: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < count;

const QUICKCHAT_ID = /^[A-Za-z0-9_.:-]+$/;

/** A clean copy of `raw` if it is a well-formed InputAction, else null. */
export function sanitizeAction(raw: unknown): InputAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  switch (a.a) {
    case 'jump':
    case 'dodge':
    case 'reload':
    case 'interact':
    case 'mark':
      return { a: a.a };
    case 'ability':
      return has(ABILITY_SLOT_SET, a.slot) ? { a: 'ability', slot: a.slot } : null;
    case 'weapon':
      return slotIn(a.slot, WEAPON_SLOTS) ? { a: 'weapon', slot: a.slot } : null;
    case 'item':
      return slotIn(a.slot, ITEM_SLOTS) ? { a: 'item', slot: a.slot } : null;
    case 'drop':
      if (a.what === 'weapon') return slotIn(a.slot, WEAPON_SLOTS) ? { a: 'drop', slot: a.slot, what: 'weapon' } : null;
      if (a.what === 'item') return slotIn(a.slot, ITEM_SLOTS) ? { a: 'drop', slot: a.slot, what: 'item' } : null;
      return null;
    case 'command':
      return has(ORDER_SET, a.order) ? { a: 'command', order: a.order } : null;
    case 'claim':
      return has(ROLE_SET, a.role) ? { a: 'claim', role: a.role } : null;
    case 'quickchat':
      return typeof a.id === 'string' && a.id.length > 0 && a.id.length <= MAX_QUICKCHAT_ID && QUICKCHAT_ID.test(a.id)
        ? { a: 'quickchat', id: a.id }
        : null;
    default:
      return null;
  }
}

/** Well-formed actions only, at most MAX_ACTIONS_PER_FRAME. */
export function sanitizeActions(list: unknown): InputAction[] {
  if (!Array.isArray(list)) return [];
  const out: InputAction[] = [];
  for (const raw of list) {
    if (out.length >= MAX_ACTIONS_PER_FRAME) break;
    const a = sanitizeAction(raw);
    if (a) out.push(a);
  }
  return out;
}

const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);
const clampUnit = (v: number): number => Math.max(-1, Math.min(1, finite(v, 0)));

/** Clamp / drop every field of a decoded InputFrame to what the sim accepts. */
export function sanitizeFrame(f: InputFrame): InputFrame {
  const out: InputFrame = {
    seq: Number.isSafeInteger(f.seq) && f.seq >= 0 ? f.seq : 0,
    moveX: clampUnit(f.moveX),
    moveZ: clampUnit(f.moveZ),
    yaw: finite(f.yaw, 0),
    pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, finite(f.pitch, 0))),
    buttons: f.buttons >>> 0,
    actions: sanitizeActions(f.actions),
  };
  const p = f.aimPoint;
  if (p && [p.x, p.y, p.z].every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_AIM_COORD)) out.aimPoint = { x: p.x, y: p.y, z: p.z };
  if (f.aimTargetId !== undefined && Number.isSafeInteger(f.aimTargetId) && f.aimTargetId >= 0) out.aimTargetId = f.aimTargetId;
  if (f.viewTick !== undefined && Number.isSafeInteger(f.viewTick) && f.viewTick >= 0) out.viewTick = f.viewTick;
  return out;
}

/** Sanitize a whole packet: frame + at most INPUT_REDUNDANCY history entries. */
export function sanitizeInputPacket(p: InputPacket): InputPacket {
  const frame = sanitizeFrame(p.frame);
  const history: InputPacket['history'] = [];
  for (const h of p.history.slice(0, INPUT_REDUNDANCY)) {
    if (!Number.isSafeInteger(h.seq) || h.seq >= frame.seq) continue;
    history.push({ seq: h.seq, actions: sanitizeActions(h.actions) });
  }
  const out: InputPacket = { frame, history };
  if (p.snapAck !== undefined && Number.isSafeInteger(p.snapAck) && p.snapAck >= 0) out.snapAck = p.snapAck;
  return out;
}

/**
 * "Hands off the controls": no movement, no held buttons, no actions — but the
 * same view direction, so the hero does not snap around. seq 0 marks an
 * unsequenced frame (SimHost accepts it without disturbing input ordering).
 * null when there is no previous input to keep the view direction from.
 */
export function neutralInput(prev: InputFrame | null): InputFrame | null {
  if (!prev) return null;
  return { seq: 0, moveX: 0, moveZ: 0, yaw: prev.yaw, pitch: prev.pitch, buttons: 0, actions: [] };
}
