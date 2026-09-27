// Hold-to-preview, release-to-cast for aimed skills (src/game/input.ts).
import { describe, expect, it } from 'vitest';
import { InputState, aimSlotsFor } from '../../../src/game/input';

describe('aimed skills: preview while held, cast on release', () => {
  it('without aim slots a skill key casts on press (unchanged default)', () => {
    const s = new InputState();
    s.keyDown('KeyQ');
    expect(s.frame().actions).toEqual([{ a: 'ability', slot: 'q' }]);
    s.keyUp('KeyQ');
    expect(s.frame().actions).toEqual([]);
  });

  it('an aimed slot shows its preview while held and casts once on release', () => {
    const s = new InputState();
    s.setAimSlots(['q']);
    s.keyDown('KeyQ');
    expect(s.aimingSlot()).toBe('q');
    expect(s.frame().actions).toEqual([]);
    s.keyDown('KeyQ'); // auto-repeat
    expect(s.frame().actions).toEqual([]);
    s.keyUp('KeyQ');
    expect(s.aimingSlot()).toBeNull();
    expect(s.frame().actions).toEqual([{ a: 'ability', slot: 'q' }]);
    // E is not aimed: still on press
    s.keyDown('KeyE');
    expect(s.frame().actions).toEqual([{ a: 'ability', slot: 'e' }]);
  });

  it('right click cancels the preview (and does not start aiming down sights)', () => {
    const s = new InputState();
    s.setAimSlots(['q']);
    s.keyDown('KeyQ');
    s.setMouseButton('ads', true);
    expect(s.aimingSlot()).toBeNull();
    expect(s.isHeld('ads')).toBe(false);
    s.keyUp('KeyQ');
    expect(s.frame().actions).toEqual([]);
    // the next right click aims as usual
    s.setMouseButton('ads', false);
    s.setMouseButton('ads', true);
    expect(s.isHeld('ads')).toBe(true);
  });

  it('a menu / lost focus mid-preview never casts', () => {
    const s = new InputState();
    s.setAimSlots(['e']);
    s.keyDown('KeyE');
    s.releaseAll();
    s.keyUp('KeyE');
    expect(s.frame().actions).toEqual([]);
  });

  it('pressing another aimed skill switches the preview; only the key held last casts', () => {
    const s = new InputState();
    s.setAimSlots(['q', 'e']);
    s.keyDown('KeyQ');
    s.keyDown('KeyE');
    expect(s.aimingSlot()).toBe('e');
    s.keyUp('KeyQ');
    expect(s.frame().actions).toEqual([]);
    s.keyUp('KeyE');
    expect(s.frame().actions).toEqual([{ a: 'ability', slot: 'e' }]);
  });

  it('the fire button still shoots while a preview shows', () => {
    const s = new InputState();
    s.setAimSlots(['q']);
    s.keyDown('KeyQ');
    s.setMouseButton('fire', true);
    expect(s.frame().buttons & 1).toBe(1);
    expect(s.aimingSlot()).toBe('q');
  });
});

describe('aimSlotsFor: which slots preview', () => {
  it('aimed skills that are ready; self buffs, cooldowns, downed and dead heroes cast on press', () => {
    // 关羽: Q 青龙斩 (direction) and E 义绝 (enemy) are both aimed
    expect(aimSlotsFor({ heroId: 'guanyu', cooldowns: {}, charges: {} })).toEqual(['q', 'e']);
    expect(aimSlotsFor({ heroId: 'guanyu', cooldowns: { guanyu_qinglong: 3 }, charges: {} })).toEqual(['e']);
    // 许褚: Q 裸衣 is a pure self buff (press), E 虎卫猛击 leaps forward (aimed)
    expect(aimSlotsFor({ heroId: 'xuchu', cooldowns: {}, charges: {} })).toEqual(['e']);
    // 赵云 Q has charges: aimed while a charge is left even though the next one recharges
    expect(aimSlotsFor({ heroId: 'zhaoyun', cooldowns: { zhaoyun_qijin: 5 }, charges: { zhaoyun_qijin: 1 } })).toContain('q');
    expect(aimSlotsFor({ heroId: 'zhaoyun', cooldowns: { zhaoyun_qijin: 5 }, charges: { zhaoyun_qijin: 0 } })).not.toContain('q');
    expect(aimSlotsFor({ heroId: 'guanyu', downed: true })).toEqual([]);
    expect(aimSlotsFor({ heroId: 'guanyu', dead: true })).toEqual([]);
    expect(aimSlotsFor(null)).toEqual([]);
    // the lord skill slot counts for the real Lord only (刘备 激将: a ring around you)
    expect(aimSlotsFor({ heroId: 'liubei', role: 'lord', cooldowns: {}, charges: {} })).toContain('lord');
    expect(aimSlotsFor({ heroId: 'liubei', role: 'rebel', cooldowns: {}, charges: {} })).not.toContain('lord');
  });
});
