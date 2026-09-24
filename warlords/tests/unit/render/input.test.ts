import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BTN_ADS, BTN_FIRE, BTN_INTERACT, BTN_JUMP, BTN_SPRINT } from '../../../src/core/types';
import { InputController, InputState, KEY_MAP, LOOK_RAD_PER_PX, PITCH_CLAMP, shouldSuppressKey } from '../../../src/game/input';

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

describe('browser shortcut suppression', () => {
  const none = { ctrlKey: false, altKey: false, metaKey: false };
  it('suppresses every game key and every Ctrl / Alt / Meta chord', () => {
    for (const code of Object.keys(KEY_MAP)) expect(shouldSuppressKey(code, none), code).toBe(true);
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ShiftLeft']) expect(shouldSuppressKey(code, none), code).toBe(true);
    // dodge (Ctrl / Alt) held together with gameplay keys
    for (const code of ['KeyR', 'KeyF', 'KeyE', 'KeyG', 'Digit4', 'Digit7', 'KeyD', 'KeyP', 'F5'])
      expect(shouldSuppressKey(code, { ...none, ctrlKey: true }), `ctrl+${code}`).toBe(true);
    for (const code of ['KeyF', 'KeyE', 'KeyD']) expect(shouldSuppressKey(code, { ...none, altKey: true }), `alt+${code}`).toBe(true);
    expect(shouldSuppressKey('KeyR', { ...none, metaKey: true })).toBe(true);
    // unbound keys without modifiers keep their browser behaviour (F5, F11, F12...)
    for (const code of ['F5', 'F11', 'F12', 'KeyP']) expect(shouldSuppressKey(code, none), code).toBe(false);
  });

  describe('InputController', () => {
    class FakeTarget {
      private readonly ls = new Map<string, Set<(e: unknown) => void>>();
      addEventListener(t: string, fn: (e: unknown) => void): void {
        if (!this.ls.has(t)) this.ls.set(t, new Set());
        this.ls.get(t)!.add(fn);
      }
      removeEventListener(t: string, fn: (e: unknown) => void): void {
        this.ls.get(t)?.delete(fn);
      }
      emit(t: string, e: unknown): void {
        for (const fn of this.ls.get(t) ?? []) fn(e);
      }
    }
    const key = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => {
      const ev = { code, ctrlKey: false, altKey: false, metaKey: false, repeat: false, target: null, prevented: false, preventDefault() {
        ev.prevented = true;
      }, ...mods };
      return ev;
    };
    let win: FakeTarget;
    let doc: FakeTarget & { hidden: boolean; pointerLockElement: null; fullscreenElement: null; exitPointerLock(): void };
    beforeEach(() => {
      win = new FakeTarget();
      doc = Object.assign(new FakeTarget(), { hidden: false, pointerLockElement: null, fullscreenElement: null, exitPointerLock: () => undefined });
      vi.stubGlobal('window', win);
      vi.stubGlobal('document', doc);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('Ctrl+R (dodge + reload) never reaches the browser, and both actions are queued', () => {
      const ic = new InputController(new FakeTarget() as unknown as HTMLElement);
      const ctrl = key('ControlLeft', { ctrlKey: true });
      const r = key('KeyR', { ctrlKey: true });
      win.emit('keydown', ctrl);
      win.emit('keydown', r);
      expect(ctrl.prevented).toBe(true);
      expect(r.prevented).toBe(true);
      const up = key('KeyR', { ctrlKey: true });
      win.emit('keyup', up);
      expect(up.prevented).toBe(true);
      expect(ic.state.frame().actions).toEqual([{ a: 'dodge' }, { a: 'reload' }]);
      ic.dispose();
    });

    it('leaves browser keys alone while disabled (menus / chat) and in editable fields', () => {
      const ic = new InputController(new FakeTarget() as unknown as HTMLElement);
      ic.setEnabled(false);
      const r = key('KeyR', { ctrlKey: true });
      win.emit('keydown', r);
      expect(r.prevented).toBe(false);
      ic.setEnabled(true);
      const typed = { ...key('KeyR', { ctrlKey: true }), target: { tagName: 'INPUT' } };
      win.emit('keydown', typed);
      expect(typed.prevented).toBe(false);
      ic.dispose();
    });
  });
});
