// Contract between the input controller (RENDER owns src/game/input.ts) and the
// touch overlay (UI owns src/ui/touch*.ts). The overlay only talks to InputSink.
import type { InputAction } from '../core/types';

export interface InputSink {
  /** continuous virtual-stick movement, each in [-1, 1] (x = right, z = forward) */
  setMove(x: number, z: number): void;
  /** add look delta in pixels (same scale as mouse movement) */
  addLook(dx: number, dy: number): void;
  /** held buttons from touch UI */
  setHeld(btn: 'fire' | 'ads' | 'sprint' | 'interact', down: boolean): void;
  /** edge action (jump, dodge, reload, ability, item, command, ...) */
  pushAction(a: InputAction): void;
  /** true when touch mode is active (hide pointer-lock prompts) */
  setTouchMode(on: boolean): void;
}
