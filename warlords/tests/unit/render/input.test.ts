import { describe, expect, it } from 'vitest';
import { BTN_ADS, BTN_FIRE, BTN_INTERACT, BTN_JUMP, BTN_SPRINT } from '../../../src/core/types';
import { InputState, KEY_MAP, LOOK_RAD_PER_PX, PITCH_CLAMP } from '../../../src/game/input';

describe('InputState', () => {
  it('mouse right turns right (yaw decreases), mouse up looks up (pitch increases)', () => {
    const s = new InputState();
    s.addLook(100, -50);
    s.applyLook(1, false);
    expect(s.yaw).toBeCloseTo(-100 * LOOK_RAD_PER_PX, 9);
    expect(s.pitch).toBeCloseTo(50 * LOOK_RAD_PER_PX, 9);
  });

  it('invertY flips vertical look and sensitivity scales it', () => {
    const s = new InputState();
    s.addLook(0, -50);
    s.applyLook(2, true);
    expect(s.pitch).toBeCloseTo(-100 * LOOK_RAD_PER_PX, 9);
  });

  it('clamps pitch to ±1.45 and wraps yaw', () => {
    const s = new InputState();
    s.addLook(0, -1e6);
    s.applyLook(1, false);
    expect(s.pitch).toBe(PITCH_CLAMP);
    s.addLook(0, 1e6);
    s.applyLook(1, false);
    expect(s.pitch).toBe(-PITCH_CLAMP);
    s.addLook(-(Math.PI * 3) / LOOK_RAD_PER_PX, 0);
    s.applyLook(1, false);
    expect(s.yaw).toBeGreaterThan(-Math.PI);
    expect(s.yaw).toBeLessThanOrEqual(Math.PI);
  });

  it('normalises diagonal movement and maps WASD camera-relative', () => {
    const s = new InputState();
    s.keyDown('KeyW');
    s.keyDown('KeyD');
    const f = s.frame();
    expect(f.moveZ).toBeCloseTo(Math.SQRT1_2, 6);
    expect(f.moveX).toBeCloseTo(Math.SQRT1_2, 6);
    s.keyUp('KeyW');
    s.keyDown('KeyS');
    const g = s.frame();
    expect(g.moveZ).toBeCloseTo(-Math.SQRT1_2, 6);
  });

  it('queues edge actions once and clears them after a frame; seq increments', () => {
    const s = new InputState();
    s.keyDown('KeyQ');
    s.keyDown('KeyQ'); // auto-repeat ignored
    s.keyDown('KeyZ');
    s.keyDown('Digit5');
    const f = s.frame();
    expect(f.actions).toEqual([{ a: 'ability', slot: 'q' }, { a: 'command', order: 'follow' }, { a: 'item', slot: 1 }]);
    expect(s.frame().actions).toEqual([]);
    expect(s.frame().seq).toBe(f.seq + 2);
  });

  it('sets held button bits', () => {
    const s = new InputState();
    s.setMouseButton('fire', true);
    s.setMouseButton('ads', true);
    s.keyDown('ShiftLeft');
    s.keyDown('Space');
    s.keyDown('KeyF');
    const f = s.frame();
    expect(f.buttons & BTN_FIRE).toBeTruthy();
    expect(f.buttons & BTN_ADS).toBeTruthy();
    expect(f.buttons & BTN_SPRINT).toBeTruthy();
    expect(f.buttons & BTN_JUMP).toBeTruthy();
    expect(f.buttons & BTN_INTERACT).toBeTruthy();
    expect(f.actions).toEqual([{ a: 'jump' }, { a: 'interact' }]);
  });

  it('disabled state drops input and releases held keys', () => {
    const s = new InputState();
    s.keyDown('KeyW');
    s.setMouseButton('fire', true);
    s.enabled = false;
    s.releaseAll();
    s.keyDown('KeyE');
    s.addLook(500, 0);
    s.applyLook(1, false);
    const f = s.frame();
    expect(f.buttons).toBe(0);
    expect(f.moveZ).toBe(0);
    expect(f.actions).toEqual([]);
    expect(s.yaw).toBe(0);
  });

  it('touch stick and touch buttons feed the frame', () => {
    const s = new InputState();
    s.setTouchMove(0.3, 2);
    s.setTouchHeld('fire', true);
    s.pushAction({ a: 'dodge' });
    const f = s.frame({ aimPoint: { x: 1, y: 2, z: 3 }, aimTargetId: 7 }, 42);
    expect(f.moveZ).toBeGreaterThan(0.9);
    expect(Math.hypot(f.moveX, f.moveZ)).toBeLessThanOrEqual(1 + 1e-9);
    expect(f.buttons & BTN_FIRE).toBeTruthy();
    expect(f.actions).toEqual([{ a: 'dodge' }]);
    expect(f.aimPoint).toEqual({ x: 1, y: 2, z: 3 });
    expect(f.aimTargetId).toBe(7);
    expect(f.viewTick).toBe(42);
  });

  it('key map covers the GAME_SPEC §10 bindings', () => {
    for (const code of ['KeyR', 'KeyQ', 'KeyE', 'KeyG', 'KeyF', 'Digit1', 'Digit2', 'Digit4', 'Digit7', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'ControlLeft', 'AltLeft', 'Space'])
      expect(KEY_MAP[code]?.kind).toBe('action');
    for (const [code, key] of [
      ['Tab', 'scoreboard'],
      ['KeyM', 'map'],
      ['Enter', 'chat'],
      ['Escape', 'menu'],
      ['KeyT', 'quickchat'],
    ] as const) {
      const b = KEY_MAP[code];
      expect(b?.kind).toBe('ui');
      if (b?.kind === 'ui') expect(b.key).toBe(key);
    }
  });
});
