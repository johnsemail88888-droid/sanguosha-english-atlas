// Status badges over hero nameplates (src/render/entities/nameplate.ts plateStatuses).
import { describe, expect, it } from 'vitest';
import { VF_BURNING, VF_CHARMED, VF_DANCING, VF_HASTE, VF_INVULN, VF_MARKED, VF_SHIELDED, VF_SLOWED, VF_STUNNED } from '../../../src/core/types';
import type { StatusId } from '../../../src/core/types';
import { MAX_PLATE_BADGES, TIMED_BADGES, plateStatuses } from '../../../src/render/entities/nameplate';

describe('plateStatuses', () => {
  it('no flags, no events: no badges', () => {
    expect(plateStatuses(0, null)).toEqual([]);
    expect(plateStatuses(0, new Set())).toEqual([]);
  });

  it('control first (stun > dance > charm > silence > disarm), then chained / marked, then slow and the rest', () => {
    expect(plateStatuses(VF_SLOWED | VF_STUNNED | VF_HASTE, new Set<StatusId>(['silence']))).toEqual(['stun', 'silence', 'slow']);
    expect(plateStatuses(VF_BURNING | VF_CHARMED, new Set<StatusId>(['disarm', 'chained']))).toEqual(['charm', 'disarm', 'chained']);
    expect(plateStatuses(VF_SLOWED | VF_MARKED | VF_DANCING, new Set<StatusId>(['chained']))).toEqual(['dance', 'chained', 'marked']);
    expect(plateStatuses(VF_SLOWED | VF_HASTE, null)).toEqual(['slow', 'haste']);
  });

  it(`at most ${MAX_PLATE_BADGES} badges, big enough to read`, () => {
    const all = VF_STUNNED | VF_CHARMED | VF_SLOWED | VF_BURNING | VF_MARKED | VF_INVULN | VF_SHIELDED | VF_HASTE;
    expect(MAX_PLATE_BADGES).toBe(3);
    expect(plateStatuses(all, new Set<StatusId>(['silence', 'disarm']))).toEqual(['stun', 'charm', 'silence']);
  });

  it('control effects count down; the rest do not', () => {
    for (const id of ['stun', 'dance', 'charm', 'silence', 'disarm'] as const) expect(TIMED_BADGES.has(id), id).toBe(true);
    for (const id of ['slow', 'marked', 'chained', 'burn'] as const) expect(TIMED_BADGES.has(id), id).toBe(false);
  });
});
