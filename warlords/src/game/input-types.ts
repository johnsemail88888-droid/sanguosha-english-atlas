// Contract between the input controller (RENDER owns src/game/input.ts) and the
// touch overlay (UI owns src/ui/touch*.ts). The overlay only talks to InputSink.
import type { InputAction } from '../core/types';

/**
 * Held buttons from touch UI. 'breath' holds the breath while aimed through a
 * scope (the 屏息 button; Shift on a keyboard) — separate from 'sprint', so the
 * stick's sprint edge never steadies (or unsteadies) a scope.
 */
export type HeldButton = 'fire' | 'ads' | 'sprint' | 'interact' | 'breath';

export interface InputSink {
  /** continuous virtual-stick movement, each in [-1, 1] (x = right, z = forward) */
  setMove(x: number, z: number): void;
  /** add look delta in pixels (same scale as mouse movement) */
  addLook(dx: number, dy: number): void;
  /** held buttons from touch UI */
  setHeld(btn: HeldButton, down: boolean): void;
  /** edge action (jump, dodge, reload, ability, item, command, ...) */
  pushAction(a: InputAction): void;
  /** true when touch mode is active (hide pointer-lock prompts) */
  setTouchMode(on: boolean): void;
  /** optional: gyro look (radians of yaw / pitch the phone turned; the controller applies the gyro setting) */
  addGyro?(dYaw: number, dPitch: number): void;
}
