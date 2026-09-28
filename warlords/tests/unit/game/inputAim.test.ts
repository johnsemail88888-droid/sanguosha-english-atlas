// The input side of the aim (game/input.ts, weapons spec C3 / C4 / C9): Shift is sprint and breath
// on a keyboard, but frames drop BTN_SPRINT while a hold-breath weapon is aimed; touch's stick
// sprint never holds the breath (a separate 'breath' button does); a pull-down first eats the
// recoil climb (the look's pitch filter); a scope's second zoom step rides on BTN_ZOOM2.
import { describe, expect, it } from 'vitest';
import { BTN_ADS, BTN_SPRINT, BTN_ZOOM2 } from '../../../src/core/types';
import { AimFeel } from '../../../src/game/aimFeel';
import { InputState, LOOK_RAD_PER_PX } from '../../../src/game/input';

describe('InputState: breath and sprint', () => {
  it('Shift holds both; suppressSprint (aimed with a scope) drops BTN_SPRINT but keeps the breath', () => {
    const s = new InputState();
    s.keyDown('ShiftLeft');
    expect(s.isHeld('sprint')).toBe(true);
    expect(s.isHeld('breath')).toBe(true);
    expect(s.frame().buttons & BTN_SPRINT).toBe(BTN_SPRINT);
    s.suppressSprint = true;
    expect(s.frame().buttons & BTN_SPRINT).toBe(0);
    expect(s.isHeld('breath')).toBe(true);
    s.keyUp('ShiftLeft');
    expect(s.isHeld('breath')).toBe(false);
    expect(s.isHeld('sprint')).toBe(false);
  });

  it('touch: the stick\'s sprint edge sprints without holding the breath; the 屏息 button holds it without sprinting', () => {
    const s = new InputState();
    s.setTouchHeld('sprint', true);
    expect(s.isHeld('sprint')).toBe(true);
    expect(s.isHeld('breath')).toBe(false);
    s.setTouchHeld('sprint', false);
    s.setTouchHeld('breath', true);
    expect(s.isHeld('breath')).toBe(true);
    expect(s.frame().buttons & BTN_SPRINT).toBe(0);
    s.releaseAll();
    expect(s.isHeld('breath')).toBe(false);
  });

  it('BTN_ZOOM2 only while the aim button is held on the second zoom step', () => {
    const s = new InputState();
    s.zoom2 = true;
    expect(s.frame().buttons & BTN_ZOOM2).toBe(0);
    s.setMouseButton('ads', true);
    const b = s.frame().buttons;
    expect(b & BTN_ADS).toBe(BTN_ADS);
    expect(b & BTN_ZOOM2).toBe(BTN_ZOOM2);
    s.zoom2 = false;
    expect(s.frame().buttons & BTN_ZOOM2).toBe(0);
  });
});

describe('InputState.applyLook: a pull-down eats the recoil climb first (no overshoot)', () => {
  it('the base pitch only moves by what the climb did not absorb', () => {
    const aim = new AimFeel();
    const w = { weaponId: 'carbine', ads: true, blocked: false, hold: false, moving: false, airborne: false };
    for (let i = 0; i < 60; i++) aim.update(1 / 60, w);
    for (let i = 0; i < 8; i++) {
      aim.onShot('carbine', 0.5);
      for (let k = 0; k < 6; k++) aim.update(1 / 60, w);
    }
    const climb = aim.snapshot.kickPitch;
    expect(climb).toBeGreaterThan(0.01);
    const s = new InputState();
    // a pull down of exactly the climb: the view (base + climb) comes back to where it was, the base stays
    s.addLook(0, climb / LOOK_RAD_PER_PX);
    s.applyLook(1, false, (dp) => aim.absorbPitch(dp));
    expect(s.pitch).toBeCloseTo(0, 9);
    expect(aim.snapshot.kickPitch).toBe(climb);
    for (let k = 0; k < 2; k++) aim.update(1 / 60, w);
    expect(aim.snapshot.kickPitch).toBeLessThan(1e-9);
    // without the filter the same pull moves the base down (the settle would then drag the view under)
    const t = new InputState();
    t.addLook(0, climb / LOOK_RAD_PER_PX);
    t.applyLook(1, false);
    expect(t.pitch).toBeCloseTo(-climb, 9);
    // looking up is never filtered away
    const u = new InputState();
    u.addLook(0, -100);
    u.applyLook(1, false, (dp) => aim.absorbPitch(dp));
    expect(u.pitch).toBeCloseTo(100 * LOOK_RAD_PER_PX, 9);
  });
});
