// Keyboard / mouse / touch → InputFrame (GAME_SPEC §10). One InputController
// per match view. The touch overlay (src/ui/touch*.ts) drives it through the
// InputSink methods. UI-only keys (Tab/M/Enter/Esc/T) are reported through
// onUiKey() instead of InputActions.
import type { AbilitySlot, EntityId, InputAction, InputFrame, RoleId, ViewEntity } from '../core/types';
import type { Vec3 } from '../core/math';
import { clamp, wrapAngle } from '../core/math';
import { BTN_ADS, BTN_FIRE, BTN_FIRST_PERSON, BTN_INTERACT, BTN_JUMP, BTN_SPRINT, BTN_ZOOM2, VF_AIRBORNE, VF_DANCING, VF_DOWNED, VF_STUNNED, emptyInput } from '../core/types';
import type { HeldButton, InputSink } from './input-types';
import { settings } from './settings';
import { CAMERA_TOGGLE_KEY, resolveCameraView, toggledCameraView, type CameraView } from '../render/camera/viewMode';
import { WEAPON_BY_ID } from '../data';
import { adsSensitivityMul, aimProfile } from '../data/weaponFeel';
import { AimFeel, type AimSnapshot } from './aimFeel';
import { heroAbility } from '../data/heroes';
import { skillAimed } from '../data/skillInfo';
import type { PreviewStatus } from '../render/vfx/skillPreview';
import { AimAssist, NO_ASSIST, type AssistResult } from './aimAssist';

/** Radians of yaw/pitch per pixel of mouse movement at sensitivity 1. */
export const LOOK_RAD_PER_PX = 0.0022;
export const PITCH_CLAMP = 1.45;

export type UiKey = 'scoreboard' | 'map' | 'chat' | 'menu' | 'quickchat';

/** What sample() needs from the renderer (GameRenderer satisfies it). */
export interface InputRendererLike {
  pick(): { aimPoint: Vec3; aimTargetId?: EntityId };
  setLookAngles?(yaw: number, pitch: number, ads?: boolean, fireHeld?: boolean, firstPerson?: boolean): void;
  /** the local aim this frame (zoom, scope overlay, viewmodel) — game/aimFeel.ts */
  setAim?(aim: Readonly<AimSnapshot>): void;
  /** the camera's unzoomed vertical FOV (settings.fov when absent) */
  readonly baseFov?: number;
  /** the skill whose key is held (its targeting preview), null for none; returns what releasing now would do */
  setSkillAim?(slot: AbilitySlot | null): PreviewStatus;
  /** the crosshair ray the host rebuilds (third person: from behind the shoulder; first: the eye) — aim assist */
  aimRay?(): { origin: Vec3; dir: Vec3 } | null;
  /** static geometry between two points (aim assist ignores targets behind walls) */
  lineBlocked?(a: Vec3, b: Vec3): boolean;
  readonly view?: {
    viewTick(): number;
    local(): {
      activeSlot: number;
      weapons: ({ id: string } | null)[];
      reloading?: number;
      heroId?: string;
      role?: RoleId;
      cooldowns?: Record<string, number>;
      charges?: Record<string, number>;
      downed?: boolean;
      dead?: boolean;
      statuses?: readonly { id: string; remaining: number }[];
      squad?: readonly { id: EntityId }[];
      knownAllies?: readonly EntityId[];
    } | null;
    localId(): EntityId | null;
    get(id: EntityId): { yaw: number; pitch: number; x?: number; z?: number; flags?: number; speed?: number } | undefined;
    entities?(): readonly ViewEntity[];
  };
}

/**
 * The held skill preview as the HUD reads it: which slot, and what releasing now would do
 * (valid, or why not: no target / too far …; the picked unit; how many the area catches).
 */
export interface SkillAimInfo extends PreviewStatus {
  slot: AbilitySlot;
}

/** Statuses that keep every skill from casting (the press is refused at once instead of previewing). */
const NO_CAST_STATUSES: ReadonlySet<string> = new Set(['silence', 'stun', 'dance']);

/**
 * Slots of this hero whose skills preview while held and cast on release: the aimed
 * skills (an area on the ground or a unit to pick, data/skillInfo.ts) that are ready.
 * A skill on cooldown (or a downed / dead / silenced / stunned hero) casts on press, so the
 * refusal shows at once.
 */
