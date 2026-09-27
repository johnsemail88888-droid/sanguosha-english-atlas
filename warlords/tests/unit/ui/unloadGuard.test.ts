import { describe, expect, it } from 'vitest';
import { guardUnload } from '../../../src/ui/app';

describe('closing the tab mid-match (Ctrl+W = dodge + forward)', () => {
  it('asks first only in a match on a web page a person is playing', () => {
    expect(guardUnload({ inMatch: true, desktop: false, automated: false })).toBe(true);
    expect(guardUnload({ inMatch: false, desktop: false, automated: false })).toBe(false);
    expect(guardUnload({ inMatch: true, desktop: true, automated: false })).toBe(false);
    expect(guardUnload({ inMatch: true, desktop: false, automated: true })).toBe(false);
  });
});
