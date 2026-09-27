// 「主公卫队正在攻击你」: the HUD warns when a squad focuses you (ui/hud/logic.ts SquadFocusTracker).
import { describe, expect, it } from 'vitest';
import { FOCUS_HOLD, FOCUS_MIN_SHOOTERS, FOCUS_WINDOW, SquadFocusTracker } from '../../../src/ui/hud/logic';
import { squadFocusText } from '../../../src/ui/hud/combat';
import { overrideLang } from '../../../src/ui/i18n';

describe('squad focus warning', () => {
  it(`${FOCUS_MIN_SHOOTERS} soldiers of one commander hitting you within ${FOCUS_WINDOW} s raise it; it holds ${FOCUS_HOLD} s`, () => {
    const t = new SquadFocusTracker();
    t.note(101, 7, 10);
    t.note(101, 7, 10.2); // the same soldier again: still one shooter
    t.note(102, 7, 10.4);
    expect(t.current(10.5)).toBeNull();
    t.note(103, 7, 11);
    expect(t.current(11)).toEqual({ commander: 7, shooters: 3 });
    expect(t.current(11 + FOCUS_HOLD - 0.1)).not.toBeNull();
    expect(t.current(11 + FOCUS_HOLD + 0.1)).toBeNull();
  });

  it('soldiers of different commanders do not add up; hits spread over time do not either', () => {
    const t = new SquadFocusTracker();
    t.note(1, 7, 0);
    t.note(2, 8, 0.1);
    t.note(3, 9, 0.2);
    expect(t.current(0.3)).toBeNull();
    const u = new SquadFocusTracker();
    u.note(1, 7, 0);
    u.note(2, 7, 2);
    u.note(3, 7, 4.5); // the first hit is out of the window by now
    expect(u.current(4.5)).toBeNull();
    // wild units (camps) count together
    const w = new SquadFocusTracker();
    for (let i = 0; i < 3; i++) w.note(50 + i, undefined, i * 0.3);
    expect(w.current(0.7)).toEqual({ commander: undefined, shooters: 3 });
  });

  it('says whose soldiers they are (zh + en)', () => {
    overrideLang('zh');
    expect(squadFocusText('lord', '')).toBe('主公卫队正在攻击你！');
    expect(squadFocusText('hero', '曹操')).toBe('曹操的部曲正在集火你！');
    overrideLang('en');
    expect(squadFocusText('lord', '')).toContain('Lord');
    expect(squadFocusText('wild', '')).toContain('Enemy soldiers');
    overrideLang(null);
  });
});