export function aimSlotsFor(local: { heroId?: string; role?: string; cooldowns?: Record<string, number>; charges?: Record<string, number>; downed?: boolean; dead?: boolean; statuses?: readonly { id: string }[] } | null): AbilitySlot[] {
  if (!local?.heroId || local.downed || local.dead) return [];
  if (local.statuses?.some((s) => NO_CAST_STATUSES.has(s.id))) return [];
  const out: AbilitySlot[] = [];
  for (const { slot, def } of aimedSkillsOf(local.heroId)) {
    // the lord skill works for the real Lord only (anyone else's G is refused on press)
    if (slot === 'lord' && local.role !== 'lord') continue;
    const ready = def.charges ? (local.charges?.[def.id] ?? def.charges) > 0 : !((local.cooldowns?.[def.id] ?? 0) > 0);
    if (ready) out.push(slot);
  }
  return out;
}

/** A hero's aimed skills by slot (asked every frame: computed once per hero). */
const aimedCache = new Map<string, { slot: AbilitySlot; def: NonNullable<ReturnType<typeof heroAbility>> }[]>();
function aimedSkillsOf(heroId: string): { slot: AbilitySlot; def: NonNullable<ReturnType<typeof heroAbility>> }[] {
  let list = aimedCache.get(heroId);
  if (!list) {
    list = [];
    for (const slot of ['q', 'e', 'lord'] as const) {
      const def = heroAbility(heroId, slot);
      if (def && skillAimed(def)) list.push({ slot, def });
    }
    aimedCache.set(heroId, list);
  }
  return list;
}

/** Statuses that lower the weapon (no aiming): the viewmodel's rule (render/camera/firstPerson.ts). */
const NO_AIM_STATUS = new Set(['disarm', 'stun', 'dance']);

/** Yaw (core/math convention: forward = (−sin yaw, −cos yaw)) that faces from `a` towards `b`. */
export function yawToward(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.atan2(-(b.x - a.x), -(b.z - a.z));
}

/**
 * One step of a timed turn: move `cur` towards `want` (shortest way round) so it
 * arrives exactly when `remaining` seconds have passed.
 */
export function easeYaw(cur: number, want: number, dt: number, remaining: number): number {
  const frac = remaining <= dt || remaining <= 0 ? 1 : Math.max(0, dt) / remaining;
  return wrapAngle(cur + wrapAngle(want - cur) * frac);
}

/** Seconds the camera takes to face the target after 张辽 突袭 (WEI-7). */
export const TUXI_TURN_SECONDS = 0.15;

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

/**
 * Discard chord (COMBAT-7): hold X and press 4–7 to drop that slot's card at your feet
 * (sim `{ a: 'drop', what: 'item' }`). X alone is still the squad "hold" order — it is
 * sent when X is released without a slot key having been pressed meanwhile.
 */
export const DISCARD_KEY = 'KeyX';

/** Item slot (0–3) of a slot key (4–7 / numpad 4–7), else null. */
export function itemSlotOfKey(code: string): number | null {
  const b = KEY_MAP[code];
  return b?.kind === 'action' && b.action.a === 'item' ? b.action.slot : null;
}

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

/** Game keys outside KEY_MAP / MOVE_KEYS whose browser default must not fire while playing. */
const EXTRA_GAME_KEYS = new Set(['ShiftLeft', 'ShiftRight', 'Slash', 'Quote', 'Backquote', CAMERA_TOGGLE_KEY]);

