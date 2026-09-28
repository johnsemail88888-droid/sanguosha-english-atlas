// Status badges over hero nameplates (src/render/entities/nameplate.ts plateStatuses).
import { describe, expect, it } from 'vitest';
import { VF_BURNING, VF_CHARMED, VF_HASTE, VF_INVULN, VF_MARKED, VF_SHIELDED, VF_SLOWED, VF_STUNNED } from '../../../src/core/types';
import type { StatusId } from '../../../src/core/types';
import { MAX_PLATE_BADGES, plateStatuses } from '../../../src/render/entities/nameplate';

describe('plateStatuses', () => {
  it('no flags, no events: no badges', () => {
    expect(plateStatuses(0, null)).toEqual([]);
    expect(plateStatuses(0, new Set())).toEqual([]);
  });

  it('hard control first, then the event-only statuses (沉默), then the rest', () => {
    const extra = new Set<StatusId>(['silence']);
    expect(plateStatuses(VF_SLOWED | VF_STUNNED | VF_HASTE, extra)).toEqual(['stun', 'silence', 'slow', 'haste']);
    expect(plateStatuses(VF_BURNING | VF_CHARMED, new Set<StatusId>(['disarm', 'chained']))).toEqual(['charm', 'disarm', 'chained', 'burn']);
  });

  it(`at most ${MAX_PLATE_BADGES} badges`, () => {
    const all = VF_STUNNED | VF_CHARMED | VF_SLOWED | VF_BURNING | VF_MARKED | VF_INVULN | VF_SHIELDED | VF_HASTE;
    const out = plateStatuses(all, new Set<StatusId>(['silence', 'disarm']));
    expect(out).toHaveLength(MAX_PLATE_BADGES);
    expect(out.slice(0, 4)).toEqual(['stun', 'charm', 'silence', 'disarm']);
  });
});
