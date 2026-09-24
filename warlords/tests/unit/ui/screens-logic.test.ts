import { describe, expect, it } from 'vitest';
import type { GameResult, HeroSelectView, PublicPlayerView, RoleDealView } from '../../../src/core/types';
import { isFatalSessionError } from '../../../src/ui/app';
import { terrainRgb } from '../../../src/ui/hud/minimap';
import { wheelChoices } from '../../../src/ui/hud/overlays';
import { selectTurn, takenHeroes } from '../../../src/ui/screens/heroSelect';
import { ZONE_TABLE } from '../../../src/ui/screens/help';
import { ZONE_PHASES } from '../../../src/sim/zone';
import { inviteLink } from '../../../src/ui/screens/lobby';
import { buildOverRows, outcomeFor } from '../../../src/ui/screens/gameOver';
import { errorMessage, isValidRoomCode, normalizeRoomCode } from '../../../src/ui/screens/online';
import { crownSecret, crownSeats, shownSeatRole } from '../../../src/ui/screens/roles';
import { shouldUseTouch, stickVector } from '../../../src/ui/touch';
import { overrideLang } from '../../../src/ui/i18n';

describe('online room codes', () => {
  it('normalizes typed codes and pasted invite links', () => {
    expect(normalizeRoomCode(' ab-cd7 ')).toBe('ABCD7');
    expect(normalizeRoomCode('https://x.io/game/?room=kx7qd')).toBe('KX7QD');
    expect(normalizeRoomCode('sgwl-KX7QD')).toBe('KX7QD');
    expect(isValidRoomCode('KX7QD')).toBe(true);
    expect(isValidRoomCode('AB')).toBe(false);
    expect(isValidRoomCode('ABC-D')).toBe(false);
  });

  it('prefers bilingual NetError text', () => {
    overrideLang('en');
    expect(errorMessage({ code: 'roomFull', zh: '房间已满', en: 'The room is full' })).toBe('The room is full');
    overrideLang('zh');
    expect(errorMessage({ code: 'roomFull', zh: '房间已满', en: 'The room is full' })).toBe('房间已满');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    overrideLang(null);
  });

  it('builds invite links from the page location', () => {
    expect(inviteLink('KX7QD', { origin: 'https://sgwl.example', pathname: '/play/' })).toBe('https://sgwl.example/play/?room=KX7QD');
    expect(inviteLink('KX7QD', { origin: 'null', pathname: '/C:/game/index.html' })).toBe('/C:/game/index.html?room=KX7QD');
  });
});

describe('session errors', () => {
  it('treats connection-ending codes as fatal', () => {
    for (const c of ['kicked', 'hostLeft', 'connectionLost', 'roomFull', 'versionMismatch', 'simFailed']) expect(isFatalSessionError(c)).toBe(true);
    expect(isFatalSessionError('chatRateLimited')).toBe(false);
  });
});

describe('roles & hero select', () => {
  it('announces both crowns in chaos mode', () => {
    const deal: RoleDealView = { yourRole: 'rebel', publicRoles: { 3: 'double', 0: 'lord' } };
    expect(crownSeats(deal)).toEqual([0, 3]);
  });

  it('tells the real Lord (only) which crown is the decoy', () => {
    const asLord: RoleDealView = { yourRole: 'lord', publicRoles: { 0: 'lord', 3: 'double' } };
    const asDouble: RoleDealView = { yourRole: 'double', publicRoles: { 0: 'lord', 3: 'lord' } };
    const asRebel: RoleDealView = { yourRole: 'rebel', publicRoles: { 0: 'lord', 3: 'lord' } };
    expect(crownSecret(asLord, 0)).toEqual({ kind: 'yourDouble', seat: 3 });
    expect(crownSecret(asDouble, 3)).toEqual({ kind: 'trueLord', seat: 0 });
    expect(crownSecret(asRebel, 5)).toBeNull();
    expect(shownSeatRole(asLord, 3, 0)).toBe('double');
    expect(shownSeatRole(asDouble, 3, 3)).toBe('double');
    expect(shownSeatRole(asDouble, 0, 3)).toBe('lord');
    expect(shownSeatRole(asRebel, 3, 5)).toBe('lord');
    expect(shownSeatRole(asRebel, 4, 5)).toBeUndefined();
  });

  it('lets the 影武者 pick in the lord phase (turn comes from the options)', () => {
    // exactly what net/hostSession sends the Double: the REAL lord seat + its own options
    const deal: RoleDealView = { yourRole: 'double', publicRoles: { 0: 'lord', 3: 'lord' } };
    const forDouble: HeroSelectView = { options: ['a', 'b', 'c'], deadline: 10, picks: {}, lordSeat: 0, lordPhase: true };
    expect(selectTurn(forDouble, 3, deal)).toMatchObject({ waiting: false, iAmCrown: true, iAmRealLord: false, crowns: [0, 3] });
    const lordDeal: RoleDealView = { yourRole: 'lord', publicRoles: { 0: 'lord', 3: 'double' } };
    expect(selectTurn({ ...forDouble }, 0, lordDeal)).toMatchObject({ waiting: false, iAmCrown: true, iAmRealLord: true });
    const rebel: RoleDealView = { yourRole: 'rebel', publicRoles: { 0: 'lord', 3: 'lord' } };
    const forRebel: HeroSelectView = { options: [], deadline: 10, picks: { 3: 'x' }, lordSeat: 0, lordPhase: true };
    expect(selectTurn(forRebel, 5, rebel)).toMatchObject({ waiting: true, iAmCrown: false, iAmRealLord: false });
    expect(selectTurn({ ...forRebel, lordPhase: false, options: ['a'] }, 5, rebel).waiting).toBe(false);
    // no deal known (should not happen): fall back to lordSeat
    expect(selectTurn({ ...forRebel, lordSeat: 2 }, 2, null)).toMatchObject({ iAmCrown: true, iAmRealLord: true, crowns: [2] });
  });

  it('generates the zone table from the sim phases', () => {
    expect(ZONE_TABLE).toHaveLength(ZONE_PHASES.length);
    ZONE_PHASES.forEach((z, i) => expect(ZONE_TABLE[i]).toEqual({ phase: i, ...z }));
  });

  it('marks heroes picked by others as taken', () => {
    const v: HeroSelectView = { options: ['a', 'b', 'c'], deadline: 10, picks: { 0: 'x', 2: 'b', 5: 'c' }, lordSeat: 0, lordPhase: false };
    expect([...takenHeroes(v, 5)].sort()).toEqual(['b', 'x']);
  });

  it('wheel offers claims and quick chat (8 slots)', () => {
    const c = wheelChoices();
    expect(c).toHaveLength(8);
    expect(c.filter((x) => x.kind === 'claim')).toHaveLength(3);
  });
});