export interface KeyMods {
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Must the browser's default action for this key event be suppressed while
 * playing? Every bound game key (KEY_MAP, movement, sprint) and every chord
 * with Ctrl / Alt / Meta held: Ctrl and Alt are the dodge keys, so dodge +
 * reload (Ctrl+R) must not reload the page, Ctrl+F not open find, Ctrl+E /
 * Ctrl+G not move focus, Alt+D / Alt+F not open browser UI, Ctrl+4..7 not
 * switch tabs. (Ctrl+W / T / N cannot be blocked by a page; in fullscreen the
 * controller also takes the Keyboard Lock where the browser supports it.)
 */
export function shouldSuppressKey(code: string, mods: KeyMods): boolean {
  if (KEY_MAP[code] || MOVE_KEYS[code] || EXTRA_GAME_KEYS.has(code)) return true;
  return mods.ctrlKey || mods.altKey || mods.metaKey;
}

interface KeyboardLockApi {
  lock(codes?: string[]): Promise<void>;
  unlock(): void;
}
const keyboardLock = (): KeyboardLockApi | undefined =>
  typeof navigator !== 'undefined' ? (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard : undefined;

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
  private readonly held = { fire: false, ads: false, sprint: false, interact: false, jump: false, breath: false };
  private readonly touchHeld = { fire: false, ads: false, sprint: false, interact: false, breath: false };
  /**
   * A fire press seen since the last frame(): a click (or touch tap) that starts
   * and ends between two frames still fires once instead of vanishing.
   */
  private fireLatch = false;
  private touchMove = { x: 0, z: 0 };
  private actions: InputAction[] = [];
  /** a slot key was pressed while X was held: X's own order is not sent on release */
  private discardChord = false;
  /**
   * Skill slots that preview while their key is held and cast on release (aimed skills
   * that are ready — see InputController.sample). Others cast on press, as before.
   */
  private aimSlots: readonly AbilitySlot[] = [];
  /** the held skill key whose targeting preview is showing */
  private aim: { slot: AbilitySlot; code: string } | null = null;
  /**
   * Releasing the held skill now would do nothing (its preview finds no target in range —
   * InputController.sample sets it every frame): the release cancels instead of casting.
   */
  aimBlocked = false;
  /** held skills released while blocked (the HUD shakes the hint once for each) */
  aimRefusals = 0;
  enabled = true;
  /** the camera is first person: frames carry BTN_FIRST_PERSON (the host's crosshair / shots start at the eye) */
  firstPerson = false;
  /** aiming a weapon whose breath Shift holds: Shift must not sprint (frames drop BTN_SPRINT) */
  suppressSprint = false;
  /** a scope's second zoom step is up: frames carry BTN_ZOOM2 (other players' glint) */
  zoom2 = false;

  addLook(dx: number, dy: number): void {
    if (!this.enabled) return;
    this.lookDx += dx;
    this.lookDy += dy;
  }

  keyDown(code: string): void {
    if (!this.enabled) return;
    if (this.keys.has(code)) return; // auto-repeat
    this.keys.add(code);
    // Shift: sprint — or, aimed through a scope, hold the breath (never both: suppressSprint)
    if (code === 'ShiftLeft' || code === 'ShiftRight') this.held.sprint = this.held.breath = true;
    if (code === 'KeyF') this.held.interact = true;
    if (code === 'Space') this.held.jump = true;
    // X waits for its release (it may become the discard modifier); X + slot key drops that card
    if (code === DISCARD_KEY) {
      this.discardChord = false;
      return;
    }
    const slot = itemSlotOfKey(code);
    if (slot !== null && this.keys.has(DISCARD_KEY)) {
      this.discardChord = true;
      this.pushAction({ a: 'drop', slot, what: 'item' });
      return;
    }
    const b = KEY_MAP[code];
    // an aimed skill: show its preview while held, cast on release (another skill key switches the preview)
    if (b?.kind === 'action' && b.action.a === 'ability' && this.aimSlots.includes(b.action.slot)) {
      this.aim = { slot: b.action.slot, code };
      return;
    }
    if (b?.kind === 'action') this.pushAction(b.action);
  }

  keyUp(code: string): void {
    if (this.aim && this.aim.code === code) {
      const slot = this.aim.slot;
      this.aim = null;
      // nothing to cast it on: not sent (the sim would only refuse it); the hint says why
      if (this.aimBlocked) this.aimRefusals++;
      else this.pushAction({ a: 'ability', slot });
      this.aimBlocked = false;
    }
    if (code === DISCARD_KEY && this.keys.has(code) && !this.discardChord) {
      const b = KEY_MAP[code];
      if (b?.kind === 'action') this.pushAction(b.action);
    }
    if (code === DISCARD_KEY) this.discardChord = false;
    this.keys.delete(code);
    if (code === 'ShiftLeft' || code === 'ShiftRight') this.held.sprint = this.held.breath = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    if (code === 'KeyF') this.held.interact = false;
    if (code === 'Space') this.held.jump = false;
  }

  setMouseButton(btn: 'fire' | 'ads', down: boolean): void {
    if (!this.enabled && down) return;
    // right click while a skill preview shows cancels the skill (MOBA style) instead of aiming
    if (btn === 'ads' && down && this.aim) {
      this.aim = null;
      return;
    }
    if (btn === 'fire' && down) this.fireLatch = true;
    this.held[btn] = down;
  }

  /** Slots whose skill previews while held and casts on release (the rest cast on press). */
  setAimSlots(slots: readonly AbilitySlot[]): void {
    this.aimSlots = slots;
  }

  /** The skill whose targeting preview is showing (its key is held), else null. */
  aimingSlot(): AbilitySlot | null {
    return this.aim?.slot ?? null;
  }

  /** Drop the held skill preview without casting. */
  cancelAim(): void {
    this.aim = null;
  }

  setTouchHeld(btn: HeldButton, down: boolean): void {
    if (!this.enabled && down) return;
    if (btn === 'fire' && down) this.fireLatch = true;
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
    this.discardChord = false;
    // focus lost / menu opened mid-preview: the skill is not cast
    this.aim = null;
    this.held.fire = this.held.ads = this.held.sprint = this.held.interact = this.held.jump = this.held.breath = false;
    this.touchHeld.fire = this.touchHeld.ads = this.touchHeld.sprint = this.touchHeld.interact = this.touchHeld.breath = false;
    this.fireLatch = false;
    this.touchMove = { x: 0, z: 0 };
    this.lookDx = this.lookDy = 0;
  }

  isHeld(btn: 'fire' | 'ads' | 'sprint' | 'breath'): boolean {
    return this.held[btn] || this.touchHeld[btn];
  }

  /** Look input is waiting this frame (a mouse / finger moved): the aim assist's follow only helps an active aim. */
  hasLook(): boolean {
    return this.lookDx !== 0 || this.lookDy !== 0;
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
  applyLook(sens: number, invertY: boolean, pitchFilter?: (dPitch: number) => number): void {
    const k = LOOK_RAD_PER_PX * sens;
    this.yaw = wrapAngle(this.yaw - this.lookDx * k);
    // (a pull down first eats the recoil climb still outstanding: game/aimFeel.ts absorbPitch)
    let dp = -this.lookDy * k * (invertY ? -1 : 1);
    if (pitchFilter && dp !== 0) dp = pitchFilter(dp);
    this.pitch = clamp(this.pitch + dp, -PITCH_CLAMP, PITCH_CLAMP);
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
    if (this.held.fire || this.touchHeld.fire || this.fireLatch) b |= BTN_FIRE;
    this.fireLatch = false;
    if (this.held.ads || this.touchHeld.ads) b |= BTN_ADS;
    if ((this.held.sprint || this.touchHeld.sprint) && !this.suppressSprint) b |= BTN_SPRINT;
    if (this.held.jump) b |= BTN_JUMP;
    if (this.held.interact || this.touchHeld.interact) b |= BTN_INTERACT;
    if (this.zoom2 && b & BTN_ADS) b |= BTN_ZOOM2;
    f.buttons = (this.enabled ? b : 0) | (this.firstPerson ? BTN_FIRST_PERSON : 0);
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

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Quiet time (ms) that ends a wheel gesture (see WheelGesture). */
export const WHEEL_GESTURE_GAP_MS = 180;

/**
 * Mouse wheel → one weapon switch per gesture. A wheel notch is one event, but a
 * Mac trackpad / Magic Mouse swipe sends dozens of small deltas and then about a
 * second of momentum: switching on every event flipped between the two weapons
 * dozens of times and left a random one in hand. The first event of a gesture
 * switches; the rest of it (events less than WHEEL_GESTURE_GAP_MS apart) does not.
 */
export class WheelGesture {
  private last = -Infinity;

  /** A wheel event (vertical delta, time in ms): true when it should switch the weapon. */
  push(deltaY: number, t: number): boolean {
    if (deltaY === 0) return false;
    const fresh = t - this.last >= WHEEL_GESTURE_GAP_MS;
    this.last = t;
    return fresh;
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
  /** start in this view instead of the cameraView setting (dev harness / tests; the toggle key still flips it, unsaved) */
  view?: CameraView;
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
  /** forced view (options.view), flipped by the toggle key without touching the saved setting */
  private viewOverride: CameraView | null = null;
  /** timed turn towards an entity (张辽 突袭 lands behind the target: face it) */
  private turn: { targetId: EntityId; remaining: number; last: number } | null = null;
  private readonly wheel = new WheelGesture();
  /** the local aim: ADS progress, zoom steps, scope sway / hold breath (game/aimFeel.ts) */
  readonly aim = new AimFeel();
  /** touch aim assist (game/aimAssist.ts; never with a mouse) */
  readonly assist = new AimAssist();
  private lastSample = -1;
  /** last frame's held skill preview (HUD: tooltip + 「松开施放」 hint) */
  private skillAim: SkillAimInfo | null = null;
  /** the last held preview (what a refused release was missing) */
  private lastSkillAim: SkillAimInfo | null = null;
  private lastDt = 0;
  /** gyro look waiting to be applied (radians; ui/touch.ts feeds it while the setting allows) */
  private gyroYaw = 0;
  private gyroPitch = 0;

  constructor(target: HTMLElement, opts: InputControllerOptions = {}) {
    this.target = target;
    this.opts = { autoLock: true, ...opts };
    this.viewOverride = opts.view ?? null;
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
      if (!this.wheel.push(e.deltaY, now())) return;
      // looking through a scope with zoom steps: the wheel zooms (up = in) instead of switching weapons
      if (this.aim.cycleZoom(e.deltaY < 0 ? 1 : -1)) return;
      this.state.pushAction({ a: 'weapon', slot: this.nextWeaponSlot() });
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
    // fullscreen: take the Keyboard Lock (where supported) so even browser
    // shortcuts reach the game; released when leaving fullscreen / disposing
    on(document, 'fullscreenchange', () => this.syncKeyboardLock());
  }

  private keyboardLocked = false;
  private syncKeyboardLock(): void {
    const kb = keyboardLock();
    if (!kb) return;
    const want = !this.disposed && typeof document !== 'undefined' && !!document.fullscreenElement && !this.touchMode;
    if (want === this.keyboardLocked) return;
    this.keyboardLocked = want;
    try {
      if (want) void kb.lock().catch(() => (this.keyboardLocked = false));
      else kb.unlock();
    } catch {
      this.keyboardLocked = false;
    }
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
  setHeld(btn: HeldButton, down: boolean): void {
    this.state.setTouchHeld(btn, down);
  }
  addGyro(dYaw: number, dPitch: number): void {
    if (!this.state.enabled) return;
    this.gyroYaw += dYaw;
    this.gyroPitch += dPitch;
  }
  /** touch controls are active (the touch sensitivities, gentler recoil and aim assist apply) */
  get isTouch(): boolean {
    return this.touchMode;
  }
  pushAction(a: InputAction): void {
    this.state.pushAction(a);
  }
  setTouchMode(on: boolean): void {
    this.touchMode = on;
    if (on) this.exitLock();
  }

  /** The camera view in use: the setting ('auto': first person with mouse + keyboard, third on touch). */
  get view(): CameraView {
    return this.viewOverride ?? resolveCameraView(settings.get().cameraView, this.touchMode);
  }

  /** Flip first ↔ third person (the toggle key; saved in the settings). */
  toggleView(): void {
    if (this.viewOverride) this.viewOverride = this.viewOverride === 'first' ? 'third' : 'first';
    else settings.update({ cameraView: toggledCameraView(settings.get().cameraView, this.touchMode) });
  }

  /** Current look angles (for UI such as the compass). */
  get yaw(): number {
    return this.state.yaw;
  }
  get pitch(): number {
    return this.state.pitch;
  }

  /**
   * Force the look angles (spawn / respawn / spectate handover). An explicit
   * look also wins over the automatic "adopt the hero's facing on first
   * sight" seeding in sample().
   */
  setLook(yaw: number, pitch: number): void {
    this.state.yaw = wrapAngle(yaw);
    this.state.pitch = clamp(pitch, -PITCH_CLAMP, PITCH_CLAMP);
    this.seededFromView = true;
  }

  /** Ease the camera yaw towards an entity over `seconds` (mouse / touch look still adds on top). */
  turnToward(targetId: EntityId, seconds = TUXI_TURN_SECONDS): void {
    this.turn = { targetId, remaining: Math.max(0.01, seconds), last: now() };
  }

  /**
   * GameEvents of the local match (the renderer re-emits them): a successful
   * 张辽 突袭 of ours turns the view towards its target (WEI-7).
   */
  onEvents(evs: readonly { t: string; ability?: string; src?: EntityId; target?: EntityId; proc?: boolean }[], localId: EntityId | null): void {
    if (localId === null) return;
    for (const e of evs) {
      if (e.t === 'ability' && e.ability === 'zhangliao_tuxi' && e.src === localId && e.target !== undefined && !e.proc) this.turnToward(e.target);
    }
  }

  private advanceTurn(view: InputRendererLike['view']): void {
    const turn = this.turn;
    if (!turn) return;
    const t = now();
    const dt = Math.min(0.1, Math.max(0, (t - turn.last) / 1000));
    turn.last = t;
    const id = view?.localId();
    const me = id !== null && id !== undefined ? view?.get(id) : undefined;
    const tgt = view?.get(turn.targetId);
    if (!me || !tgt || me.x === undefined || me.z === undefined || tgt.x === undefined || tgt.z === undefined) {
      this.turn = null;
      return;
    }
    this.state.yaw = easeYaw(this.state.yaw, yawToward({ x: me.x, z: me.z }, { x: tgt.x, z: tgt.z }), dt, turn.remaining);
    turn.remaining -= dt;
    if (turn.remaining <= 1e-4) this.turn = null;
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
    this.advanceTurn(view);
    const s = settings.get();
    const ads = this.state.isHeld('ads');
    const aim = this.updateAim(view);
    // the climb a burst leaves behind (an auto settles back only 80–90 %): now part of the base look
    const res = this.aim.takeResidual();
    if (res.yaw !== 0 || res.pitch !== 0) {
      this.state.yaw = wrapAngle(this.state.yaw + res.yaw);
      this.state.pitch = clamp(this.state.pitch + res.pitch, -PITCH_CLAMP, PITCH_CLAMP);
    }
    // aiming: the look slows with the zoom actually on screen (every sight turns across the picture
    // as fast as the hip view; the relative ADS setting on top) — the touch sliders on touch
    const touch = this.touchMode;
    const baseSens = touch ? s.touchLook : s.mouseSensitivity;
    const rel = touch ? s.touchAds : s.adsSensitivity;
    const fov = renderer.baseFov ?? s.fov;
    const sens = baseSens * adsSensitivityMul(aim.zoom, fov, 1 + (rel - 1) * aim.blend, s.adsCoef);
    const assist = this.updateAssist(renderer, aim, touch, s.aimAssist);
    this.state.applyLook(sens * assist.slow, s.invertY, (dp) => this.aim.absorbPitch(dp));
    if (assist.yaw !== 0 || assist.pitch !== 0) {
      this.state.yaw = wrapAngle(this.state.yaw + assist.yaw);
      this.state.pitch = clamp(this.state.pitch + assist.pitch, -PITCH_CLAMP, PITCH_CLAMP);
    }
    this.applyGyro(aim, fov, s);
    this.state.firstPerson = this.view === 'first';
    // aimed with a weapon whose breath Shift holds: Shift never sprints then
    const def = aim.weaponId ? WEAPON_BY_ID[aim.weaponId] : undefined;
    this.state.suppressSprint = ads && aimProfile(def).holdBreath;
    this.state.zoom2 = aim.zoomIndex > 0 && aim.progress > 0;
    // the scope's breathing sway rides on the look angles the host gets: shots follow the reticle
    const yaw = wrapAngle(this.state.yaw + aim.swayYaw);
    const pitch = clamp(this.state.pitch + aim.swayPitch, -PITCH_CLAMP, PITCH_CLAMP);
    renderer.setLookAngles?.(yaw, pitch, ads, this.state.isHeld('fire') && this.state.enabled, this.state.firstPerson);
    renderer.setAim?.(aim);
    // aimed skills preview while their key is held (touch buttons still cast on tap)
    this.state.setAimSlots(this.touchMode ? [] : aimSlotsFor(view?.local() ?? null));
    const slot = this.state.aimingSlot();
    const status = renderer.setSkillAim?.(slot) ?? { valid: true };
    this.skillAim = slot ? { ...status, slot } : null;
    if (this.skillAim) this.lastSkillAim = this.skillAim;
    this.state.aimBlocked = !!slot && !status.valid;
    const f = this.state.frame(renderer.pick(), view?.viewTick());
    f.yaw = yaw;
    f.pitch = pitch;
    return f;
  }

  /** The aim assist this frame (touch only, and only with the setting on): slowdown + follow. */
  private updateAssist(renderer: InputRendererLike, aim: Readonly<AimSnapshot>, touch: boolean, level: 'off' | 'low' | 'standard'): AssistResult {
    const view = renderer.view;
    const ray = touch && level !== 'off' ? renderer.aimRay?.() : null;
    const id = view?.localId();
    if (!ray || !view?.entities || id === null || id === undefined || !this.state.enabled) {
      this.assist.reset();
      return NO_ASSIST;
    }
    const local = view.local();
    const def = aim.weaponId ? WEAPON_BY_ID[aim.weaponId] : undefined;
    const prof = aimProfile(def);
    const dir = ray.dir;
    return this.assist.update({
      device: 'touch',
      level,
      origin: ray.origin,
      yaw: Math.atan2(-dir.x, -dir.z),
      pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))),
      blend: aim.blend,
      scoped: (prof.overlay || prof.sight === 'marksman') && aim.blend > 0.5,
      active: this.state.hasLook() || this.state.movement().x !== 0 || this.state.movement().z !== 0,
      dt: this.lastDt,
      viewer: { id, role: local?.role, squad: local?.squad?.map((u) => u.id), knownAllies: local?.knownAllies },
      entities: view.entities(),
      blocked: renderer.lineBlocked ? (a, b) => renderer.lineBlocked!(a, b) : undefined,
    });
  }

  /** Gyro look (touch): only while aimed through a scope / sight unless set to always; scaled like the ADS look. */
  private applyGyro(aim: Readonly<AimSnapshot>, fov: number, s: ReturnType<typeof settings.get>): void {
    const gy = this.gyroYaw;
    const gp = this.gyroPitch;
    this.gyroYaw = this.gyroPitch = 0;
    if (!this.touchMode || s.gyro === 'off' || (gy === 0 && gp === 0)) return;
    if (s.gyro === 'scoped' && aim.blend < 0.5) return;
    const k = s.gyroGain * adsSensitivityMul(aim.zoom, fov, 1, s.adsCoef);
    this.state.yaw = wrapAngle(this.state.yaw + gy * k);
    this.state.pitch = clamp(this.state.pitch + gp * k, -PITCH_CLAMP, PITCH_CLAMP);
  }

  /** The local aim this frame (see game/aimFeel.ts). */
  aimSnapshot(): Readonly<AimSnapshot> {
    return this.aim.snapshot;
  }

  private updateAim(view: InputRendererLike['view']): Readonly<AimSnapshot> {
    const t = now();
    const dt = this.lastSample < 0 ? 0 : Math.min(0.1, Math.max(0, (t - this.lastSample) / 1000));
    this.lastSample = t;
    this.lastDt = dt;
    const local = view?.local() ?? null;
    const id = view?.localId();
    const ent = id !== null && id !== undefined ? view?.get(id) : undefined;
    const flags = ent?.flags ?? 0;
    let lowered = !!local?.downed || (flags & (VF_DOWNED | VF_STUNNED | VF_DANCING)) !== 0 || (local?.reloading ?? 0) > 0;
    for (const st of local?.statuses ?? []) if (st.remaining > 0 && NO_AIM_STATUS.has(st.id)) lowered = true;
    return this.aim.update(dt, {
      weaponId: local?.weapons[local.activeSlot]?.id ?? null,
      ads: this.state.isHeld('ads') && this.state.enabled,
      blocked: lowered,
      // the breath key: Shift on a keyboard, the 屏息 button on touch (never the stick's sprint edge)
      hold: this.state.isHeld('breath') && this.state.enabled,
      moving: (ent?.speed ?? 0) > 1,
      speed: ent?.speed ?? 0,
      airborne: (flags & VF_AIRBORNE) !== 0,
      firstPerson: this.view === 'first',
      touch: this.touchMode,
    });
  }

  /** The skill preview showing (its key held) and what releasing now would do; null for none. */
  aimingInfo(): SkillAimInfo | null {
    return this.skillAim;
  }

  /** Held skills released with nothing to cast on (not sent), and what the last preview said. */
  aimRefusal(): { n: number; info: SkillAimInfo | null } {
    return { n: this.state.aimRefusals, info: this.lastSkillAim };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.syncKeyboardLock();
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
    if (!this.state.enabled) {
      // menus / chat open: keep browser keys working, but a held key must still be released
      if (!down) this.state.keyUp(e.code);
      return;
    }
    const code = e.code;
    if (shouldSuppressKey(code, e)) e.preventDefault();
    if (code === CAMERA_TOGGLE_KEY) {
      if (down && !e.repeat) this.toggleView();
      return;
    }
    const b = KEY_MAP[code];
    if (b?.kind === 'ui') {
      if (down && e.repeat) return;
      for (const cb of this.uiSubs) cb(b.key, down);
      return;
    }
    if (down) this.state.keyDown(code);
    else this.state.keyUp(code);
  }
}
