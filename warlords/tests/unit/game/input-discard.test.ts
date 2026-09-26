// COMBAT-7 input mapping: X + 4–7 (or numpad 4–7) discards that slot's card; X on
// its own is still the squad "hold" order, sent when X is released without a slot key.
import { describe, expect, it } from 'vitest';
import { DISCARD_KEY, InputState, KEY_MAP, itemSlotOfKey, shouldSuppressKey } from '../../../src/game/input';

const noMods = { ctrlKey: false, altKey: false, metaKey: false };

describe('discard chord (X + slot key)', () => {
  it('maps the slot keys to item slots 0–3', () => {
    expect(['Digit4', 'Digit5', 'Digit6', 'Digit7'].map(itemSlotOfKey)).toEqual([0, 1, 2, 3]);
    expect(['Numpad4', 'Numpad5', 'Numpad6', 'Numpad7'].map(itemSlotOfKey)).toEqual([0, 1, 2, 3]);
    for (const code of ['Digit1', 'Digit2', 'KeyX', 'KeyF', 'Space']) expect(itemSlotOfKey(code)).toBeNull();
    expect(DISCARD_KEY).toBe('KeyX');
    // still a bound game key: its browser default stays suppressed
    expect(shouldSuppressKey(DISCARD_KEY, noMods)).toBe(true);
  });

  it('a slot key alone uses the card, at once (no added latency)', () => {
    const s = new InputState();
    s.keyDown('Digit5');
    expect(s.frame().actions).toEqual([{ a: 'item', slot: 1 }]);
  });

  it('X held + slot key: drop that card instead of using it; no hold order on release', () => {
    const s = new InputState();
    s.keyDown('KeyX');
    expect(s.frame().actions).toEqual([]);
    s.keyDown('Digit4');
    s.keyDown('Numpad7');
    expect(s.frame().actions).toEqual([
      { a: 'drop', slot: 0, what: 'item' },
      { a: 'drop', slot: 3, what: 'item' },
    ]);
    s.keyUp('Digit4');
    s.keyUp('Numpad7');
    s.keyUp('KeyX');
    expect(s.frame().actions).toEqual([]);
  });

  it('X tapped alone: the squad hold order goes out on release', () => {
    const s = new InputState();
    s.keyDown('KeyX');
    s.keyUp('KeyX');
    expect(s.frame().actions).toEqual([KEY_MAP.KeyX.kind === 'action' ? KEY_MAP.KeyX.action : null]);
    expect(s.frame().actions).toEqual([]);
  });

  it('a slot key already down before X uses its card; X then still orders hold', () => {
    const s = new InputState();
    s.keyDown('Digit6');
    s.keyDown('KeyX');
    s.keyUp('Digit6');
    s.keyUp('KeyX');
    expect(s.frame().actions).toEqual([
      { a: 'item', slot: 2 },
      { a: 'command', order: 'hold' },
    ]);
  });

  it('auto-repeat of the slot key while X is held discards once per press', () => {
    const s = new InputState();
    s.keyDown('KeyX');
    s.keyDown('Digit5');
    s.keyDown('Digit5');
    s.keyDown('Digit5');
    expect(s.frame().actions).toEqual([{ a: 'drop', slot: 1, what: 'item' }]);
  });

  it('a menu opening while X is held (releaseAll) sends nothing on the later key-up', () => {
    const s = new InputState();
    s.keyDown('KeyX');
    s.releaseAll();
    s.keyUp('KeyX');
    expect(s.frame().actions).toEqual([]);
    // and a disabled state never queues the chord
    s.enabled = false;
    s.keyDown('KeyX');
    s.keyDown('Digit4');
    s.keyUp('KeyX');
    expect(s.frame().actions).toEqual([]);
  });
});
