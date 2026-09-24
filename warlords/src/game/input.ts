// Keyboard / mouse / touch → InputFrame (GAME_SPEC §10). One InputController
// per match view. The touch overlay (src/ui/touch*.ts) drives it through the
// InputSink methods. UI-only keys (Tab/M/Enter/Esc/T) are reported through
// onUiKey() instead of InputActions.
import type { EntityId, InputAction, InputFrame } from '../core/types';
import type { Vec3 } from '../core/math';
import { clamp, wrapAngle } from '../core/math';
import { BTN_ADS, BTN_FIRE, BTN_INTERACT, BTN_JUMP, BTN_SPRINT, emptyInput } from '../core/types';
import type { InputSink } from './input-types';
import { settings } from './settings';

/** Radians of yaw/pitch per pixel of mouse movement at sensitivity 1. */
export const LOOK_RAD_PER_PX = 0.0022;
export const PITCH_CLAMP = 1.45;

export type UiKey = 'scoreboard' | 'map' | 'chat' | 'menu' | 'quickchat';

/** What sample() needs from the renderer (GameRenderer satisfies it). */
export interface InputRendererLike {
  pick(): { aimPoint: Vec3; aimTargetId?: EntityId };
  setLookAngles?(yaw: number, pitch: number, ads?: boolean, fireHeld?: boolean): void;
  readonly adsZoom?: number;
  readonly view?: { viewTick(): number; local(): { activeSlot: number; weapons: unknown[] } | null; localId(): EntityId | null; get(id: EntityId): { yaw: number; pitch: number } | undefined };
}

type ActionKey = { kind: 'action'; action: InputAction } | { kind: 'ui'; key: UiKey } | { kind: 'held'; btn: number };

/** Key map (KeyboardEvent.code → binding). Movement keys are handled separately. */
export const KEY_MAP: Readonly<Record<string, ActionKey>> = {
  KeyR: { kind: 'action', action: { a: 'reload' } },
  KeyQ: { kind: 'action', action: { a: 'ability', slot: 'q' } },
  KeyE: { kind: 'action', action: { a: 'ability', slot: 'e' } },
  KeyG: { kind: 'action', action: { a: 'ability', slot: 'lord' } },
  KeyF: { kind: 'action', action: { a: 'interact' } },
  Digit1: { kind: 'action', action: { a: 'weapon', slot: 0 } },
  Digit2: { kind: 'action', action: { a: 'weapon', slot: 1 } },
  Digit4: { kind: 'action', action: { a: 'item', slot: 0 } },
  Digit5: { kind: 'action', action: { a: 'item', slot: 1 } },
  Digit6: { kind: 'action', action: { a: 'item', slot: 2 } },
  Digit7: { kind: 'action', action: { a: 'item', slot: 3 } },
  Numpad1: { kind: 'action', action: { a: 'weapon', slot: 0 } },
  Numpad2: { kind: 'action', action: { a: 'weapon', slot: 1 } },
  Numpad4: { kind: 'action', action: { a: 'item', slot: 0 } },
  Numpad5: { kind: 'action', action: { a: 'item', slot: 1 } },
  Numpad6: { kind: 'action', action: { a: 'item', slot: 2 } },
  Numpad7: { kind: 'action', action: { a: 'item', slot: 3 } },
  KeyZ: { kind: 'action', action: { a: 'command', order: 'follow' } },
  KeyX: { kind: 'action', action: { a: 'command', order: 'hold' } },
  KeyC: { kind: 'action', action: { a: 'command', order: 'attack' } },
  KeyV: { kind: 'action', action: { a: 'command', order: 'charge' } },
  KeyB: { kind: 'action', action: { a: 'mark' } },
  ControlLeft: { kind: 'action', action: { a: 'dodge' } },
  ControlRight: { kind: 'action', action: { a: 'dodge' } },
  AltLeft: { kind: 'action', action: { a: 'dodge' } },
  AltRight: { kind: 'action', action: { a: 'dodge' } },
  Space: { kind: 'action', action: { a: 'jump' } },
  Tab: { kind: 'ui', key: 'scoreboard' },
  KeyM: { kind: 'ui', key: 'map' },
  Enter: { kind: 'ui', key: 'chat' },
  NumpadEnter: { kind: 'ui', key: 'chat' },
  Escape: { kind: 'ui', key: 'menu' },
  KeyT: { kind: 'ui', key: 'quickchat' },
};