describe('game over', () => {
  const players: PublicPlayerView[] = [0, 1, 2].map((seat) => ({
    playerId: `p${seat}`,
    name: `P${seat}`,
    isBot: seat > 0,
    seat,
    entityId: 100 + seat,
    heroId: 'x',
    kingdom: 'wei',
    alive: seat !== 2,
    downed: false,
    kills: seat,
  }));
  const result: GameResult = { winner: 'lord', winners: [100, 101], roles: { 100: 'lord', 101: 'loyalist', 102: 'rebel' }, mvp: 101, reasonZh: '', reasonEn: '', durationSec: 300 };

  it('resolves victory / defeat / draw for you', () => {
    expect(outcomeFor(result, 101)).toBe('victory');
    expect(outcomeFor(result, 102)).toBe('defeat');
    expect(outcomeFor(result, null)).toBe('defeat');
    expect(outcomeFor({ ...result, winner: 'draw' }, 101)).toBe('draw');
  });

  it('reveals every role in seat order with MVP and winners', () => {
    const rows = buildOverRows(result, [...players].reverse(), 102);
    expect(rows.map((r) => r.seat)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.role)).toEqual(['lord', 'loyalist', 'rebel']);
    expect(rows[1].mvp).toBe(true);
    expect(rows[2].isMe).toBe(true);
    expect(rows.filter((r) => r.won)).toHaveLength(2);
  });

  it('adds rows for role entries without a player', () => {
    const rows = buildOverRows({ ...result, roles: { ...result.roles, 999: 'traitor' } }, players, null);
    expect(rows.some((r) => r.entityId === 999 && r.role === 'traitor')).toBe(true);
  });
});

describe('touch controls', () => {
  it('honours the preference, auto follows the pointer type', () => {
    expect(shouldUseTouch('on', false)).toBe(true);
    expect(shouldUseTouch('off', true)).toBe(false);
    expect(shouldUseTouch('auto', true)).toBe(true);
    expect(shouldUseTouch('auto', false)).toBe(false);
  });

  it('clamps the stick to the unit circle with a dead zone', () => {
    expect(stickVector(0, 0)).toEqual({ x: 0, z: 0, mag: 0 });
    expect(stickVector(2, -2)).toEqual({ x: 0, z: 0, mag: 0 });
    const up = stickVector(0, -56);
    expect(up.z).toBeCloseTo(1);
    expect(up.x).toBeCloseTo(0);
    const far = stickVector(300, 0);
    expect(far.x).toBeCloseTo(1);
    expect(far.mag).toBe(1);
  });
});

describe('minimap colors', () => {
  it('water is blue-ish, highlands are paler than lowlands', () => {
    const [r, g, b] = terrainRgb(-1, 0, 20);
    expect(b).toBeGreaterThan(r);
    const low = terrainRgb(1, 0, 20);
    const high = terrainRgb(20, 0, 20);
    expect(high[0] + high[1] + high[2]).toBeGreaterThan(low[0] + low[1] + low[2]);
  });
});
