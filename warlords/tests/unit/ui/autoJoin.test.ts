// One-click invite: what the online screen does by itself when it opens.
import { describe, expect, it } from 'vitest';
import { autoJoinPlan } from '../../../src/ui/screens/online';

describe('the online screen joins by itself', () => {
  const base = { invited: null as string | null, rejoin: false, inviteTried: false, canJoin: true };

  it('an invite link (?room=CODE) joins at once — no 加入 click', () => {
    expect(autoJoinPlan({ ...base, invited: 'kx7qd' })).toBe('invite');
    expect(autoJoinPlan({ ...base, invited: 'https://x.example/?room=KX7QD&mode=peer' })).toBe('invite');
  });

  it('once per page load: a failed one leaves the screen to the player (重试), it never loops', () => {
    expect(autoJoinPlan({ ...base, invited: 'KX7QD', inviteTried: true })).toBeNull();
  });

  it('no valid code, or no way to reach the room (a relay invite without its address): the screen waits', () => {
    expect(autoJoinPlan({ ...base, invited: '' })).toBeNull();
    expect(autoJoinPlan({ ...base, invited: '!!' })).toBeNull();
    expect(autoJoinPlan({ ...base, invited: 'KX7QD', canJoin: false })).toBeNull();
  });

  it('no invite: nothing; the room this tab was in (F5 / a drop) rejoins first', () => {
    expect(autoJoinPlan(base)).toBeNull();
    expect(autoJoinPlan({ ...base, rejoin: true })).toBe('rejoin');
    expect(autoJoinPlan({ ...base, rejoin: true, invited: 'KX7QD', inviteTried: true })).toBe('rejoin');
  });
});