const MOVE_KEYS: Readonly<Record<string, [number, number]>> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/** Keys whose default browser behaviour must be suppressed while playing. */
const PREVENT = new Set(['Tab', 'Space', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyF', 'Slash']);

/**
 * Pure input state machine (no DOM): accumulates look deltas, key states and
 * edge actions, and produces InputFrames. Unit-tested in node.
 */
export class InputState {
  yaw = 0;
  pitch = 0;
  seq = 0;
  private lookDx = 0;
  private lookDy = 0;
  private readonly keys = new Set<string>();
  private readonly held = { fire: false, ads: false, sprint: false, interact: false, jump: false };
  private readonly touchHeld = { fire: false, ads: false, sprint: false, interact: false };
  private touchMove = { x: 0, z: 0 };
  private actions: InputAction[] = [];
  enabled = true;

  addLook(dx: number, dy: number): void {
    if (!this.enabled) return;
    this.lookDx += dx;
    this.lookDy += dy;
  }

  keyDown(code: string): void {
    if (!this.enabled) return;
    if (this.keys.has(code)) return; // auto-repeat
    this.keys.add(code);
    if (code === 'ShiftLeft' || code === 'ShiftRight') this.held.sprint = true;
    if (code === 'KeyF') this.held.interact = true;
    if (code === 'Space') this.held.jump = true;
    const b = KEY_MAP[code];
    if (b?.kind === 'action') this.pushAction(b.action);
  }

  keyUp(code: string): void {
    this.keys.delete(code);
    if (code === 'ShiftLeft' || code === 'ShiftRight') this.held.sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    if (code === 'KeyF') this.held.interact = false;
    if (code === 'Space') this.held.jump = false;
  }

  setMouseButton(btn: 'fire' | 'ads', down: boolean): void {
    if (!this.enabled && down) return;
    this.held[btn] = down;
  }

  setTouchHeld(btn: 'fire' | 'ads' | 'sprint' | 'interact', down: boolean): void {
    if (!this.enabled && down) return;
    this.touchHeld[btn] = down;
  }

  setTouchMove(x: number, z: number): void {
    this.touchMove = { x: clamp(x, -1, 1), z: clamp(z, -1, 1) };
  }

  pushAction(a: InputAction): void {
    if (!this.enabled) return;
    // de-duplicate identical edge actions queued within the same frame
    const key = JSON.stringify(a);
    if (this.actions.some((x) => JSON.stringify(x) === key)) return;
    this.actions.push(a);
  }

  /** Release everything (focus lost, chat opened...). */
  releaseAll(): void {
    this.keys.clear();
    this.held.fire = this.held.ads = this.held.sprint = this.held.interact = this.held.jump = false;
    this.touchHeld.fire = this.touchHeld.ads = this.touchHeld.sprint = this.touchHeld.interact = false;
    this.touchMove = { x: 0, z: 0 };
    this.lookDx = this.lookDy = 0;
  }

  isHeld(btn: 'fire' | 'ads'): boolean {
    return this.held[btn] || this.touchHeld[btn];
  }

  /** Movement intent from keys (normalised) or the touch stick. */
  movement(): { x: number; z: number } {
    let x = 0;
    let z = 0;
    for (const k of this.keys) {
      const m = MOVE_KEYS[k];
      if (m) {
        x += m[0];
        z += m[1];
      }
    }
    x = clamp(x, -1, 1);
    z = clamp(z, -1, 1);
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    if (x === 0 && z === 0) {
      x = this.touchMove.x;
      z = this.touchMove.z;
      const tl = Math.hypot(x, z);
      if (tl > 1) {
        x /= tl;
        z /= tl;
      }
    }
    return { x, z };
  }

  /**
   * Apply accumulated look deltas. `sens` = settings sensitivity multiplier
   * (already including the ADS factor), invertY flips vertical look.
   * Convention (core/math): yaw increases turning left; pitch > 0 looks up.
   */
  applyLook(sens: number, invertY: boolean): void {
    const k = LOOK_RAD_PER_PX * sens;
    this.yaw = wrapAngle(this.yaw - this.lookDx * k);
    this.pitch = clamp(this.pitch - this.lookDy * k * (invertY ? -1 : 1), -PITCH_CLAMP, PITCH_CLAMP);
    this.lookDx = 0;
    this.lookDy = 0;
  }

  /** Build the frame and clear the edge-action queue. */
  frame(aim?: { aimPoint: Vec3; aimTargetId?: EntityId }, viewTick?: number): InputFrame {
    const f = emptyInput(++this.seq);
    const m = this.movement();
    f.moveX = m.x;
    f.moveZ = m.z;
    f.yaw = this.yaw;
    f.pitch = this.pitch;
    let b = 0;
    if (this.held.fire || this.touchHeld.fire) b |= BTN_FIRE;
    if (this.held.ads || this.touchHeld.ads) b |= BTN_ADS;
    if (this.held.sprint || this.touchHeld.sprint) b |= BTN_SPRINT;
    if (this.held.jump) b |= BTN_JUMP;
    if (this.held.interact || this.touchHeld.interact) b |= BTN_INTERACT;
    f.buttons = this.enabled ? b : 0;
    f.actions = this.actions;
    this.actions = [];
    if (aim) {
      f.aimPoint = aim.aimPoint;
      if (aim.aimTargetId !== undefined) f.aimTargetId = aim.aimTargetId;
    }
    if (viewTick !== undefined) f.viewTick = viewTick;
    return f;
  }
}

const isEditable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
};

export interface InputControllerOptions {
  /** request pointer lock when the target is clicked (default true, desktop) */
  autoLock?: boolean;
}

export class InputController implements InputSink {
  readonly state = new InputState();
  private readonly target: HTMLElement;
  private readonly opts: InputControllerOptions;
  private touchMode = false;
  private locked = false;
  private readonly lockSubs = new Set<(locked: boolean) => void>();
  private readonly uiSubs = new Set<(key: UiKey, down: boolean) => void>();
  private readonly cleanup: (() => void)[] = [];
  private seededFromView = false;
  private disposed = false;
  private activeSlot = 0;

  constructor(target: HTMLElement, opts: InputControllerOptions = {}) {
    this.target = target;
    this.opts = { autoLock: true, ...opts };
    type AnyMap = WindowEventMap & DocumentEventMap;
    const on = <K extends keyof AnyMap>(el: Window | Document | HTMLElement, type: K, fn: (e: AnyMap[K]) => void, o?: AddEventListenerOptions): void => {
      el.addEventListener(type, fn as EventListener, o);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, o));
    };
    on(window, 'keydown', (e) => this.onKey(e, true));
    on(window, 'keyup', (e) => this.onKey(e, false));
    on(window, 'blur', () => this.state.releaseAll());
    on(document, 'visibilitychange', () => {
      if (document.hidden) this.state.releaseAll();
    });
    on(document, 'mousemove', (e) => {
      if (this.locked && !this.touchMode) this.state.addLook(e.movementX || 0, e.movementY || 0);
    });
    on(target, 'mousedown', (e) => {
      if (this.touchMode) return;
      if (!this.locked) {
        if (this.opts.autoLock && this.state.enabled) this.requestLock();
        return;
      }
      if (e.button === 0) this.state.setMouseButton('fire', true);
      else if (e.button === 2) this.state.setMouseButton('ads', true);
      else if (e.button === 1) {
        this.state.pushAction({ a: 'mark' });
        e.preventDefault();
      }
    });
    on(window, 'mouseup', (e) => {
      if (e.button === 0) this.state.setMouseButton('fire', false);
      else if (e.button === 2) this.state.setMouseButton('ads', false);
    });
    on(target, 'contextmenu', (e) => e.preventDefault());
    on(target, 'wheel', (e) => {
      if (!this.locked || !this.state.enabled) return;
      e.preventDefault();
      if (e.deltaY !== 0) this.state.pushAction({ a: 'weapon', slot: this.nextWeaponSlot() });
    }, { passive: false });
    on(document, 'pointerlockchange', () => {
      const now = document.pointerLockElement === this.target;
      if (now === this.locked) return;
      this.locked = now;
      if (!now) {
        this.state.setMouseButton('fire', false);
        this.state.setMouseButton('ads', false);
      }
      for (const cb of this.lockSubs) cb(now);
    });
    on(document, 'pointerlockerror', () => {
      for (const cb of this.lockSubs) cb(false);
    });
  }

  // ── pointer lock ─────────────────────────────────────────────────────────
  requestLock(): void {
    if (this.touchMode || this.disposed) return;
    try {
      const p = this.target.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    } catch {
      /* not allowed (no user gesture) */
    }
  }

  exitLock(): void {
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  isLocked(): boolean {
    return this.locked;
  }

  onLockChange(cb: (locked: boolean) => void): () => void {
    this.lockSubs.add(cb);
    return () => this.lockSubs.delete(cb);
  }

  onUiKey(cb: (key: UiKey, down: boolean) => void): () => void {
    this.uiSubs.add(cb);
    return () => this.uiSubs.delete(cb);
  }

  /** Disable gameplay input while chat / menus are open (held keys are released). */
  setEnabled(b: boolean): void {
    this.state.enabled = b;
    if (!b) this.state.releaseAll();
  }

  get enabled(): boolean {
    return this.state.enabled;
  }

  // ── InputSink (touch overlay) ────────────────────────────────────────────
  setMove(x: number, z: number): void {
    this.state.setTouchMove(x, z);
  }
  addLook(dx: number, dy: number): void {
    this.state.addLook(dx, dy);
  }
  setHeld(btn: 'fire' | 'ads' | 'sprint' | 'interact', down: boolean): void {
    this.state.setTouchHeld(btn, down);
  }
  pushAction(a: InputAction): void {
    this.state.pushAction(a);
  }
  setTouchMode(on: boolean): void {
    this.touchMode = on;
    if (on) this.exitLock();
  }

  /** Current look angles (for UI such as the compass). */
  get yaw(): number {
    return this.state.yaw;
  }
  get pitch(): number {
    return this.state.pitch;
  }

  /** Force the look angles (spawn / respawn / spectate handover). */
  setLook(yaw: number, pitch: number): void {
    this.state.yaw = wrapAngle(yaw);
    this.state.pitch = clamp(pitch, -PITCH_CLAMP, PITCH_CLAMP);
  }

  /** Build this frame's InputFrame. Call exactly once per rendered frame. */
  sample(renderer: InputRendererLike): InputFrame {
    // adopt the hero's facing the first time it exists (spawn orientation)
    const view = renderer.view;
    if (!this.seededFromView && view) {
      const id = view.localId();
      const ent = id !== null ? view.get(id) : undefined;
      if (ent) {
        this.setLook(ent.yaw, 0);
        this.seededFromView = true;
      }
    }
    this.activeSlot = view?.local()?.activeSlot ?? this.activeSlot;
    const s = settings.get();
    const ads = this.state.isHeld('ads');
    const zoom = renderer.adsZoom ?? 1;
    const sens = s.mouseSensitivity * (ads ? s.adsSensitivity / Math.max(1, zoom / 1.5) : 1);
    this.state.applyLook(sens, s.invertY);
    renderer.setLookAngles?.(this.state.yaw, this.state.pitch, ads, this.state.isHeld('fire') && this.state.enabled);
    const aim = renderer.pick();
    return this.state.frame(aim, view?.viewTick());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.exitLock();
    for (const c of this.cleanup) c();
    this.cleanup.length = 0;
    this.lockSubs.clear();
    this.uiSubs.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────
  /** Two weapon slots: any wheel step toggles primary ↔ secondary. */
  private nextWeaponSlot(): number {
    return this.activeSlot === 0 ? 1 : 0;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (this.disposed) return;
    if (isEditable(e.target)) return;
    const code = e.code;
    const b = KEY_MAP[code];
    if (b?.kind === 'ui') {
      if (!this.state.enabled) return;
      if (code === 'Tab') e.preventDefault();
      if (down && e.repeat) return;
      for (const cb of this.uiSubs) cb(b.key, down);
      return;
    }
    if (!this.state.enabled) return;
    if (PREVENT.has(code) || (e.ctrlKey && (code === 'KeyW' || code === 'KeyS' || code === 'KeyD'))) e.preventDefault();
    if (down) this.state.keyDown(code);
    else this.state.keyUp(code);
  }
}
