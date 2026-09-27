// Mouse wheel → weapon switch: one switch per wheel gesture, so a Mac trackpad /
// Magic Mouse swipe (dozens of events plus momentum) does not flip the weapon
// back and forth and leave a random one in hand.
import { describe, expect, it } from 'vitest';
import { WHEEL_GESTURE_GAP_MS, WheelGesture } from '../../../src/game/input';

/** Events of one gesture: `n` deltas every `every` ms from `t0`; how many switched. */
function swipe(w: WheelGesture, t0: number, n: number, every: number, delta = 3): number {
  let switches = 0;
  for (let i = 0; i < n; i++) if (w.push(delta, t0 + i * every)) switches++;
  return switches;
}

describe('WheelGesture', () => {
  it('a trackpad swipe with momentum (60 events ~16 ms apart) switches once', () => {
    const w = new WheelGesture();
    expect(swipe(w, 1000, 60, 16)).toBe(1);
  });

  it('separate wheel notches each switch', () => {
    const w = new WheelGesture();
    const gap = WHEEL_GESTURE_GAP_MS + 20;
    expect([0, 1, 2, 3].map((i) => w.push(i % 2 ? -100 : 100, 500 + i * gap))).toEqual([true, true, true, true]);
  });

  it('a new swipe after a pause switches again', () => {
    const w = new WheelGesture();
    expect(swipe(w, 0, 40, 16)).toBe(1);
    expect(swipe(w, 39 * 16 + WHEEL_GESTURE_GAP_MS, 40, 16)).toBe(1);
  });

  it('horizontal-only events (deltaY 0) neither switch nor extend a gesture', () => {
    const w = new WheelGesture();
    expect(w.push(0, 0)).toBe(false);
    expect(w.push(5, 10)).toBe(true);
    for (let t = 20; t < 1000; t += 16) w.push(0, t);
    expect(w.push(5, 1000)).toBe(true);
  });
});
