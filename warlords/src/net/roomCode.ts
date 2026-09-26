// Room codes: 5 characters from an alphabet without look-alikes (no 0/O, 1/I).

export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
/** PeerJS id of the host for a room. */
export const PEER_ID_PREFIX = 'sgwl-';

export function generateRoomCode(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    s += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length) % ROOM_ALPHABET.length];
  }
  return s;
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) if (!ROOM_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * Normalise user input: accepts "abcde", " AB-CDE ", "sgwl-ABCDE" or a pasted
 * invite link containing `room=ABCDE`. Returns null when no valid code is found.
 */
export function normalizeRoomCode(input: string): string | null {
  let s = input.trim();
  const m = /[?&#]room=([A-Za-z0-9-]+)/.exec(s);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('SGWL') && s.length === ROOM_CODE_LENGTH + 4) s = s.slice(4);
  return isValidRoomCode(s) ? s : null;
}

export const hostPeerIdFor = (code: string): string => `${PEER_ID_PREFIX}${code}`;
